import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * A per-UTC-day spending cap in USD, saved to disk so restarts do not reset it. It is re-read on every check, so a
 * second process (a deployment starting while the old one runs) sees what the other spent.
 */
export class DailySpendBudget {
  constructor(private readonly file: string, readonly limitUsd: number,
    private readonly clock: () => Date = () => new Date()) {}

  private today() { return this.clock().toISOString().slice(0, 10); }

  private async load(): Promise<{ day: string; spentUsd: number }> {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { day?: unknown; spentUsd?: unknown };
      if (saved.day === this.today() && typeof saved.spentUsd === 'number' && Number.isFinite(saved.spentUsd))
        return { day: saved.day, spentUsd: saved.spentUsd };
    } catch { /* missing or unreadable: the day starts at zero */ }
    return { day: this.today(), spentUsd: 0 };
  }

  async spent(): Promise<number> { return (await this.load()).spentUsd; }
  async remaining(): Promise<number> { return Math.max(0, this.limitUsd - await this.spent()); }

  async record(usd: number): Promise<void> {
    const state = await this.load();
    state.spentUsd = Math.round((state.spentUsd + Math.max(0, usd)) * 10_000) / 10_000;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, this.file);
  }
}
