import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The Eastern calendar day ("2026-10-04"), which is the day the owner means. */
export const easternDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);
/** Midnight Eastern at the start of the date's Eastern day. */
export function easternMidnight(date: Date): Date {
  const day = easternDay(date);
  // Eastern is UTC-4 or UTC-5; try both and keep the one that falls on this Eastern day at 00:00.
  for (const offset of [4, 5]) {
    const candidate = new Date(`${day}T${String(offset).padStart(2, '0')}:00:00.000Z`);
    if (easternDay(candidate) === day && easternDay(new Date(candidate.getTime() - 1)) !== day) return candidate;
  }
  return new Date(`${day}T05:00:00.000Z`);
}

/**
 * A per-Eastern-day spending cap in USD, saved to disk so restarts do not reset it. It is re-read on every check, so a
 * second process (a deployment starting while the old one runs) sees what the other spent. When the account's real
 * spend is available (Apify's own run charges since midnight Eastern), the higher of the two counts.
 */
export class DailySpendBudget {
  private actualCache: { at: number; day: string; usd: number } | null = null;
  constructor(private readonly file: string, readonly limitUsd: number,
    private readonly clock: () => Date = () => new Date(),
    private readonly actual: ((since: Date) => Promise<number>) | null = null) {}

  private today() { return easternDay(this.clock()); }

  /** The account's real spend today, re-read at most every 5 minutes; null when it can't be read. */
  private async actualToday(): Promise<number | null> {
    if (!this.actual) return null;
    const now = this.clock(), day = this.today();
    if (this.actualCache && this.actualCache.day === day && now.getTime() - this.actualCache.at < 5 * 60_000) return this.actualCache.usd;
    try {
      const usd = await this.actual(easternMidnight(now));
      this.actualCache = { at: now.getTime(), day, usd };
      return usd;
    } catch { return this.actualCache?.day === day ? this.actualCache.usd : null; }
  }

  private async load(): Promise<{ day: string; spentUsd: number }> {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { day?: unknown; spentUsd?: unknown };
      if (saved.day === this.today() && typeof saved.spentUsd === 'number' && Number.isFinite(saved.spentUsd))
        return { day: saved.day, spentUsd: saved.spentUsd };
    } catch { /* missing or unreadable: the day starts at zero */ }
    return { day: this.today(), spentUsd: 0 };
  }

  async spent(): Promise<number> {
    const local = (await this.load()).spentUsd, actual = await this.actualToday();
    return Math.max(local, actual ?? 0);
  }
  async remaining(): Promise<number> { return Math.max(0, this.limitUsd - await this.spent()); }

  private chain: Promise<unknown> = Promise.resolve();

  /** Adds a charge. Recordings run one at a time so two pulls finishing together never lose one. */
  record(usd: number): Promise<void> {
    const result = this.chain.then(() => this.recordNow(usd));
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async recordNow(usd: number): Promise<void> {
    const state = await this.load();
    state.spentUsd = Math.round((state.spentUsd + Math.max(0, usd)) * 10_000) / 10_000;
    // The run's charge is now in Apify's total too; the next check re-reads it.
    this.actualCache = null;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, this.file);
  }
}
