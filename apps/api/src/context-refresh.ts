import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ResearchAdapter } from '@crowniq/engine';
import type { BoardService, ContextRefreshReport } from './board-service.js';

/**
 * A per-day cap on paid lookups, saved to disk so a restart does not reset it.
 * Days are UTC calendar days.
 */
export class DailyLookupBudget {
  private state: { day: string; used: number } | null = null;
  constructor(private readonly file: string, readonly limit: number,
    private readonly clock: () => Date = () => new Date()) {}

  private today() { return this.clock().toISOString().slice(0, 10); }

  private async load() {
    if (this.state?.day === this.today()) return this.state;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { day?: unknown; used?: unknown };
      if (saved.day === this.today() && Number.isSafeInteger(saved.used))
        return this.state = { day: saved.day, used: Number(saved.used) };
    } catch { /* missing or unreadable: start the day at zero */ }
    return this.state = { day: this.today(), used: 0 };
  }

  /** Reserves one lookup. False once today's limit is reached. */
  async take(): Promise<boolean> {
    const state = await this.load();
    if (state.used >= this.limit) return false;
    state.used++;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, this.file);
    return true;
  }

  async used(): Promise<number> { return (await this.load()).used; }
}

export interface ContextRefreshOptions {
  readonly adapter: ResearchAdapter;
  readonly intervalMinutes: number;
  readonly windowHours: number;
}

/** Runs free context refresh ticks on an interval. A tick that would overlap other work is skipped. */
export class ContextRefreshScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly service: BoardService, private readonly options: ContextRefreshOptions) {}

  async tick(): Promise<ContextRefreshReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.service.refreshContext(this.options.adapter, { windowHours: this.options.windowHours });
    } catch {
      return null;
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer || this.options.intervalMinutes <= 0) return;
    this.timer = setInterval(() => { this.tick().catch(() => undefined); }, this.options.intervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
