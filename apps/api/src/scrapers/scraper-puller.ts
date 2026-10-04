import type { ApifyClient } from './apify-client.js';
import type { IngestReport, ScrapedLineStore } from './line-store.js';
import type { ScraperSource } from './scraped-line.js';
import type { DailySpendBudget } from './spend-budget.js';
import { SlotLedger } from './slot-ledger.js';

export interface PullReport {
  readonly at: string;
  readonly source: string;
  readonly status: 'SUCCEEDED' | 'SKIPPED' | 'FAILED';
  readonly reason: string | null;
  readonly rows: number;
  /** True when the run hit the actor's own row cap, so part of the board may be missing. */
  readonly truncated: boolean;
  readonly costUsd: number;
  readonly skipped: Record<string, number>;
  readonly ingest: IngestReport | null;
}

export interface ScheduledSource {
  readonly source: ScraperSource;
  /** Eastern-time hours (0–23) when this source pulls. */
  readonly hoursEt: readonly number[];
}

export interface PullerOptions {
  /** Most one run may cost; also what must be left in today's budget to start one. */
  readonly maxRunUsd: number;
  /** Saved record of scheduled slots already run, so restarts and overlapping deployments never repeat one. */
  readonly slots?: SlotLedger;
}

const easternHour = (date: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
  hour: 'numeric', hourCycle: 'h23' }).format(date));
const easternDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);

/**
 * Runs each scraper on its own Eastern-time schedule under one shared daily spend cap, and stores
 * what they return. A run that fails or returns nothing changes no lines.
 */
export class ScraperPuller {
  private last = new Map<string, PullReport>();
  /** Back-to-back runs that returned no rows, per source: a sign the scraper broke. */
  private blankStreaks = new Map<string, number>();
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private onLinesChanged: (() => unknown) | null = null;

  constructor(private readonly apify: ApifyClient, private readonly store: ScrapedLineStore,
    private readonly budget: DailySpendBudget, private readonly sources: readonly ScheduledSource[],
    private readonly options: PullerOptions, private readonly clock: () => Date = () => new Date()) {
    this.slots = options.slots ?? new SlotLedger(null);
  }
  private readonly slots: SlotLedger;

  /** What to do after a pull changes lines: the server rebuilds the board from the store (free). */
  whenLinesChange(callback: () => unknown): void { this.onLinesChanged = callback; }

  hasSource(sourceId: string): boolean { return this.sources.some(({ source }) => source.id === sourceId); }

  async status() {
    return { spentTodayUsd: await this.budget.spent(), dailyLimitUsd: this.budget.limitUsd, maxRunUsd: this.options.maxRunUsd,
      sources: this.sources.map(({ source, hoursEt }) => ({ id: source.id, actor: source.actor, apps: source.apps, hoursEt,
        last: this.last.get(source.id) ?? null, blankRunsInARow: this.blankStreaks.get(source.id) ?? 0 })) };
  }

  /** Pull one source now (or every source when none is named). */
  async pullAll(): Promise<PullReport[]> {
    const reports: PullReport[] = [];
    for (const { source } of this.sources) reports.push(await this.pull(source.id));
    return reports;
  }

  async pull(sourceId: string): Promise<PullReport> {
    const scheduled = this.sources.find(({ source }) => source.id === sourceId);
    const at = this.clock().toISOString();
    const report = (fields: Partial<PullReport>): PullReport => {
      const value: PullReport = { at, source: sourceId, status: 'SKIPPED', reason: null, rows: 0, truncated: false,
        costUsd: 0, skipped: {}, ingest: null, ...fields };
      this.last.set(sourceId, value);
      if (value.reason === 'NO_ROWS') this.blankStreaks.set(sourceId, (this.blankStreaks.get(sourceId) ?? 0) + 1);
      else if (value.status === 'SUCCEEDED') this.blankStreaks.set(sourceId, 0);
      return value;
    };
    if (!scheduled) return report({ reason: 'UNKNOWN_SOURCE' });
    const { source } = scheduled;
    if (this.running.has(sourceId)) return report({ reason: 'PULL_RUNNING' });
    // Apify runs spend from the shared daily USD cap; other sources spend their own credits (with their own guards).
    if (source.actor && await this.budget.remaining() < this.options.maxRunUsd) return report({ reason: 'DAILY_BUDGET_REACHED' });
    this.running.add(sourceId);
    try {
      let rows: unknown[], costUsd = 0, capped = false;
      if (source.actor) {
        let run;
        try {
          run = await this.apify.runActor(source.actor, source.input(), { maxChargeUsd: this.options.maxRunUsd });
        } catch (error) {
          return report({ status: 'FAILED', reason: error instanceof Error ? error.message : 'APIFY_RUN_FAILED' });
        }
        await this.budget.record(run.usageUsd);
        costUsd = run.usageUsd;
        // A run stopped at our spend cap still saved what it got; use it, but never as a complete board.
        capped = run.status === 'ABORTED' || run.status === 'TIMED-OUT';
        if (run.status !== 'SUCCEEDED' && !capped)
          return report({ status: 'FAILED', reason: 'RUN_' + run.status, costUsd });
        rows = await this.apify.datasetItems(run.datasetId);
      } else if (source.run) {
        try { const fetched = await source.run(); rows = fetched.rows; capped = !fetched.complete; }
        catch (error) { return report({ status: 'FAILED', reason: error instanceof Error ? error.message : 'SOURCE_FAILED' }); }
      } else {
        return report({ status: 'FAILED', reason: 'SOURCE_HAS_NO_FETCH' });
      }
      const run = { usageUsd: costUsd, status: capped ? 'ABORTED' : 'SUCCEEDED' };
      if (!rows.length) return report({ status: 'FAILED', reason: 'NO_ROWS', costUsd: run.usageUsd });
      const now = this.clock(), skipped: Record<string, number> = {};
      const lines = rows.flatMap((row) => {
        const result = source.read(row, now);
        if ('skip' in result) { skipped[result.skip] = (skipped[result.skip] ?? 0) + 1; return []; }
        return [result.line];
      });
      const truncated = capped || (source.rowCap !== null && rows.length >= source.rowCap);
      // A cut-short pull cannot prove a line was taken down, so it only adds and updates.
      const ingest = await this.store.ingest(source.id, lines, { complete: !truncated, apps: source.apps });
      const result = report({ status: 'SUCCEEDED', reason: capped ? 'RUN_' + run.status : null, rows: rows.length,
        truncated, costUsd: run.usageUsd, skipped, ingest });
      if (ingest.added || ingest.moved || ingest.removed) {
        try { await this.onLinesChanged?.(); } catch { /* the stored lines stay; the next pull retries */ }
      }
      return result;
    } finally {
      this.running.delete(sourceId);
    }
  }

  /** Runs each source once per scheduled Eastern-time hour; checks once a minute. */
  start(): void {
    if (this.timer || !this.sources.some(({ hoursEt }) => hoursEt.length)) return;
    this.timer = setInterval(() => { this.tick().catch(() => undefined); }, 60_000);
    this.timer.unref();
  }

  async tick(): Promise<PullReport[]> {
    const now = this.clock(), hour = easternHour(now), day = easternDay(now);
    const due = this.sources.filter(({ hoursEt }) => hoursEt.includes(hour));
    const reports: PullReport[] = [];
    for (const { source } of due) {
      if (!await this.slots.claim(day, `${hour}|${source.id}`)) continue;
      reports.push(await this.pull(source.id));
    }
    return reports;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
