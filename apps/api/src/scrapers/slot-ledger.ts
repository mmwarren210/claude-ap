import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Which scheduled pull slots (Eastern day, hour, source) already ran, saved to disk. A restart, or a new deployment
 * starting while the old one still runs, then never repeats a pull that already happened (each one costs money).
 * Read from disk on every claim, so two processes see each other's slots.
 */
export class SlotLedger {
  private memory = new Set<string>();
  constructor(private readonly file: string | null) {}

  /** True when this slot was free and is now taken; false when it already ran. */
  async claim(day: string, slot: string): Promise<boolean> {
    const key = `${day}|${slot}`;
    if (!this.file) { if (this.memory.has(key)) return false; this.memory.add(key); return true; }
    let done: string[] = [];
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { day?: unknown; done?: unknown };
      if (saved.day === day && Array.isArray(saved.done)) done = saved.done.filter((item): item is string => typeof item === 'string');
    } catch { /* first slot of the day */ }
    if (done.includes(key)) return false;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ day, done: [...done, key] }));
    await rename(temporary, this.file);
    return true;
  }
}
