import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Sport } from '@crowniq/contracts';
import { normalizedName } from './match.js';

// Sportsbook player-prop prices (DraftKings, Hard Rock) from SharpAPI, used as reference odds and for CrownIQ's own +EV.
// Reference only: nothing here feeds GKR scoring.

const API = 'https://api.sharpapi.io/api/v1';
const soccerLeagues = ['england_-_premier_league', 'spain_-_la_liga', 'uefa_-_champions_league', 'germany_-_bundesliga',
  'italy_-_serie_a', 'france_-_ligue_1', 'usa_-_major_league_soccer', 'uefa_-_europa_league'];
const leagueSports: Readonly<Record<string, Sport>> = { nfl: 'NFL', ncaaf: 'NCAAFB', mlb: 'MLB', nba: 'NBA', wnba: 'WNBA',
  nhl: 'NHL', atp: 'TENNIS', wta: 'TENNIS', ...Object.fromEntries(soccerLeagues.map((league) => [league, 'SOCCER' as Sport])) };
/** Every league pulled by default: player props for the ones CrownIQ covers, game lines for all of them. */
export const sharpLeagues: readonly string[] = ['nfl', 'ncaaf', 'mlb', 'nba', 'wnba', 'nhl', 'atp', 'wta', ...soccerLeagues];
/** Leagues with game lines only (Kalshi and the books price the games; CrownIQ has no player boards for them). */
export const gameOnlyLeagues: readonly string[] = ['ncaab', 'ufc'];

const basketball: Readonly<Record<string, string>> = { player_points: 'player_points', player_rebounds: 'player_rebounds',
  player_assists: 'player_assists', player_made_threes: 'player_threes',
  'player_points_+_rebounds_+_assists': 'player_points_rebounds_assists', 'player_points_+_rebounds': 'player_points_rebounds',
  'player_points_+_assists': 'player_points_assists', 'player_rebounds_+_assists': 'player_rebounds_assists' };
/** SharpAPI market types to CrownIQ market keys. Only exact, unambiguous matches; anything else is left out. */
const marketKeys: Readonly<Partial<Record<Sport, Readonly<Record<string, string>>>>> = {
  NFL: { player_passing_yards: 'passing_yards', player_passing_attempts: 'player_pass_attempts',
    player_passing_completions: 'player_pass_completions', player_passing_touchdowns: 'player_pass_tds',
    player_rushing_yards: 'player_rush_yds', player_rushing_attempts: 'player_rush_attempts',
    player_receiving_yards: 'player_reception_yds', player_receptions: 'player_receptions',
    player_kicking_points: 'player_kicking_points', player_sacks: 'player_sacks',
    'player_tackles_+_assists': 'player_tackles_assists', 'player_passing_+_rushing_yards': 'pass_plus_rush_yds',
    'player_rushing_+_receiving_yards': 'rush_plus_rec_yds' },
  NCAAFB: { player_passing_yards: 'passing_yards', player_rushing_yards: 'player_rush_yds',
    player_receiving_yards: 'player_reception_yds' },
  MLB: { player_hits: 'batter_hits', 'player_hits_+_runs_+_rbis': 'batter_hits_runs_rbis', player_home_runs: 'batter_home_runs',
    player_total_bases: 'batter_total_bases', player_walks: 'batter_walks', player_rbis: 'rbis', player_runs: 'runs',
    player_strikeouts: 'pitcher_strikeouts', player_singles: 'singles', player_doubles: 'doubles',
    player_stolen_bases: 'stolen_bases', player_hits_allowed: 'hits_allowed', player_earned_runs: 'earned_runs',
    player_walks_allowed: 'walks_allowed', player_pitching_outs: 'pitching_outs' },
  NBA: basketball, WNBA: basketball,
  NHL: { player_shots_on_goal: 'shots_on_goal', player_points: 'points', player_saves: 'saves', player_assists: 'assists',
    player_goals: 'goals', player_blocked_shots: 'blocked_shots', player_power_play_points: 'power_play_points' },
  TENNIS: { player_total_games: 'total_games', player_games_won: 'games_won', player_aces: 'aces',
    player_double_faults: 'double_faults' },
  SOCCER: { player_shots: 'shots', player_shots_on_target: 'sot', player_assists: 'assists', player_goals: 'goals',
    player_fouls: 'fouls', player_saves: 'goalie_saves' },
};

/** One book's de-vigged price for one player, stat and number. */
export interface FairPrice {
  readonly book: string; readonly sport: Sport; readonly player: string; readonly market: string; readonly line: number;
  /** The book's no-vig chance the stat goes over the number, 0–1. */
  readonly fairOver: number;
  readonly overAmerican: number | null; readonly underAmerican: number | null;
  readonly startTime: string; readonly home: string | null; readonly away: string | null;
}

interface Row {
  sportsbook?: unknown; league?: unknown; market_type?: unknown; selection_type?: unknown; line?: unknown;
  odds_probability?: unknown; odds_american?: unknown; player_name?: unknown; event_start_time?: unknown;
  home_team?: unknown; away_team?: unknown; is_live?: unknown; is_active?: unknown; event_id?: unknown;
}

/** Pairs each book's Over and Under at the same number and removes the vig: fair over = p(over) / (p(over) + p(under)). */
export function fairPrices(rows: readonly unknown[]): FairPrice[] {
  const pairs = new Map<string, { over?: Row; under?: Row }>();
  for (const value of rows) {
    const row = value as Row;
    const sport = leagueSports[String(row.league)], market = sport ? marketKeys[sport]?.[String(row.market_type)] : undefined;
    if (!sport || !market || row.is_live === true || row.is_active === false || typeof row.line !== 'number' ||
      typeof row.player_name !== 'string' || (row.selection_type !== 'over' && row.selection_type !== 'under')) continue;
    const key = JSON.stringify([row.sportsbook, row.event_id, normalizedName(row.player_name), market, row.line]);
    const pair = pairs.get(key) ?? {};
    pair[row.selection_type] = row;
    pairs.set(key, pair);
  }
  const prices: FairPrice[] = [];
  for (const { over, under } of pairs.values()) {
    const pOver = Number(over?.odds_probability), pUnder = Number(under?.odds_probability);
    if (!over || !under || !(pOver > 0) || !(pUnder > 0) || pOver + pUnder < 0.95) continue;
    const sport = leagueSports[String(over.league)]!;
    prices.push({ book: String(over.sportsbook), sport, player: String(over.player_name), market: marketKeys[sport]![String(over.market_type)]!,
      line: over.line as number, fairOver: Math.round(pOver / (pOver + pUnder) * 10_000) / 10_000,
      overAmerican: typeof over.odds_american === 'number' ? over.odds_american : null,
      underAmerican: typeof under.odds_american === 'number' ? under.odds_american : null,
      startTime: String(over.event_start_time), home: typeof over.home_team === 'string' ? over.home_team : null,
      away: typeof over.away_team === 'string' ? over.away_team : null });
  }
  return prices;
}

/** A one-sided price (Kalshi's player props sell "Yes" on the over only): the price is the chance it implies. */
export interface OverOnlyPrice {
  readonly book: string; readonly sport: Sport; readonly player: string; readonly market: string; readonly line: number;
  readonly price: number; readonly american: number | null; readonly startTime: string;
  readonly home: string | null; readonly away: string | null;
}
/** One side of a full-game line (winner, spread or total) from a book or exchange. */
export interface GamePrice {
  readonly book: string; readonly league: string; readonly sport: string; readonly eventId: string;
  readonly home: string; readonly away: string; readonly startTime: string;
  readonly market: 'moneyline' | 'spread' | 'total'; readonly line: number | null;
  readonly side: 'home' | 'away' | 'over' | 'under'; readonly probability: number; readonly american: number | null;
}

const gameMarkets: Readonly<Record<string, GamePrice['market']>> = { moneyline: 'moneyline', point_spread: 'spread',
  total_points: 'total', total_runs: 'total', total_goals: 'total', total_games: 'total' };
export const gameMarketTypes = Object.keys(gameMarkets);

/** Over-only player props (no under to remove the cut from), from the books that sell them that way. */
export function overOnlyPrices(rows: readonly unknown[], books: readonly string[] = ['kalshi']): OverOnlyPrice[] {
  const out: OverOnlyPrice[] = [];
  for (const value of rows) {
    const row = value as Row;
    const sport = leagueSports[String(row.league)], market = sport ? marketKeys[sport]?.[String(row.market_type)] : undefined;
    const price = Number(row.odds_probability);
    if (!sport || !market || !books.includes(String(row.sportsbook)) || row.selection_type !== 'over' || row.is_live === true ||
      row.is_active === false || typeof row.line !== 'number' || typeof row.player_name !== 'string' || !(price > 0 && price < 1)) continue;
    out.push({ book: String(row.sportsbook), sport, player: row.player_name, market, line: row.line, price,
      american: typeof row.odds_american === 'number' ? row.odds_american : null, startTime: String(row.event_start_time),
      home: typeof row.home_team === 'string' ? row.home_team : null, away: typeof row.away_team === 'string' ? row.away_team : null });
  }
  return out;
}

/** Full-game winner, spread and total sides (no halves, quarters or 3-way lines). */
export function gamePrices(rows: readonly unknown[]): GamePrice[] {
  const out: GamePrice[] = [];
  for (const value of rows) {
    const row = value as Row & { sport?: unknown; selection_type?: unknown };
    const market = gameMarkets[String(row.market_type)], side = String(row.selection_type), probability = Number(row.odds_probability);
    if (!market || row.is_live === true || row.is_active === false || !(probability > 0 && probability < 1) ||
      typeof row.home_team !== 'string' || typeof row.away_team !== 'string') continue;
    if (market === 'total' ? side !== 'over' && side !== 'under' : side !== 'home' && side !== 'away') continue;
    if (market !== 'moneyline' && typeof row.line !== 'number') continue;
    // Soccer winners have a draw: a two-way fair price would be wrong, so they're left out (spreads and totals stay).
    if (market === 'moneyline' && String(row.sport) === 'soccer') continue;
    out.push({ book: String(row.sportsbook), league: String(row.league), sport: String(row.sport ?? ''), eventId: String(row.event_id),
      home: row.home_team, away: row.away_team, startTime: String(row.event_start_time), market,
      line: market === 'moneyline' ? null : row.line as number, side: side as GamePrice['side'], probability,
      american: typeof row.odds_american === 'number' ? row.odds_american : null });
  }
  return out;
}

export interface SharpPropsStatus {
  readonly configured: boolean; readonly fetchedAt: string | null; readonly prices: number;
  readonly lastError: string | null; readonly requests: number;
  readonly overOnly?: number; readonly games?: number;
}

/**
 * Keeps the latest DraftKings and Hard Rock player-prop prices from SharpAPI, refreshed on an interval and saved to disk.
 * A failed refresh keeps the previous prices.
 */
export class SharpPropsFeed {
  private prices: FairPrice[] = [];
  private overOnly: OverOnlyPrice[] = [];
  private games: GamePrice[] = [];
  private fetchedAt: string | null = null;
  private lastError: string | null = null;
  private requests = 0;
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SharpPropsStatus> | null = null;
  private onRefreshed: ((prices: readonly FairPrice[], at: Date) => unknown) | null = null;
  constructor(private readonly apiKey: string | null, private readonly file: string | null,
    private readonly options: { books?: readonly string[]; leagues?: readonly string[]; maxPagesPerLeague?: number;
      /** Pause between requests; SharpAPI's Hobby plan allows 120 a minute. */
      requestGapMs?: number } = {},
    private readonly fetchFn: typeof fetch = fetch, private readonly clock: () => Date = () => new Date()) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { fetchedAt: string; prices: FairPrice[];
        overOnly?: OverOnlyPrice[]; games?: GamePrice[] };
      this.prices = saved.prices; this.fetchedAt = saved.fetchedAt; this.overOnly = saved.overOnly ?? []; this.games = saved.games ?? [];
    } catch { /* first run */ }
  }

  /** Called after each successful refresh (the server keeps a history of the books' view of the board). */
  whenRefreshed(callback: (prices: readonly FairPrice[], at: Date) => unknown): void { this.onRefreshed = callback; }

  async current(): Promise<{ fetchedAt: string | null; prices: FairPrice[] }> {
    await this.load();
    return { fetchedAt: this.fetchedAt, prices: this.prices };
  }

  /** Kalshi's over-only player props and every book's full-game lines, from the same refresh. */
  async extras(): Promise<{ fetchedAt: string | null; overOnly: OverOnlyPrice[]; games: GamePrice[] }> {
    await this.load();
    return { fetchedAt: this.fetchedAt, overOnly: this.overOnly, games: this.games };
  }

  async status(): Promise<SharpPropsStatus> {
    await this.load();
    return { configured: !!this.apiKey, fetchedAt: this.fetchedAt, prices: this.prices.length, lastError: this.lastError,
      requests: this.requests, overOnly: this.overOnly.length, games: this.games.length };
  }

  /** One refresh at a time: a second call waits for the running one instead of doubling the requests. */
  refresh(): Promise<SharpPropsStatus> {
    this.running ??= this.refreshNow().finally(() => { this.running = null; });
    return this.running;
  }

  private async refreshNow(): Promise<SharpPropsStatus> {
    await this.load();
    if (!this.apiKey) { this.lastError = 'SHARPAPI_KEY_MISSING'; return this.status(); }
    const rows: unknown[] = [], gameRows: unknown[] = [];
    const books = this.options.books ?? ['draftkings', 'hardrock', 'kalshi'];
    // Player props for the leagues CrownIQ covers, then full-game lines (winner, spread, total) for every league.
    const jobs = [...(this.options.leagues ?? sharpLeagues).map((league) => ({ league, props: true })),
      ...[...(this.options.leagues ?? sharpLeagues), ...(this.options.leagues ? [] : gameOnlyLeagues)].map((league) => ({ league, props: false }))];
    try {
      for (const { league, props } of jobs) {
        let cursor: string | null = null;
        for (let page = 0; page < (props ? this.options.maxPagesPerLeague ?? 60 : 10); page++) {
          const url = new URL(`${API}/odds`);
          url.searchParams.set('sportsbooks', books.slice(0, 5).join(','));
          url.searchParams.set('league', league);
          if (props) url.searchParams.set('is_player_prop', 'true');
          else url.searchParams.set('market_type', gameMarketTypes.join(','));
          url.searchParams.set('is_live', 'false');
          url.searchParams.set('limit', '200');
          if (cursor) url.searchParams.set('cursor', cursor);
          if (this.requests++ > 0) await new Promise((resolve) => setTimeout(resolve, this.options.requestGapMs ?? 700));
          const response = await this.fetchFn(url, { headers: { 'X-API-Key': this.apiKey }, signal: AbortSignal.timeout(30_000) });
          if (response.status === 404 || response.status === 400) break; // league not offered
          if (!response.ok) throw new Error(`SHARPAPI_HTTP_${response.status}`);
          const body = await response.json() as { data?: unknown[]; pagination?: { has_more?: boolean; next_cursor?: string } };
          (props ? rows : gameRows).push(...(body.data ?? []));
          if (!body.pagination?.has_more || !body.pagination.next_cursor) break;
          cursor = body.pagination.next_cursor;
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'SHARPAPI_FAILED';
      return this.status();
    }
    const prices = fairPrices(rows);
    if (!prices.length) { this.lastError = 'NO_PRICES'; return this.status(); }
    this.prices = prices; this.overOnly = overOnlyPrices(rows); this.games = gamePrices(gameRows);
    this.fetchedAt = this.clock().toISOString(); this.lastError = null;
    if (this.file) {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ fetchedAt: this.fetchedAt, prices, overOnly: this.overOnly, games: this.games }));
      await rename(temporary, this.file);
    }
    try { await this.onRefreshed?.(prices, this.clock()); } catch { /* history is best effort */ }
    return this.status();
  }

  start(intervalMinutes: number): void {
    if (this.timer || !this.apiKey || intervalMinutes <= 0) return;
    this.refresh().catch(() => undefined);
    this.timer = setInterval(() => { this.refresh().catch(() => undefined); }, intervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
