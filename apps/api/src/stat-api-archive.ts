import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Stat API ends 2026-10-20 (owner, 2026-10-15: "save everything you can while you can"). Pages every table we know for each
// sport into JSON-lines files on the data volume, one row per line, and remembers where each table stopped so a restart or
// a quota stop carries on from there. Raw rows only: nothing here feeds GKR or the board.

export const ARCHIVE_TABLES: Readonly<Record<string, readonly string[]>> = {
  NFL: ['seasons', 'teams', 'players', 'games', 'game_player_stats', 'game_team_stats'],
  NBA: ['seasons', 'teams', 'players', 'games', 'game_player_stats', 'game_team_stats'],
  MLB: ['seasons', 'teams', 'players', 'games', 'game_player_batter_stats', 'game_player_pitching_stats', 'game_team_stats'],
  PGA: ['seasons', 'players', 'tournaments', 'player_rounds', 'player_season_stats'],
};
const BASE = 'https://api.stat-api.com/api/v1';
const LIMITS = [1000, 500, 200, 100];

type TableState = { fromId: number | null; rows: number; pages: number; done: boolean; error: string | null; limit: number };
type State = Record<string, TableState>;

export class StatApiArchive {
  private running = false;
  private state: State = {};
  private quotaRemaining: number | null = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private stopReason: string | null = null;

  constructor(private readonly key: string, private readonly dir: string, private readonly fetchFn: typeof fetch = fetch,
    private readonly pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))) {}

  private get stateFile() { return join(this.dir, 'state.json'); }
  private async load() { try { this.state = JSON.parse(await readFile(this.stateFile, 'utf8')) as State; } catch { this.state = {}; } }
  private async save() { await writeFile(this.stateFile, JSON.stringify(this.state)); }

  /** Starts the archive in the background; false when it is already running. */
  start(): boolean {
    if (this.running) return false;
    this.running = true; this.startedAt = new Date().toISOString(); this.finishedAt = null; this.stopReason = null;
    void this.run().catch((error) => { this.stopReason = error instanceof Error ? error.message : 'FAILED'; })
      .finally(() => { this.running = false; this.finishedAt = new Date().toISOString(); });
    return true;
  }

  private async run() {
    await mkdir(this.dir, { recursive: true });
    await this.load();
    for (const [sport, tables] of Object.entries(ARCHIVE_TABLES)) for (const table of tables) {
      const name = `${sport}_${table}`;
      const entry = this.state[name] ??= { fromId: null, rows: 0, pages: 0, done: false, error: null, limit: LIMITS[0] };
      if (entry.done) continue;
      const stop = await this.table(sport, table, name, entry);
      await this.save();
      if (stop) { this.stopReason = stop; return; }
    }
  }

  /** Pages one table to its end. Returns a reason to stop the whole archive (quota, key), or null to go on. */
  private async table(sport: string, table: string, name: string, entry: TableState): Promise<string | null> {
    for (;;) {
      const url = new URL(`${BASE}/${sport.toLowerCase()}/${table}`);
      url.searchParams.set('limit', String(entry.limit));
      if (entry.fromId) url.searchParams.set('from_id', String(entry.fromId));
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
      if (response.status === 429) return 'QUOTA_EXHAUSTED';
      if (response.status === 401 || response.status === 403) return 'KEY_REJECTED';
      if (response.status === 404) { entry.done = true; entry.error = 'NO_SUCH_TABLE'; return null; }
      if (response.status === 400 || response.status === 422) {
        const smaller = LIMITS.find((limit) => limit < entry.limit);
        if (smaller) { entry.limit = smaller; continue; }
        entry.done = true; entry.error = `HTTP_${response.status}`; return null;
      }
      if (!response.ok) { entry.error = `HTTP_${response.status}`; return null; }
      let body: unknown;
      try { body = await response.json(); } catch { entry.error = 'BAD_JSON'; return null; }
      const data = body as Record<string, unknown>;
      const rows = Array.isArray(body) ? body : Array.isArray(data[table]) ? data[table] as unknown[]
        : Object.values(data).find(Array.isArray) as unknown[] | undefined ?? [];
      if (rows.length) await appendFile(join(this.dir, `${name}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      entry.rows += rows.length; entry.pages++; entry.error = null;
      const next = Array.isArray(body) ? null : data.next_from_id;
      entry.fromId = typeof next === 'number' && Number.isSafeInteger(next) && next > 0 ? next : null;
      if (!entry.fromId || !rows.length) { entry.done = true; return null; }
      if (entry.pages % 10 === 0) await this.save();
    }
  }

  async status() {
    if (!this.running) await this.load();
    let files: { name: string; bytes: number }[] = [];
    try {
      files = await Promise.all((await readdir(this.dir)).filter((name) => name.endsWith('.jsonl'))
        .map(async (name) => ({ name, bytes: (await stat(join(this.dir, name))).size })));
    } catch { /* nothing saved yet */ }
    const tables = Object.values(this.state);
    return { running: this.running, startedAt: this.startedAt, finishedAt: this.finishedAt, stopReason: this.stopReason,
      quotaRemaining: this.quotaRemaining, totalRows: tables.reduce((sum, item) => sum + item.rows, 0),
      tablesDone: tables.filter((item) => item.done).length,
      tablesTotal: Object.values(ARCHIVE_TABLES).reduce((sum, list) => sum + list.length, 0), tables: this.state, files };
  }

  /** A saved table file to download, or null. */
  async file(name: string) {
    if (!/^[A-Z]+_[a-z_]+\.jsonl$/.test(name)) return null;
    try { await stat(join(this.dir, name)); } catch { return null; }
    return createReadStream(join(this.dir, name));
  }
}
