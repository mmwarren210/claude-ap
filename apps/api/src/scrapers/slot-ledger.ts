import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Which scheduled pull slots (Eastern day, hour, source) already ran, saved to disk. A restart, or a new deployment
 * starting while the old one still runs, then never repeats a pull that already happened (each one costs money).
 * Read from disk on every claim, so two processes see each other's slots.
 */
export class SlotLedger {
  private memory = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string | null) {}

  /**
   * True when this slot was free and is now taken; false when it already ran. Claims run one at a time, so the line
   * scrapers and the context feeds (which share this ledger and tick in the same minute) never overwrite each other.
   */
  claim(day: string, slot: string): Promise<boolean> {
    const result = this.chain.then(() => this.claimNow(day, slot));
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async claimNow(day: string, slot: string): Promise<boolean> {
    const key = `${day}|${slot}`;
    if (!this.file) { if (this.memory.has(key)) return false; this.memory.add(key); return true; }
    let done: string[] = [];
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { day?: unknown; done?: unknown };
      // Keys carry their own day, so slots claimed ahead ("skip the next scheduled pull") survive; three days are kept.
      const keep = new Date(Date.parse(`${day}T12:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
      if (Array.isArray(saved.done)) done = saved.done.filter((item): item is string => typeof item === 'string' && item.slice(0, 10) >= keep);
    } catch { /* first slot of the day */ }
    if (done.includes(key)) return false;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ day, done: [...done, key] }));
    await rename(temporary, this.file);
    return true;
  }
}

const easternParts = (date: Date) => ({ day: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date),
  hour: Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(date)) });

/** The next scheduled run of a source after `now`: today's next Eastern hour on its schedule, else tomorrow's first. */
export function nextSlot(hoursEt: readonly number[], now: Date): { day: string; hour: number } | null {
  if (!hoursEt.length) return null;
  const today = easternParts(now), later = [...hoursEt].sort((a, b) => a - b).find((hour) => hour > today.hour);
  if (later !== undefined) return { day: today.day, hour: later };
  return { day: easternParts(new Date(now.getTime() + 24 * 3600_000)).day, hour: Math.min(...hoursEt) };
}
