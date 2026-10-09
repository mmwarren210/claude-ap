import { createHash } from 'node:crypto';
import type { PlayableDirection, Sport } from '@crowniq/contracts';
import { normalizePrizePicksMarketKey } from '../prizepicks-line-types.js';
import { leagueInfo } from './markets.js';
import type { DfsApp, ReadResult, ScrapedLine, ScrapedTier, ScraperSource } from './scraped-line.js';

// PropLine (owner, 2026-10-08: CrownIQ's line and odds source, Streaming Lite plan, 250,000 requests a day). This file is the
// PrizePicks board from PropLine for every sport it carries: each sport's prop markets are discovered from its events every
// few hours, then each refresh pulls the whole slate per sport in a few bulk requests, PrizePicks only. The key stays on
// the server (PROPLINE_API_KEY, sent as X-API-Key).

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);

/** PropLine sport keys to the PrizePicks league labels CrownIQ's line store and models already use. */
export function proplineLeague(sportKey: string): string {
  const fixed: Readonly<Record<string, string>> = { football_nfl: 'NFL', football_ncaaf: 'CFB', basketball_nba: 'NBA',
    basketball_wnba: 'WNBA', basketball_ncaab: 'CBB', baseball_mlb: 'MLB', hockey_nhl: 'NHL', tennis: 'TENNIS', mma_ufc: 'UFC',
    boxing: 'BOXING', golf: 'PGA', table_tennis: 'TT', darts: 'DARTS', cricket: 'CRICKET', aussie_rules_afl: 'AFL',
    football_cfl: 'CFL', esports: 'ESPORTS', baseball_ncaa: 'NCAA BASEBALL', badminton: 'BAD' };
  if (fixed[sportKey]) return fixed[sportKey]!;
  if (sportKey.startsWith('soccer_')) return 'SOCCER';
  return sportKey.toUpperCase().replace(/_/g, ' ');
}

/** Player-prop market keys (game lines, team markets and yes/no scorer markets are left out). */
export const isPropMarket = (key: string) => /^(player|batter|pitcher|goalie|golfer|fighter)_/.test(key) &&
  !/_(1st|first|last|anytime|2plus|3plus)_td$|_(1st|first|last|anytime)_(td|goal|goalscorer|scorer)$/.test(key);

/** A readable label for a market key ("player_pass_yds" → "Pass Yds"). */
export const marketLabel = (key: string) => key.replace(/^(player|batter|pitcher|goalie|golfer|fighter)_/, '')
  .split('_').map((word) => word ? word[0]!.toUpperCase() + word.slice(1) : word).join(' ');

interface Outcome { name?: string; description?: string | null; point?: number | null; dfs_odds_type?: string | null;
  payout_multiplier?: number | string | null; player_id?: string | null }
interface Event { id: string | number; sport_key?: string; home_team?: string | null; away_team?: string | null; commence_time?: string;
  bookmakers?: { key: string; markets?: { key: string; outcomes?: Outcome[] }[] }[] }

/** A small PropLine client: the server's key, bounded concurrency, and Retry-After on 429/503. */
export class PropLineClient {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  requests = 0;
  remaining: number | null = null;
  constructor(private readonly key: string, private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
    private readonly concurrency = 8, private readonly baseUrl = 'https://api.prop-line.com',
    private readonly sleep = (ms: number) => new Promise<void>((done) => { const timer = setTimeout(done, ms); timer.unref?.(); })) {}

  private discovered: { at: number; markets: Map<string, string[]> } | null = null;
  private discovering: Promise<Map<string, string[]>> | null = null;
  /**
   * Each active sport's player-prop market keys, from its events in the next few days; shared by every PropLine source and
   * re-learned every 6 hours. A sport whose events can't be listed is named in `failed`.
   */
  async propMarkets(failed: string[], clock: () => Date = () => new Date(), horizonDays = 4, everyMs = 6 * 3600_000): Promise<Map<string, string[]>> {
    const now = clock().getTime();
    if (this.discovered && now - this.discovered.at < everyMs) return this.discovered.markets;
    this.discovering ??= (async () => {
      const sports = list<{ key: string; active?: boolean }>(await this.get('/v1/sports')).filter((sport) => sport.active !== false);
      const horizon = now + horizonDays * 86_400_000;
      const markets = new Map<string, string[]>();
      await Promise.all(sports.map(async (sport) => {
        try {
          const events = list<Event>(await this.get(`/v1/sports/${sport.key}/events`))
            .filter((event) => { const start = Date.parse(event.commence_time ?? ''); return start > now && start < horizon; });
          const keys = new Set<string>();
          await Promise.all(events.map(async (event) => {
            try { for (const market of list<{ key: string }>(await this.get(`/v1/sports/${sport.key}/events/${event.id}/markets`)))
              if (isPropMarket(market.key)) keys.add(market.key); }
            catch { /* one event's market list; the sport still counts */ }
          }));
          if (keys.size) markets.set(sport.key, [...keys].sort());
        } catch { failed.push(`${sport.key}:events`); }
      }));
      this.discovered = { at: now, markets };
      return markets;
    })().finally(() => { this.discovering = null; });
    return this.discovering;
  }

  async get<T>(path: string): Promise<T> {
    while (this.active >= this.concurrency) await new Promise<void>((done) => this.waiting.push(done));
    this.active++;
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await this.fetchFn(`${this.baseUrl}${path}`, { headers: { 'X-API-Key': this.key, accept: 'application/json' },
          signal: AbortSignal.timeout(60_000) });
        this.requests++;
        const left = Number(response.headers.get('x-daily-remaining'));
        if (Number.isFinite(left) && response.headers.get('x-daily-remaining') !== null) this.remaining = left;
        if ((response.status === 429 || response.status === 503) && attempt < 3) {
          await response.body?.cancel().catch(() => undefined);
          await this.sleep(Math.min(60, Number(response.headers.get('retry-after')) || 2 ** attempt) * 1000);
          continue;
        }
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`PROPLINE_HTTP_${response.status}`); }
        return await response.json() as T;
      }
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const list = <T>(body: unknown): T[] => Array.isArray(body) ? body as T[]
  : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: T[] }).data : [];

export interface PropLineReport { at: string; sports: number; events: number; requests: number; failed: string[];
  lines: number; byLeague: Record<string, number>; byTier: Record<string, number>; dropped: Record<string, number>; remaining: number | null }

/**
 * One app's board from PropLine (PrizePicks first; Underdog and Pick6 use the same source later). Market discovery is cached
 * for `discoverEveryMs`; each run then costs about one request per sport per 30 markets.
 */
export function propLineBoard(client: PropLineClient, options: { app: DfsApp; bookmaker: string; discoverEveryMs?: number;
  horizonDays?: number; clock?: () => Date; onReport?: (report: PropLineReport) => void }): ScraperSource {
  const clock = options.clock ?? (() => new Date());
  const discover = (failed: string[]) => client.propMarkets(failed, clock, options.horizonDays, options.discoverEveryMs);
  return {
    id: `propline-${options.app}`, actor: null, apps: [options.app], rowCap: null, input: () => ({}),
    async run() {
      const failed: string[] = [], before = client.requests;
      const markets = await discover(failed);
      const rows: ScrapedLine[] = [];
      const dropped: Record<string, number> = {};
      const drop = (reason: string) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
      let events = 0;
      await Promise.all([...markets].map(async ([sportKey, keys]) => {
        const league = proplineLeague(sportKey), sport = leagueInfo(league).sport;
        for (let index = 0; index < keys.length; index += 30) {
          const chunk = keys.slice(index, index + 30);
          let slate: Event[];
          try { slate = list<Event>(await client.get(`/v1/sports/${sportKey}/odds?markets=${chunk.join(',')}&bookmakers=${options.bookmaker}`)); }
          catch { failed.push(`${sportKey}:${index / 30}`); continue; }
          events += index === 0 ? slate.length : 0;
          for (const event of slate) rows.push(...eventLines(event, league, sport, options, drop));
        }
      }));
      const byLeague: Record<string, number> = {}, byTier: Record<string, number> = {};
      for (const row of rows) { byLeague[row.league] = (byLeague[row.league] ?? 0) + 1; byTier[row.tier] = (byTier[row.tier] ?? 0) + 1; }
      const report = { at: clock().toISOString(), sports: markets.size, events, requests: client.requests - before, failed, lines: rows.length,
        byLeague, byTier, dropped, remaining: client.remaining };
      console.log(`[propline-${options.app}] ${JSON.stringify(report)}`);
      options.onReport?.(report);
      // Only a pull with no failed request can take lines down.
      return { rows, complete: failed.length === 0 && rows.length > 0 };
    },
    read(row: unknown, now: Date): ReadResult {
      const line = row as ScrapedLine;
      return Date.parse(line.startTime) <= now.getTime() ? { skip: 'LIVE_OR_STARTED' } : { line };
    },
  };
}

const tiers: Readonly<Record<string, ScrapedTier>> = { standard: 'REGULAR', goblin: 'GOBLIN', demon: 'DEMON' };
/** Pick6's alternate numbers are ordinary picks at their own number (no Goblin/Demon on Pick6). */
const pick6Tiers: Readonly<Record<string, ScrapedTier>> = { standard: 'REGULAR', alternate: 'REGULAR' };

/** One event's lines for the app: each player, market, tier and number once, with the sides the app really offers. */
export function eventLines(event: Event, league: string, sport: Sport, options: { app: DfsApp; bookmaker: string },
  drop: (reason: string) => void = () => undefined): ScrapedLine[] {
  const startTime = event.commence_time && !Number.isNaN(Date.parse(event.commence_time)) ? new Date(event.commence_time).toISOString() : null;
  if (!startTime) { drop('NO_START'); return []; }
  const book = event.bookmakers?.find((item) => item.key === options.bookmaker);
  const grouped = new Map<string, { player: string; market: string; tier: ScrapedTier; point: number; sides: Set<PlayableDirection>;
    multiplier: number | null }>();
  for (const market of book?.markets ?? []) {
    for (const outcome of market.outcomes ?? []) {
      const player = outcome.description?.trim();
      if (!player || typeof outcome.point !== 'number' || !Number.isFinite(outcome.point)) { drop('NO_PLAYER_OR_LINE'); continue; }
      const side: PlayableDirection | null = outcome.name === 'Over' ? 'MORE' : outcome.name === 'Under' ? 'LESS' : null;
      if (!side) { drop('NOT_OVER_UNDER'); continue; }
      // PrizePicks tags every line; other apps' lines are regular unless tagged.
      const flavor = (outcome.dfs_odds_type ?? 'standard').toLowerCase();
      const tier = (options.app === 'pick6' ? pick6Tiers : tiers)[flavor];
      if (!tier) { drop(`TIER_${flavor.toUpperCase()}`); continue; }
      // Goblins and Demons are MORE-only on PrizePicks: an "Under" on one is not a pick that exists.
      if (tier !== 'REGULAR' && side === 'LESS') { drop('ALTERNATE_UNDER'); continue; }
      const key = JSON.stringify([player.toLowerCase(), market.key, tier, outcome.point]);
      const multiplier = Number(outcome.payout_multiplier);
      const entry = grouped.get(key) ?? { player, market: market.key, tier, point: outcome.point, sides: new Set(),
        multiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : null };
      entry.sides.add(side);
      grouped.set(key, entry);
    }
  }
  const home = event.home_team?.trim() || null, away = event.away_team?.trim() || null;
  return [...grouped.values()].map((entry) => ({
    app: options.app,
    appLineId: `pl-${hash(JSON.stringify([event.id, entry.player.toLowerCase(), entry.market, entry.tier, entry.point]))}`,
    league, gameId: `propline:${event.id}`, player: entry.player, team: null, teamName: null, opponent: null,
    stat: marketLabel(entry.market), marketKey: normalizePrizePicksMarketKey(sport, entry.market), line: entry.point, tier: entry.tier,
    directions: [...entry.sides].sort((a, b) => a === 'MORE' ? -1 : b === 'MORE' ? 1 : 0), startTime, imageUrl: null,
    home: home ? { abbreviation: home, name: home } : null, away: away ? { abbreviation: away, name: away } : null,
    ...(entry.multiplier && entry.tier !== 'REGULAR' ? { multipliers: { MORE: entry.multiplier } } : {}),
  }));
}
