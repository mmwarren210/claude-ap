import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The player store (owner, 2026-10-12: "a history database for each player… a permanent profile for each player"). One
// SQLite file on the data disk (Node's built-in node:sqlite, like Edge's price history):
// - games: one row per player per game (PropLine box scores), written only for players that changed, so a save no longer
//   rewrites everyone. Newest first when read. Games older than two seasons are folded into one summary row per season
//   (games played and each stat's average) so old information stays without crowding the recent games.
// - fetches: when each player was last asked and how (so a fresh player is read, not re-asked).
// - profiles: facts that rarely change (team, position, bats/throws, status) from ESPN's rosters, and the player's
//   recent-season summary from his games. Written only when something changed. Display only: no model scores them.

export interface StoredGame { readonly at: string; readonly opponent: string | null; readonly home?: string | null;
  readonly away?: string | null; readonly stats: Readonly<Record<string, number>> }
const fetchOf = (row: Record<string, unknown>): FetchInfo => ({ at: Number(row.at), ...(row.keepMs != null ? { keepMs: Number(row.keepMs) } : {}),
  deep: row.deep === 1, teams: row.teams === 1, empty: row.empty === 1 });

export interface FetchInfo { readonly at: number; readonly keepMs?: number; readonly deep?: boolean; readonly teams?: boolean;
  readonly empty?: boolean }
export interface SeasonSummary { readonly season: string; readonly games: number; readonly averages: Readonly<Record<string, number>> }
export interface PlayerProfile {
  readonly sport: string; readonly name: string; readonly team: string | null; readonly position: string | null;
  readonly bats: string | null; readonly throws: string | null; readonly status: string | null; readonly jersey: string | null;
  readonly espnId: string | null; readonly updatedAt: string;
}

/** Two seasons of game rows are kept; anything older becomes a season summary. */
export const KEEP_ROWS_MS = 2 * 365 * 86_400_000;
/** A season label: the calendar year, except football and basketball and hockey seasons that span New Year (Aug–Jul). */
export function seasonOf(sportKey: string, at: string): string {
  const date = new Date(at), year = date.getUTCFullYear();
  if (/^(football|basketball_nba|basketball_ncaab|hockey)/.test(sportKey)) return date.getUTCMonth() >= 7 ? `${year}-${(year + 1) % 100}` : `${year - 1}-${year % 100}`;
  return String(year);
}

export class PlayerStore {
  private readonly db: DatabaseSync;
  constructor(file: string | null) {
    if (file) mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file ?? ':memory:');
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS games (player TEXT NOT NULL, at TEXT NOT NULL, opponent TEXT, home TEXT, away TEXT,
        stats TEXT NOT NULL, PRIMARY KEY (player, at)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS fetches (player TEXT PRIMARY KEY, at INTEGER NOT NULL, keepMs INTEGER, deep INTEGER,
        teams INTEGER, empty INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS seasons (player TEXT NOT NULL, season TEXT NOT NULL, games INTEGER NOT NULL,
        averages TEXT NOT NULL, PRIMARY KEY (player, season)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS profiles (sport TEXT NOT NULL, nameKey TEXT NOT NULL, name TEXT NOT NULL, team TEXT,
        position TEXT, bats TEXT, throws TEXT, status TEXT, jersey TEXT, espnId TEXT, updatedAt TEXT NOT NULL,
        PRIMARY KEY (sport, nameKey)) WITHOUT ROWID;`);
  }

  isEmpty(): boolean { return !(this.db.prepare('SELECT 1 AS one FROM fetches LIMIT 1').get()); }

  /** Every player's fetch record and games (newest first): what the history loads at startup. */
  /** Every player fetched since `since` (all of them when left out), with his games. */
  all(since = 0): Map<string, { fetch: FetchInfo; games: StoredGame[] }> {
    const out = new Map<string, { fetch: FetchInfo; games: StoredGame[] }>();
    for (const row of this.db.prepare('SELECT * FROM fetches WHERE at >= ?').all(since) as Record<string, unknown>[])
      out.set(String(row.player), { fetch: fetchOf(row), games: [] });
    for (const row of this.db.prepare('SELECT g.* FROM games g JOIN fetches f ON f.player = g.player WHERE f.at >= ? ORDER BY g.player, g.at DESC')
      .all(since) as Record<string, unknown>[]) {
      const entry = out.get(String(row.player));
      if (entry) entry.games.push(gameOf(row));
    }
    return out;
  }

  /**
   * One page of the players fetched since `since`, after player key `after` in key order, each with his games (newest
   * first). The history loads at startup page by page, so the server thread gets turns in between (2026-10-17 freezes).
   */
  recentPage(since: number, after: string, limit = 100): { key: string; fetch: FetchInfo; games: StoredGame[] }[] {
    return (this.db.prepare('SELECT * FROM fetches WHERE at >= ? AND player > ? ORDER BY player LIMIT ?').all(since, after, limit) as
      Record<string, unknown>[]).map((row) => ({ key: String(row.player), fetch: fetchOf(row), games: this.games(String(row.player)) }));
  }

  /** One player's last fetch, or null when he was never fetched. */
  fetch(player: string): FetchInfo | null {
    const row = this.db.prepare('SELECT * FROM fetches WHERE player = ?').get(player) as Record<string, unknown> | undefined;
    return row ? fetchOf(row) : null;
  }

  /** A player's games, newest first. */
  games(player: string): StoredGame[] {
    return (this.db.prepare('SELECT * FROM games WHERE player = ? ORDER BY at DESC').all(player) as Record<string, unknown>[]).map(gameOf);
  }

  /**
   * Saves one player's fetch and merges his games (a game already stored is replaced by the newer copy). Games older than
   * two seasons fold into season summaries. One transaction per player.
   */
  put(player: string, sportKey: string, fetch: FetchInfo, games: readonly StoredGame[], now = Date.now()): void {
    const upsertGame = this.db.prepare(`INSERT INTO games (player, at, opponent, home, away, stats) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (player, at) DO UPDATE SET opponent = excluded.opponent, home = excluded.home, away = excluded.away, stats = excluded.stats
      WHERE opponent IS NOT excluded.opponent OR home IS NOT excluded.home OR away IS NOT excluded.away OR stats IS NOT excluded.stats`);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO fetches (player, at, keepMs, deep, teams, empty) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (player) DO UPDATE SET at = excluded.at, keepMs = excluded.keepMs, deep = excluded.deep, teams = excluded.teams,
        empty = excluded.empty`).run(player, fetch.at, fetch.keepMs ?? null, fetch.deep ? 1 : 0, fetch.teams ? 1 : 0, fetch.empty ? 1 : 0);
      for (const game of games) upsertGame.run(player, game.at, game.opponent, game.home ?? null, game.away ?? null, JSON.stringify(game.stats));
      this.fold(player, sportKey, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Folds a player's games older than two seasons into one summary per season, then drops those rows. */
  private fold(player: string, sportKey: string, now: number) {
    const cutoff = new Date(now - KEEP_ROWS_MS).toISOString();
    const old = (this.db.prepare('SELECT * FROM games WHERE player = ? AND at < ?').all(player, cutoff) as Record<string, unknown>[]).map(gameOf);
    if (!old.length) return;
    const bySeason = new Map<string, StoredGame[]>();
    for (const game of old) {
      const season = seasonOf(sportKey, game.at), list = bySeason.get(season);
      if (list) list.push(game); else bySeason.set(season, [game]);
    }
    for (const [season, list] of bySeason) {
      const existing = this.db.prepare('SELECT games, averages FROM seasons WHERE player = ? AND season = ?').get(player, season) as
        { games: number; averages: string } | undefined;
      const sums = new Map<string, { total: number; count: number }>();
      if (existing) for (const [key, value] of Object.entries(JSON.parse(existing.averages) as Record<string, number>))
        sums.set(key, { total: value * existing.games, count: existing.games });
      for (const game of list) for (const [key, value] of Object.entries(game.stats)) {
        const item = sums.get(key) ?? { total: 0, count: 0 }; item.total += value; item.count++; sums.set(key, item);
      }
      const games = (existing?.games ?? 0) + list.length;
      const averages = Object.fromEntries([...sums].map(([key, item]) => [key, Math.round(item.total / item.count * 1000) / 1000]));
      this.db.prepare(`INSERT INTO seasons (player, season, games, averages) VALUES (?, ?, ?, ?)
        ON CONFLICT (player, season) DO UPDATE SET games = excluded.games, averages = excluded.averages`).run(player, season, games, JSON.stringify(averages));
    }
    this.db.prepare('DELETE FROM games WHERE player = ? AND at < ?').run(player, cutoff);
  }

  seasons(player: string): SeasonSummary[] {
    return (this.db.prepare('SELECT season, games, averages FROM seasons WHERE player = ? ORDER BY season DESC').all(player) as
      { season: string; games: number; averages: string }[]).map((row) => ({ season: row.season, games: row.games, averages: JSON.parse(row.averages) }));
  }

  /**
   * Drops up to `limit` players not asked for since `olderThan` (and their games) in one transaction; season summaries
   * stay. Returns how many went, so a caller can repeat it with pauses until it returns 0.
   */
  pruneSome(olderThan: number, limit = 500): number {
    const stale = (this.db.prepare('SELECT player FROM fetches WHERE at < ? ORDER BY player LIMIT ?').all(olderThan, limit) as
      { player: string }[]).map((row) => row.player);
    if (!stale.length) return 0;
    const games = this.db.prepare('DELETE FROM games WHERE player = ?'), fetches = this.db.prepare('DELETE FROM fetches WHERE player = ?');
    this.db.exec('BEGIN');
    try {
      for (const player of stale) { games.run(player); fetches.run(player); }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return stale.length;
  }

  /** Drops players not asked for in a long while (and their games); season summaries stay. */
  prune(olderThan: number): number {
    const stale = (this.db.prepare('SELECT player FROM fetches WHERE at < ?').all(olderThan) as { player: string }[]).map((row) => row.player);
    for (const player of stale) { this.db.prepare('DELETE FROM games WHERE player = ?').run(player); this.db.prepare('DELETE FROM fetches WHERE player = ?').run(player); }
    return stale.length;
  }

  /** Writes a profile only when something in it changed; returns whether it did. */
  putProfile(nameKey: string, profile: PlayerProfile): boolean {
    const current = this.profile(profile.sport, nameKey);
    const same = current && (['name', 'team', 'position', 'bats', 'throws', 'status', 'jersey', 'espnId'] as const)
      .every((field) => current[field] === profile[field]);
    if (same) return false;
    this.db.prepare(`INSERT INTO profiles (sport, nameKey, name, team, position, bats, throws, status, jersey, espnId, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (sport, nameKey) DO UPDATE SET name = excluded.name, team = excluded.team,
      position = excluded.position, bats = excluded.bats, throws = excluded.throws, status = excluded.status, jersey = excluded.jersey,
      espnId = excluded.espnId, updatedAt = excluded.updatedAt`).run(profile.sport, nameKey, profile.name, profile.team, profile.position,
      profile.bats, profile.throws, profile.status, profile.jersey, profile.espnId, profile.updatedAt);
    return true;
  }

  /** Every stored position, as [sport, name key, position] (the app shows it beside each player). */
  positions(): [string, string, string][] {
    return (this.db.prepare('SELECT sport, nameKey, position FROM profiles WHERE position IS NOT NULL').all() as
      { sport: string; nameKey: string; position: string }[]).map((row) => [row.sport, row.nameKey, row.position]);
  }

  profile(sport: string, nameKey: string): PlayerProfile | null {
    const row = this.db.prepare('SELECT * FROM profiles WHERE sport = ? AND nameKey = ?').get(sport, nameKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    const text = (value: unknown) => value == null ? null : String(value);
    return { sport: String(row.sport), name: String(row.name), team: text(row.team), position: text(row.position), bats: text(row.bats),
      throws: text(row.throws), status: text(row.status), jersey: text(row.jersey), espnId: text(row.espnId), updatedAt: String(row.updatedAt) };
  }

  counts() {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return { players: one('SELECT COUNT(*) AS n FROM fetches'), games: one('SELECT COUNT(*) AS n FROM games'),
      seasons: one('SELECT COUNT(*) AS n FROM seasons'), profiles: one('SELECT COUNT(*) AS n FROM profiles') };
  }

  close() { this.db.close(); }
}

function gameOf(row: Record<string, unknown>): StoredGame {
  return { at: String(row.at), opponent: row.opponent == null ? null : String(row.opponent), home: row.home == null ? null : String(row.home),
    away: row.away == null ? null : String(row.away), stats: JSON.parse(String(row.stats)) as Record<string, number> };
}
