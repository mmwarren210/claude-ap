import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizedName } from '../context/match.js';
import { canonicalMarket } from '../edge/market-map.js';
import { leagueInfo } from './markets.js';
import type { PropLineClient } from './propline.js';
import { proplineLeague, proplineMarketKey } from './propline.js';

// Prop results from PropLine (owner, 2026-10-09): every prop graded against the real box score, pushed the moment it settles
// ("resolution" deliveries) and read back per game from /results when a delivery was missed. Picks are graded from the actual
// stat value, matched by PropLine's own game id, the player and the stat. Two days of finished games are kept.

type Entry = { actual: number; at: string };
type Saved = { results: Record<string, Entry>; sports: Record<string, string>; asked: Record<string, string> };

/** PropLine's game id inside a CrownIQ event id ("pp-game:propline:46672" → "46672"). */
export const proplineGameId = (eventId: string) => /propline:(\d+)/.exec(eventId)?.[1] ?? null;

export class PropLineResults {
  private data: Saved = { results: {}, sports: {}, asked: {} };
  private loaded = false;
  private dirty = false;
  readonly stats = { pushed: 0, fetched: 0, games: 0, graded: 0 };

  constructor(private readonly client: PropLineClient | null, private readonly file: string,
    private readonly clock: () => Date = () => new Date()) {}

  private key(gameId: string, sport: string, player: string, market: string): string {
    return `${gameId}|${normalizedName(player)}|${canonicalMarket(sport, market)}`;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try { this.data = { results: {}, sports: {}, asked: {}, ...JSON.parse(await readFile(this.file, 'utf8')) as Partial<Saved> }; } catch { /* first run */ }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    // Two days after a result arrived it has been used; drop it.
    const cutoff = this.clock().getTime() - 2 * 86_400_000;
    for (const [key, entry] of Object.entries(this.data.results)) if (Date.parse(entry.at) < cutoff) delete this.data.results[key];
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data));
    await rename(temporary, this.file);
  }

  /** Remembers which PropLine sport a game belongs to (from any delivery), so its results can be read back later. */
  noteGame(gameId: string, sportKey: string): void {
    if (!this.loaded) { void this.load().then(() => this.noteGame(gameId, sportKey)); return; }
    if (this.data.sports[gameId] !== sportKey) { this.data.sports[gameId] = sportKey; this.dirty = true; }
  }

  private put(gameId: string, sportKey: string, player: string, marketKey: string, actual: unknown, resolution: unknown): boolean {
    // Only a settled prop counts (won, lost or push): an in-progress game's running stat is never used, and a void (player
    // not in the box score) leaves the pick to the other sources.
    if (typeof actual !== 'number' || !Number.isFinite(actual) || !['won', 'lost', 'push'].includes(String(resolution))) return false;
    const sport = leagueInfo(proplineLeague(sportKey)).sport;
    // Stored under PropLine's market key and CrownIQ's name for it, so either form of a pick finds it.
    for (const market of new Set([marketKey, proplineMarketKey(sport, marketKey)]))
      this.data.results[this.key(gameId, sport, player, market)] = { actual, at: this.clock().toISOString() };
    this.dirty = true;
    return true;
  }

  /** A pushed resolution delivery. */
  async record(event: Record<string, unknown>): Promise<void> {
    await this.load();
    const game = (event.event as { id?: unknown } | undefined)?.id, sportKey = String(event.sport_key ?? '');
    const player = typeof event.player_name === 'string' ? event.player_name : typeof event.description === 'string' ? event.description : null;
    if (game === undefined || !sportKey || !player || typeof event.market_key !== 'string') return;
    this.noteGame(String(game), sportKey);
    const current = event.current as { actual_value?: unknown } | undefined;
    if (this.put(String(game), sportKey, player, event.market_key, event.actual_value ?? current?.actual_value, event.resolution)) this.stats.pushed++;
  }

  /** Reads back results for finished games with picks still waiting (one request per game, each game once an hour at most). */
  async fetchGames(gameIds: readonly string[], limit = 40): Promise<void> {
    await this.load();
    if (!this.client) return;
    const now = this.clock().getTime();
    const due = [...new Set(gameIds)].filter((id) => this.data.sports[id] && (!this.data.asked[id] || now - Date.parse(this.data.asked[id]!) > 3600_000)).slice(0, limit);
    for (const id of due) {
      const sportKey = this.data.sports[id]!;
      this.data.asked[id] = new Date(now).toISOString(); this.dirty = true;
      try {
        const body = await this.client.get<{ bookmakers?: { markets?: { key: string; outcomes?: { description?: string; actual_value?: unknown; resolution?: unknown }[] }[] }[] }>(
          `/v1/sports/${sportKey}/events/${id}/results?bookmakers=prizepicks,underdog,draftkings,fanduel`);
        this.stats.games++;
        for (const book of body.bookmakers ?? []) for (const market of book.markets ?? []) for (const outcome of market.outcomes ?? [])
          if (outcome.description && this.put(id, sportKey, outcome.description, market.key, outcome.actual_value, outcome.resolution)) this.stats.fetched++;
      } catch { /* retried next hour */ }
    }
    await this.save();
  }

  /**
   * Each pick's platform line at the open and at the start (PropLine's closing lines), one game at a time. The game's stats
   * are requested 30 at a time from the sport's market list. Picks on a game PropLine never named stay unchecked.
   */
  async closingFor(picks: readonly { id: string; eventId: string; sport: string; platform: string; playerName: string; market: string;
    side: 'MORE' | 'LESS'; threshold: number }[], marketsFor: (sportKey: string) => Promise<readonly string[]>, limit = 30):
    Promise<{ id: string; openingPoint?: number; closingPoint?: number; closingDecimal?: number }[]> {
    await this.load();
    if (!this.client) return [];
    const byGame = new Map<string, typeof picks[number][]>();
    for (const pick of picks) { const game = proplineGameId(pick.eventId); if (game && this.data.sports[game]) byGame.set(game, [...byGame.get(game) ?? [], pick]); }
    const out: { id: string; openingPoint?: number; closingPoint?: number; closingDecimal?: number }[] = [];
    for (const [game, list] of [...byGame].slice(0, limit)) {
      const sportKey = this.data.sports[game]!, keys = await marketsFor(sportKey);
      const books = [...new Set(list.map((pick) => pick.platform))].join(',');
      const found = new Map<string, { point: number; price: number | null; open: number | null }[]>();
      let ok = true;
      for (let index = 0; index < keys.length; index += 30) {
        try {
          const body = await this.client.get<{ bookmakers?: { key: string; markets?: { key: string; outcomes?: { name?: string; description?: string; point?: number;
            price?: number; opening_point?: number }[] }[] }[] }>(`/v1/sports/${sportKey}/events/${game}/odds/closing?markets=${keys.slice(index, index + 30).join(',')}&bookmakers=${books}`);
          const sport = leagueInfo(proplineLeague(sportKey)).sport;
          for (const book of body.bookmakers ?? []) for (const market of book.markets ?? []) for (const outcome of market.outcomes ?? []) {
            if (!outcome.description || typeof outcome.point !== 'number') continue;
            const side = /^(over|yes)$/i.test(outcome.name ?? '') ? 'MORE' : 'LESS';
            const key = `${book.key}|${normalizedName(outcome.description)}|${canonicalMarket(sport, proplineMarketKey(sport, market.key))}|${side}`;
            found.set(key, [...found.get(key) ?? [], { point: outcome.point, price: typeof outcome.price === 'number' ? outcome.price : null,
              open: typeof outcome.opening_point === 'number' ? outcome.opening_point : null }]);
          }
        } catch { ok = false; }
      }
      if (!ok) continue; // retried next run
      for (const pick of list) {
        const rows = found.get(`${pick.platform}|${normalizedName(pick.playerName)}|${canonicalMarket(pick.sport, pick.market)}|${pick.side}`) ?? [];
        // An app's ladder lists several numbers: the pick's own rung is the one whose opening number is nearest to it.
        const row = [...rows].sort((a, b) => Math.abs((a.open ?? a.point) - pick.threshold) - Math.abs((b.open ?? b.point) - pick.threshold))[0];
        const decimal = row?.price === null || row?.price === undefined ? undefined : row.price > 0 ? 1 + row.price / 100 : 1 + 100 / -row.price;
        out.push({ id: pick.id, ...(row ? { closingPoint: row.point } : {}), ...(row?.open !== null && row?.open !== undefined ? { openingPoint: row.open } : {}),
          ...(decimal && pick.platform !== 'prizepicks' ? { closingDecimal: Math.round(decimal * 1000) / 1000 } : {}) });
      }
    }
    return out;
  }

  /** Closing lines for started picks, with the stat list from PropLine's market discovery (cached 6 hours). */
  closing(picks: Parameters<PropLineResults['closingFor']>[0]) {
    return this.closingFor(picks, async (sportKey) => (await this.client?.propMarkets([]).catch(() => null))?.get(sportKey) ?? []);
  }

  /** PropLine's sport key for a CrownIQ event it listed (soccer has one per league); null before the saved file is read. */
  sportKeyFor(eventId: string): string | null {
    if (!this.loaded) { void this.load(); return null; }
    const game = proplineGameId(eventId);
    return game ? this.data.sports[game] ?? null : null;
  }

  /** A pick's actual stat value, when PropLine has graded that game, player and stat. */
  async actual(pick: { eventId: string; sport: string; playerName: string; market: string }): Promise<number | null> {
    await this.load();
    const game = proplineGameId(pick.eventId);
    if (!game) return null;
    return this.data.results[this.key(game, pick.sport, pick.playerName, pick.market)]?.actual ?? null;
  }

  status() { return { ...this.stats, stored: Object.keys(this.data.results).length, games: Object.keys(this.data.sports).length }; }
}
