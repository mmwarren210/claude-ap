import type { ApifyClient } from './apify-client.js';
import type { IngestReport, ScrapedLineStore } from './line-store.js';
import { LERGASSY_ACTOR, lergassyInput, readLergassyRow } from './lergassy.js';
import type { SkipReason } from './lergassy.js';
import type { DailySpendBudget } from './spend-budget.js';

export interface PullReport {
  readonly at: string;
  readonly actor: string;
  readonly status: 'SUCCEEDED' | 'SKIPPED' | 'FAILED';
  readonly reason: string | null;
  readonly rows: number;
  /** True when the run hit its row cap, so part of the board may be missing. */
  readonly truncated: boolean;
  readonly costUsd: number;
  readonly skipped: Partial<Record<SkipReason, number>>;
  readonly ingest: IngestReport | null;
}

export interface PullerOptions {
  readonly maxRows: number;
  /** Most one run may cost; also the amount that must be left in today's budget to start one. */
  readonly maxRunUsd: number;
  /** Eastern-time hours (0–23) when scheduled pulls run. */
  readonly hoursEt: readonly number[];
}

const easternHour = (date: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
  hour: 'numeric', hourCycle: 'h23' }).format(date));
const easternDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);

/**
 * Runs the PrizePicks + Underdog scraper on a schedule and under a daily spend cap, then stores
 * what it returns. A run that fails or returns nothing changes no lines.
 */
export class ScraperPuller {
  private last: PullReport | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private slotsDone = new Set<string>();
  private onLinesChanged: (() => unknown) | null = null;

  constructor(private readonly apify: ApifyClient, private readonly store: ScrapedLineStore,
    private readonly budget: DailySpendBudget, private readonly options: PullerOptions,
    private readonly clock: () => Date = () => new Date()) {}

  /** What to do after a pull changes lines: the server rebuilds the board from the store (free). */
  whenLinesChange(callback: () => unknown): void { this.onLinesChanged = callback; }

  async status() {
    return { last: this.last, spentTodayUsd: await this.budget.spent(), dailyLimitUsd: this.budget.limitUsd,
      hoursEt: this.options.hoursEt, maxRows: this.options.maxRows };
  }

  async pull(): Promise<PullReport> {
    const at = this.clock().toISOString();
    const report = (fields: Partial<PullReport>): PullReport => this.last = { at, actor: LERGASSY_ACTOR, status: 'SKIPPED',
      reason: null, rows: 0, truncated: false, costUsd: 0, skipped: {}, ingest: null, ...fields };
    if (this.running) return report({ reason: 'PULL_RUNNING' });
    if (await this.budget.remaining() < this.options.maxRunUsd) return report({ reason: 'DAILY_BUDGET_REACHED' });
    this.running = true;
    try {
      let run;
      try {
        run = await this.apify.runActor(LERGASSY_ACTOR, lergassyInput(this.options.maxRows),
          { maxChargeUsd: this.options.maxRunUsd, maxItems: this.options.maxRows });
      } catch (error) {
        return report({ status: 'FAILED', reason: error instanceof Error ? error.message : 'APIFY_RUN_FAILED' });
      }
      await this.budget.record(run.usageUsd);
      if (run.status !== 'SUCCEEDED') return report({ status: 'FAILED', reason: 'RUN_' + run.status, costUsd: run.usageUsd });
      const rows = await this.apify.datasetItems(run.datasetId);
      if (!rows.length) return report({ status: 'FAILED', reason: 'NO_ROWS', costUsd: run.usageUsd });
      const now = this.clock(), skipped: Partial<Record<SkipReason, number>> = {};
      const lines = rows.flatMap((row) => {
        const result = readLergassyRow(row, now);
        if ('skip' in result) { skipped[result.skip] = (skipped[result.skip] ?? 0) + 1; return []; }
        return [result.line];
      });
      const truncated = rows.length >= this.options.maxRows;
      // A cut-short pull cannot prove a line was taken down, so it only adds and updates.
      const ingest = await this.store.ingest(LERGASSY_ACTOR, lines, { complete: !truncated, apps: ['prizepicks', 'underdog'] });
      const result = report({ status: 'SUCCEEDED', rows: rows.length, truncated, costUsd: run.usageUsd, skipped, ingest });
      if (ingest.added || ingest.moved || ingest.removed) {
        try { await this.onLinesChanged?.(); } catch { /* the stored lines stay; the next pull retries */ }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Runs one pull per scheduled Eastern-time hour; checks once a minute. */
  start(): void {
    if (this.timer || !this.options.hoursEt.length) return;
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.timer.unref();
  }

  async tick(): Promise<PullReport | null> {
    const now = this.clock(), hour = easternHour(now), slot = `${easternDay(now)}|${hour}`;
    if (!this.options.hoursEt.includes(hour) || this.slotsDone.has(slot)) return null;
    this.slotsDone.add(slot);
    return this.pull();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
