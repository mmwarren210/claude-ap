import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ApifyClient } from '../scrapers/apify-client.js';
import type { DailySpendBudget } from '../scrapers/spend-budget.js';
import { SlotLedger } from '../scrapers/slot-ledger.js';

// Display-only game context from Apify scrapers: injury reports and Pinnacle game lines.
// None of it feeds GKR scoring; using any of it in a score needs the owner's approval and a new opt-in model version.

export interface InjuryNote {
  readonly league: string; readonly team: string; readonly teamAbbreviation: string | null;
  readonly player: string; readonly position: string | null; readonly status: string;
  readonly injury: string | null; readonly returnDate: string | null; readonly note: string | null;
  readonly reportedAt: string | null; readonly sourceUrl: string | null;
}
export interface GameLine {
  readonly league: string; readonly home: string; readonly away: string; readonly startTime: string;
  readonly market: 'moneyline' | 'spread' | 'total'; readonly line: number | null;
  readonly homePrice: number | null; readonly awayPrice: number | null;
  /** Pinnacle's no-vig win chance, 0–1. */
  readonly homeFair: number | null; readonly awayFair: number | null;
  readonly sourceUrl: string | null;
}
type FeedItem = InjuryNote | GameLine;

export interface ContextSource<T extends FeedItem = FeedItem> {
  readonly id: string;
  readonly actor: string;
  /** Most one run may charge; the run is skipped unless today's budget still has this much left. */
  readonly maxRunUsd: number;
  input(): unknown;
  read(row: unknown): T | null;
}

type Row = Record<string, unknown>;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const asRow = (value: unknown): Row | null => value && typeof value === 'object' ? value as Row : null;

export const injuryReports: ContextSource<InjuryNote> = {
  id: 'injuries', actor: 'lergassy/sports-injuries-api', maxRunUsd: 0.5,
  input: () => ({ mode: 'injuries', leagues: ['nfl', 'nba', 'mlb', 'nhl', 'wnba', 'ncaaf'], maxItems: 20_000 }),
  read(value) {
    const row = asRow(value), player = text(row?.player), team = text(row?.team), status = text(row?.status);
    if (!row || !player || !team || !status) return null;
    return { league: String(row.league ?? '').toUpperCase(), team, teamAbbreviation: text(row.teamAbbreviation), player,
      position: text(row.positionAbbreviation) ?? text(row.position), status, injury: text(row.injuryType),
      returnDate: text(row.returnDate), note: text(row.shortComment), reportedAt: text(row.reportedAt),
      sourceUrl: text(row.playerUrl) };
  },
};

export const pinnacleLines: ContextSource<GameLine> = {
  id: 'pinnacle', actor: 'lergassy/pinnacle-odds-api', maxRunUsd: 1.5,
  input: () => ({ mode: 'odds', daysAhead: 3, markets: ['moneyline', 'spread', 'total'], includeAlternateLines: false,
    leagues: ['nfl', 'ncaaf', 'nba', 'wnba', 'mlb', 'nhl', 'mls', 'epl', 'laliga', 'bundesliga', 'seriea', 'ligue1',
      'ucl', 'brasileirao', 'atp', 'wta'], maxItems: 5_000 }),
  read(value) {
    const row = asRow(value), market = row?.market;
    const home = text(row?.homeTeam), away = text(row?.awayTeam), start = text(row?.startTime);
    if (!row || !home || !away || !start || (market !== 'moneyline' && market !== 'spread' && market !== 'total')) return null;
    return { league: String(row.league ?? '').toUpperCase(), home, away, startTime: start, market, line: num(row.line),
      homePrice: num(row.homePrice), awayPrice: num(row.awayPrice), homeFair: num(row.homeFairProbability),
      awayFair: num(row.awayFairProbability), sourceUrl: text(row.sourceUrl) ?? text(row.espnLink) };
  },
};


export interface ContextScheduled { readonly source: ContextSource; readonly hoursEt: readonly number[] }
export interface ContextReport {
  readonly at: string; readonly source: string; readonly status: 'SUCCEEDED' | 'SKIPPED' | 'FAILED';
  readonly reason: string | null; readonly rows: number; readonly kept: number; readonly costUsd: number;
}
interface Snapshot { fetchedAt: string; items: FeedItem[] }

const easternHour = (date: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
  hour: 'numeric', hourCycle: 'h23' }).format(date));
const easternDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);

/**
 * Pulls the context feeds on their Eastern-time schedules under the shared daily scraper budget, and keeps the latest
 * successful snapshot of each (saved to disk). A failed or empty run keeps the previous snapshot.
 */
export class ContextFeeds {
  private snapshots = new Map<string, Snapshot>();
  private last = new Map<string, ContextReport>();
  private blankStreaks = new Map<string, number>();
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly apify: ApifyClient, private readonly budget: DailySpendBudget,
    private readonly sources: readonly ContextScheduled[], private readonly file: string | null,
    private readonly clock: () => Date = () => new Date(), private readonly slots = new SlotLedger(null)) {}

  private async load() {
    if (this.loaded || !this.file) { this.loaded = true; return; }
    this.loaded = true;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, Snapshot>;
      for (const [id, snapshot] of Object.entries(saved)) this.snapshots.set(id, snapshot);
    } catch { /* first run */ }
  }

  private async save() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.snapshots)));
    await rename(temporary, this.file);
  }

  async items<T extends FeedItem>(sourceId: string): Promise<{ fetchedAt: string | null; items: T[] }> {
    await this.load();
    const snapshot = this.snapshots.get(sourceId);
    return { fetchedAt: snapshot?.fetchedAt ?? null, items: (snapshot?.items ?? []) as T[] };
  }

  async status() {
    await this.load();
    return this.sources.map(({ source, hoursEt }) => ({ id: source.id, actor: source.actor, hoursEt,
      fetchedAt: this.snapshots.get(source.id)?.fetchedAt ?? null, items: this.snapshots.get(source.id)?.items.length ?? 0,
      last: this.last.get(source.id) ?? null, blankRunsInARow: this.blankStreaks.get(source.id) ?? 0 }));
  }

  async pull(sourceId: string): Promise<ContextReport> {
    await this.load();
    const at = this.clock().toISOString();
    const report = (fields: Partial<ContextReport>) => {
      const value: ContextReport = { at, source: sourceId, status: 'SKIPPED', reason: null, rows: 0, kept: 0, costUsd: 0,
        ...fields };
      this.last.set(sourceId, value);
      if (value.reason === 'NO_ROWS') this.blankStreaks.set(sourceId, (this.blankStreaks.get(sourceId) ?? 0) + 1);
      else if (value.status === 'SUCCEEDED') this.blankStreaks.set(sourceId, 0);
      return value;
    };
    const source = this.sources.find((item) => item.source.id === sourceId)?.source;
    if (!source) return report({ reason: 'UNKNOWN_SOURCE' });
    if (await this.budget.remaining() < source.maxRunUsd) return report({ reason: 'DAILY_BUDGET_REACHED' });
    let run;
    try { run = await this.apify.runActor(source.actor, source.input(), { maxChargeUsd: source.maxRunUsd }); }
    catch (error) { return report({ status: 'FAILED', reason: error instanceof Error ? error.message : 'APIFY_RUN_FAILED' }); }
    await this.budget.record(run.usageUsd);
    if (run.status !== 'SUCCEEDED' && run.status !== 'ABORTED' && run.status !== 'TIMED-OUT')
      return report({ status: 'FAILED', reason: 'RUN_' + run.status, costUsd: run.usageUsd });
    const rows = await this.apify.datasetItems(run.datasetId);
    const items = rows.flatMap((row) => { const item = source.read(row); return item ? [item] : []; });
    if (!items.length) return report({ status: 'FAILED', reason: 'NO_ROWS', rows: rows.length, costUsd: run.usageUsd });
    this.snapshots.set(source.id, { fetchedAt: at, items });
    await this.save();
    return report({ status: 'SUCCEEDED', reason: run.status === 'SUCCEEDED' ? null : 'RUN_' + run.status,
      rows: rows.length, kept: items.length, costUsd: run.usageUsd });
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Runs each feed once per scheduled Eastern-time hour; checks once a minute. */
  start(): void {
    if (this.timer || !this.sources.some(({ hoursEt }) => hoursEt.length)) return;
    this.timer = setInterval(() => { this.tick().catch(() => undefined); }, 60_000);
    this.timer.unref();
  }

  async tick(): Promise<ContextReport[]> {
    const now = this.clock(), hour = easternHour(now), day = easternDay(now), reports: ContextReport[] = [];
    for (const { source, hoursEt } of this.sources) {
      if (!hoursEt.includes(hour) || !await this.slots.claim(day, `${hour}|context:${source.id}`)) continue;
      reports.push(await this.pull(source.id));
    }
    return reports;
  }
}
