import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Edge 2.0 odds snapshot store (spec §1.1): every price CrownIQ observes, kept as a time series so closing-line value,
// movement and backtests are possible. SQLite on the data disk through Node's built-in `node:sqlite` (the server image
// has no native build step, so `better-sqlite3` is not used).
//
// Append-only by change: a row is written when a key's value first appears or changes, and each key's `lastSeenAt` is
// kept current in `latest`. That holds the same information as writing every poll (the value between two rows is the
// earlier one) at a fraction of the size.
// Retention (the data volume is 500 MB; 1.3 days of rows filled 208 MB on 2026-10-07 and every save then failed):
// - full resolution for a day, then one row per key per hour;
// - games that started more than 8 days ago dropped (stale replay looks back 7 days);
// - at most 100,000 rows (~75 MB), oldest first, always keeping each key's newest row.

export type SnapshotSource = 'sharpapi' | 'scraper' | 'odds-api';

export interface SnapshotRow {
  readonly observedAt: string;
  readonly source: SnapshotSource;
  /** prizepicks, underdog, pick6, draftkings, hardrock, fanduel, betrivers, … */
  readonly platform: string;
  readonly eventKey: string;
  readonly playerKey: string;
  readonly market: string;
  readonly number: number | null;
  /** MORE/LESS for props; home/away/over/under/yes for game markets. */
  readonly side: string;
  readonly lineType?: string | null;
  /** Decimal odds (books), probability 0–1 (exchanges), or payout multiplier (pick'em apps); null for a bare line. */
  readonly price?: number | null;
  readonly probability?: number | null;
  readonly multiplier?: number | null;
  readonly startTime: string;
  readonly rawId?: string | null;
}

export interface ClosingRow extends SnapshotRow { readonly closedAt: string }

const keyOf = (row: SnapshotRow) => JSON.stringify([row.source, row.platform, row.eventKey, row.playerKey, row.market,
  row.number, row.side, row.lineType ?? null]);
const valueOf = (row: SnapshotRow) => JSON.stringify([row.price ?? null, row.probability ?? null, row.multiplier ?? null]);

export class SnapshotStore {
  private db: DatabaseSync;
  constructor(private readonly file: string | null, private readonly clock: () => Date = () => new Date()) {
    if (file) mkdirSync(dirname(file), { recursive: true });
    this.db = SnapshotStore.open(file);
  }

  private static open(file: string | null): DatabaseSync {
    const db = new DatabaseSync(file ?? ':memory:');
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY, observedAt TEXT NOT NULL, source TEXT NOT NULL, platform TEXT NOT NULL,
        eventKey TEXT NOT NULL, playerKey TEXT NOT NULL, market TEXT NOT NULL, number REAL, side TEXT NOT NULL,
        lineType TEXT, price REAL, probability REAL, multiplier REAL, startTime TEXT NOT NULL, rawId TEXT, key TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_player ON snapshots (playerKey, market, observedAt);
      CREATE INDEX IF NOT EXISTS snapshots_event ON snapshots (eventKey, observedAt);
      CREATE INDEX IF NOT EXISTS snapshots_key ON snapshots (key, observedAt);
      CREATE TABLE IF NOT EXISTS latest (key TEXT PRIMARY KEY, value TEXT NOT NULL, lastSeenAt TEXT NOT NULL, startTime TEXT NOT NULL);
    `);
    return db;
  }

  /** Records one poll's rows; returns how many changed (were appended). Rows for games already started are ignored. */
  record(rows: readonly SnapshotRow[]): number {
    const now = this.clock().getTime();
    const latest = this.db.prepare('SELECT value FROM latest WHERE key = ?');
    const upsert = this.db.prepare(`INSERT INTO latest (key, value, lastSeenAt, startTime) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, lastSeenAt = excluded.lastSeenAt`);
    const insert = this.db.prepare(`INSERT INTO snapshots (observedAt, source, platform, eventKey, playerKey, market, number,
      side, lineType, price, probability, multiplier, startTime, rawId, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        if (!(Date.parse(row.startTime) > now)) continue;
        const key = keyOf(row), value = valueOf(row);
        const previous = latest.get(key) as { value: string } | undefined;
        if (previous?.value !== value) {
          insert.run(row.observedAt, row.source, row.platform, row.eventKey, row.playerKey, row.market, row.number, row.side,
            row.lineType ?? null, row.price ?? null, row.probability ?? null, row.multiplier ?? null, row.startTime,
            row.rawId ?? null, key);
          changed++;
        }
        upsert.run(key, value, row.observedAt, row.startTime);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return changed;
  }

  /** When a platform's line for a player and stat last changed (its newest row), or null if never seen. */
  lastChange(platform: string, playerKey: string, market: string): number | null {
    const row = this.db.prepare('SELECT MAX(observedAt) AS at FROM snapshots WHERE playerKey = ? AND market = ? AND platform = ?')
      .get(playerKey, market, platform) as { at: string | null } | undefined;
    return row?.at ? Date.parse(row.at) : null;
  }

  /** A player and market's history, oldest first (for movement and line detail). */
  history(playerKey: string, market: string, sinceIso?: string): SnapshotRow[] {
    return this.db.prepare(`SELECT * FROM snapshots WHERE playerKey = ? AND market = ? AND observedAt >= ? ORDER BY observedAt`)
      .all(playerKey, market, sinceIso ?? '') as unknown as SnapshotRow[];
  }

  /**
   * The closing snapshot: for each key of an event, the last observation before the start (only keys still seen within
   * `maxGapMinutes` of the start count as live at the close).
   */
  closing(eventKey: string, maxGapMinutes = 90): ClosingRow[] {
    const rows = this.db.prepare('SELECT * FROM snapshots WHERE eventKey = ? AND observedAt < startTime ORDER BY id')
      .all(eventKey) as unknown as (SnapshotRow & { key: string })[];
    const last = new Map<string, SnapshotRow & { key: string }>();
    for (const row of rows) last.set(row.key, row);
    const seen = this.db.prepare('SELECT lastSeenAt FROM latest WHERE key = ?');
    const out: ClosingRow[] = [];
    for (const row of last.values()) {
      const lastSeen = (seen.get(row.key) as { lastSeenAt: string } | undefined)?.lastSeenAt ?? row.observedAt;
      const closedAt = lastSeen < row.startTime ? lastSeen : row.startTime;
      if ((Date.parse(row.startTime) - Date.parse(closedAt)) / 60_000 <= maxGapMinutes) out.push({ ...row, closedAt });
    }
    return out;
  }

  /** Every market's rows for one player since a time, oldest first (line detail movement), at most `limit` rows. */
  playerHistory(playerKey: string, sinceIso: string, limit = 5000): SnapshotRow[] {
    return this.db.prepare(`SELECT * FROM snapshots WHERE playerKey = ? AND observedAt >= ? ORDER BY observedAt LIMIT ?`)
      .all(playerKey, sinceIso, limit) as unknown as SnapshotRow[];
  }

  /** Events with sportsbook prices that started in [from, to) (for learning book weights). */
  bookEvents(fromIso: string, toIso: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT eventKey FROM snapshots WHERE source = 'sharpapi' AND startTime >= ? AND startTime < ?
      AND platform NOT IN ('prizepicks', 'prizepicks_flex')`).all(fromIso, toIso) as { eventKey: string }[]).map((row) => row.eventKey);
  }

  /** One event's sportsbook price rows before the start, oldest first. */
  bookRows(eventKey: string): SnapshotRow[] {
    return this.db.prepare(`SELECT * FROM snapshots WHERE eventKey = ? AND source = 'sharpapi' AND observedAt < startTime
      AND platform NOT IN ('prizepicks', 'prizepicks_flex') ORDER BY observedAt`).all(eventKey) as unknown as SnapshotRow[];
  }

  /**
   * Keeps the store small (see Retention above), then hands the freed space back to the disk when it is worth it: SQLite
   * reuses deleted pages but never shrinks the file, so a store with over 20 MB free is rewritten compactly.
   */
  prune(options: { fullHours?: number; keepDays?: number; maxRows?: number } = {}): { deleted: number; compacted: boolean } {
    const now = this.clock().getTime(), { fullHours = 24, keepDays = 8, maxRows = 100_000 } = options;
    const iso = (ms: number) => new Date(now - ms).toISOString();
    let deleted = 0;
    const run = (sql: string, ...args: (string | number)[]) => { deleted += Number(this.db.prepare(sql).run(...args).changes); };
    run('DELETE FROM snapshots WHERE startTime < ?', iso(keepDays * 86_400_000));
    const hourly = iso(fullHours * 3600_000);
    run(`DELETE FROM snapshots WHERE observedAt < ? AND id NOT IN (SELECT MAX(id) FROM snapshots WHERE observedAt < ?
      GROUP BY key, substr(observedAt, 1, 13))`, hourly, hourly);
    const cut = this.db.prepare('SELECT id FROM snapshots ORDER BY id DESC LIMIT 1 OFFSET ?').get(maxRows) as { id: number } | undefined;
    if (cut) run('DELETE FROM snapshots WHERE id <= ? AND id NOT IN (SELECT MAX(id) FROM snapshots GROUP BY key)', cut.id);
    this.db.prepare('DELETE FROM latest WHERE startTime < ?').run(iso(86_400_000));
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { deleted, compacted: this.compact() };
  }

  private compact(minFreeBytes = 20e6): boolean {
    if (!this.file) return false;
    const pragma = (name: string) => Number(Object.values(this.db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0]);
    if (pragma('freelist_count') * pragma('page_size') < minFreeBytes) return false;
    const target = `${this.file}.compact`;
    rmSync(target, { force: true });
    try { this.db.prepare('VACUUM INTO ?').run(target); } catch { rmSync(target, { force: true }); return false; }
    this.db.close();
    for (const suffix of ['-wal', '-shm']) rmSync(`${this.file}${suffix}`, { force: true });
    renameSync(target, this.file);
    this.db = SnapshotStore.open(this.file);
    return true;
  }

  /** Rows in total, written in the last hour and day, and per source in the last day (owner diagnostics). */
  status() {
    const at = this.clock().getTime();
    const count = (since: number) => Number((this.db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE observedAt >= ?')
      .get(new Date(at - since).toISOString()) as { n: number }).n);
    const bySource = this.db.prepare(`SELECT source, platform, COUNT(*) AS n FROM snapshots WHERE observedAt >= ?
      GROUP BY source, platform ORDER BY n DESC`).all(new Date(at - 86_400_000).toISOString()) as { source: string; platform: string; n: number }[];
    const oldest = this.db.prepare('SELECT MIN(observedAt) AS at FROM snapshots').get() as { at: string | null };
    return { rows: Number((this.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n),
      lastHour: count(3600_000), lastDay: count(86_400_000), oldest: oldest.at, keys: Number((this.db.prepare(
        'SELECT COUNT(*) AS n FROM latest').get() as { n: number }).n), bySource };
  }

  close(): void { this.db.close(); }
}
