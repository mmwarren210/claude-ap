import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Stat API ends 2026-10-20 (owner, 2026-10-15: "save everything you can while you can"). Pages every table we know for each
// sport into JSON-lines files on the data volume, one row per line, and remembers where each table stopped so a restart or
// a quota stop carries on from there. Raw rows only: nothing here feeds GKR or the board.

/** Tables read whole (paged with from_id). */
export const BASE_TABLES: Readonly<Record<string, readonly string[]>> = {
  NFL: ['seasons', 'teams', 'players'],
  NBA: ['seasons', 'teams', 'players'],
  MLB: ['seasons', 'teams', 'players'],
  PGA: ['seasons', 'players', 'tournaments', 'player_season_stats'],
};
/** Tables read one player at a time (they refuse a request without player_id). */
export const PLAYER_TABLES: Readonly<Record<string, readonly string[]>> = {
  NFL: ['game_player_stats'],
  NBA: ['game_player_stats'],
  MLB: ['game_player_batter_stats', 'game_player_pitching_stats'],
  PGA: ['player_rounds'],
};
const BASE = 'https://api.stat-api.com/api/v1';
const LIMITS = [2500, 1000, 500, 200, 100];
const WORKERS = 2;
/** Rate-limit waits on one request before the archive stops for the day. */
const RATE_WAITS = 12;

type Unit = { readonly key: string; readonly sport: string; readonly table: string; readonly file: string;
  readonly params: Readonly<Record<string, string>> };
type UnitState = { fromId: number; rows: number; pages: number; done: boolean; error: string | null; limit: number };
type State = Record<string, UnitState>;
const rowsOf = (body: unknown, table: string): unknown[] => {
  if (Array.isArray(body)) return body;
  const data = body as Record<string, unknown>;
  return Array.isArray(data[table]) ? data[table] as unknown[] : Object.values(data).find(Array.isArray) as unknown[] | undefined ?? [];
};

export class StatApiArchive {
  private running = false;
  private state: State = {};
  private quotaRemaining: number | null = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private stopReason: string | null = null;
  private planned = 0;

  constructor(private readonly key: string, private readonly dir: string, private readonly fetchFn: typeof fetch = fetch,
    private readonly pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))) {}

  private get stateFile() { return join(this.dir, 'state-v2.json'); }
  private async load() { try { this.state = JSON.parse(await readFile(this.stateFile, 'utf8')) as State; } catch { this.state = {}; } }
  private async save() { await writeFile(this.stateFile, JSON.stringify(this.state)); }

  /** Starts the archive in the background; false when it is already running. */
  start(): boolean {
    if (this.running) return false;
    this.running = true; this.startedAt = new Date().toISOString(); this.finishedAt = null; this.stopReason = null;
    void this.run().catch((error) => { this.stopReason = error instanceof Error ? error.message : 'FAILED'; })
      .finally(() => { this.running = false; this.finishedAt = new Date().toISOString(); void this.save(); });
    return true;
  }

  /** Ids saved in a table's file (players, seasons). */
  private async ids(file: string, field: string): Promise<number[]> {
    let text = '';
    try { text = await readFile(join(this.dir, file), 'utf8'); } catch { return []; }
    const ids = new Set<number>();
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const id = Number((JSON.parse(line) as Record<string, unknown>)[field]); if (Number.isSafeInteger(id) && id > 0) ids.add(id); }
      catch { /* skip a torn line */ }
    }
    return [...ids];
  }

  private async run() {
    await mkdir(this.dir, { recursive: true });
    await this.load();
    const base: Unit[] = Object.entries(BASE_TABLES).flatMap(([sport, tables]) => tables.map((table) =>
      ({ key: `${sport}_${table}`, sport, table, file: `${sport}_${table}.jsonl`, params: {} })));
    if (await this.all(base)) return;
    // Games, one season at a time (the games table holds a season per request).
    const games: Unit[] = [];
    for (const sport of ['NFL', 'NBA', 'MLB']) for (const year of await this.ids(`${sport}_seasons.jsonl`, 'start_year'))
      games.push({ key: `${sport}_games_${year}`, sport, table: 'games', file: `${sport}_games.jsonl`, params: { season_id: String(year) } });
    if (await this.all(games)) return;
    const perPlayer: Unit[] = [];
    for (const [sport, tables] of Object.entries(PLAYER_TABLES)) {
      const players = await this.ids(`${sport}_players.jsonl`, 'id');
      for (const table of tables) for (const id of players)
        perPlayer.push({ key: `${sport}_${table}_${id}`, sport, table, file: `${sport}_${table}.jsonl`, params: { player_id: String(id) } });
    }
    await this.all(perPlayer);
  }

  /** Runs units with a few workers. True when the whole archive must stop (quota, key). */
  private async all(units: readonly Unit[]): Promise<boolean> {
    this.planned = Math.max(this.planned, Object.keys(this.state).length + units.filter((unit) => !this.state[unit.key]).length);
    const queue = units.filter((unit) => !this.state[unit.key]?.done);
    let finished = 0;
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      for (let unit = queue.shift(); unit && !this.stopReason; unit = queue.shift()) {
        const stop = await this.unit(unit);
        if (stop) this.stopReason = stop;
        if (++finished % 25 === 0) await this.save();
      }
    }));
    await this.save();
    return this.stopReason !== null;
  }

  /** Pages one unit to its end. Returns a reason to stop the whole archive (quota, key), or null to go on. */
  private async unit(unit: Unit): Promise<string | null> {
    const entry = this.state[unit.key] ??= { fromId: 0, rows: 0, pages: 0, done: false, error: null, limit: LIMITS[0] };
    let rateWaits = 0;
    for (;;) {
      const url = new URL(`${BASE}/${unit.sport.toLowerCase()}/${unit.table}`);
      for (const [name, value] of Object.entries(unit.params)) url.searchParams.set(name, value);
      url.searchParams.set('limit', String(entry.limit));
      url.searchParams.set('from_id', String(entry.fromId));
      let response: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          response = await this.fetchFn(url, { headers: { authorization: `Bearer ${this.key}`, accept: 'application/json' },
            signal: AbortSignal.timeout(30_000) });
          if (response.status < 500) break;
        } catch { response = null; }
        await this.pause(2000 * 2 ** attempt);
      }
      if (!response) { entry.error = 'UNREACHABLE'; return null; }
      const left = response.headers.get('x-quota-remaining');
      if (left !== null && /^\d+$/.test(left)) this.quotaRemaining = Number(left);
      if (response.status === 429) {
        // A per-minute rate limit, not the monthly quota: wait it out (Retry-After, else a minute) and try again.
        if (this.quotaRemaining === 0 || (rateWaits += 1) > RATE_WAITS) return 'QUOTA_EXHAUSTED';
        const after = Number(response.headers.get('retry-after'));
        await this.pause(Number.isFinite(after) && after > 0 ? Math.min(after, 600) * 1000 : 60_000);
        continue;
      }
      if (response.status === 401 || response.status === 403) return 'KEY_REJECTED';
      if (response.status === 404) { entry.done = true; entry.error = 'NOT_FOUND'; return null; }
      if (response.status === 400 || response.status === 422) {
        const smaller = LIMITS.find((limit) => limit < entry.limit);
        if (smaller) { entry.limit = smaller; continue; }
        entry.done = true; entry.error = `HTTP_${response.status}`; return null;
      }
      if (!response.ok) { entry.error = `HTTP_${response.status}`; return null; }
      let body: unknown;
      try { body = await response.json(); } catch { entry.error = 'BAD_JSON'; return null; }
      const rows = rowsOf(body, unit.table);
      if (rows.length) await appendFile(join(this.dir, unit.file), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      entry.rows += rows.length; entry.pages++; entry.error = null;
      const next = Array.isArray(body) ? null : (body as Record<string, unknown>).next_from_id;
      if (typeof next !== 'number' || !Number.isSafeInteger(next) || next <= entry.fromId || !rows.length) { entry.done = true; return null; }
      entry.fromId = next;
    }
  }

  async status() {
    if (!this.running) await this.load();
    let files: { name: string; bytes: number }[] = [];
    try {
      files = await Promise.all((await readdir(this.dir)).filter((name) => name.endsWith('.jsonl'))
        .map(async (name) => ({ name, bytes: (await stat(join(this.dir, name))).size })));
    } catch { /* nothing saved yet */ }
    const units = Object.entries(this.state), byTable: Record<string, { rows: number; requests: number; done: number; errors: number }> = {};
    for (const [key, item] of units) {
      const table = key.replace(/_\d+$/, ''), sum = byTable[table] ??= { rows: 0, requests: 0, done: 0, errors: 0 };
      sum.rows += item.rows; sum.requests++; if (item.done) sum.done++; if (item.error) sum.errors++;
    }
    return { running: this.running, startedAt: this.startedAt, finishedAt: this.finishedAt, stopReason: this.stopReason,
      quotaRemaining: this.quotaRemaining, totalRows: units.reduce((sum, [, item]) => sum + item.rows, 0),
      unitsDone: units.filter(([, item]) => item.done).length, unitsPlanned: this.planned, tables: byTable, files };
  }

  /** A saved table file to download, or null. */
  async file(name: string) {
    if (!/^[A-Z]+_[a-z_]+\.jsonl$/.test(name)) return null;
    try { await stat(join(this.dir, name)); } catch { return null; }
    return createReadStream(join(this.dir, name));
  }
}
