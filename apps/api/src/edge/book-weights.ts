import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { devigPower, fitMean, learnBookWeights, profileFor, setLearnedBookWeights, varianceAt } from '@crowniq/edge';
import type { BookScore } from '@crowniq/edge';
import type { SnapshotRow, SnapshotStore } from './snapshots.js';

// Book weights learned from the snapshot store (spec §2.2). For each finished game, each book's main price three hours
// before the start is turned into an implied mean and compared with the closing consensus of the other books (leave one
// out), in SDs of the stat. `learnBookWeights` turns those errors into inverse-variance weights shrunk to the prior. Refit
// daily over the last 14 days, saved as edge-book-weights-v1.json and applied to every Edge price.

export const BOOK_WEIGHTS_VERSION = 1;

interface Price { at: number; number: number; side: string; price: number }

/**
 * A book's de-vigged main price at time `at`: the two-sided number whose fair over chance is closest to 50%. The store keeps
 * changes only, so a number the book has dropped still looks current. Only numbers seen within an hour of the book's
 * newest observation count.
 */
function mainAt(prices: readonly Price[], at: number): { number: number; over: number } | null {
  const latest = new Map<string, Price>();
  let newest = -Infinity;
  for (const price of prices) { if (price.at > at) break; latest.set(`${price.number}|${price.side}`, price); newest = price.at; }
  let best: { number: number; over: number } | null = null;
  for (const [key, over] of latest) {
    if (!key.endsWith('|MORE')) continue;
    const under = latest.get(`${over.number}|LESS`);
    if (!under || Math.max(over.at, under.at) < newest - 3600_000) continue;
    const fair = devigPower(over.price, under.price);
    if (!best || Math.abs(fair - .5) < Math.abs(best.over - .5)) best = { number: over.number, over: fair };
  }
  return best;
}

/** Scores every book on one game's player props: its implied mean `hoursBefore` the start vs the other books' close. */
export function scoreEvent(rows: readonly SnapshotRow[], hoursBefore = 3): BookScore[] {
  const groups = new Map<string, { sport: string; market: string; start: number; books: Map<string, Price[]> }>();
  for (const row of rows) {
    if (row.number === null || !row.price || row.price <= 1) continue;
    const key = `${row.playerKey}|${row.market}|${row.startTime}`;
    const group = groups.get(key) ?? { sport: row.playerKey.split('|')[0]!, market: row.market, start: Date.parse(row.startTime),
      books: new Map<string, Price[]>() };
    const list = group.books.get(row.platform) ?? [];
    list.push({ at: Date.parse(row.observedAt), number: row.number, side: row.side, price: row.price });
    group.books.set(row.platform, list); groups.set(key, group);
  }
  const scores: BookScore[] = [];
  for (const { sport, market, start, books } of groups.values()) {
    if (books.size < 3) continue;
    const profile = profileFor(sport, market);
    const implied = (main: { number: number; over: number } | null) =>
      main ? fitMean(profile.family, profile.variance, main.number, main.over, profile.discrete) : null;
    const close = new Map<string, number>(), early = new Map<string, number>();
    for (const [book, prices] of books) {
      prices.sort((a, b) => a.at - b.at);
      const atClose = implied(mainAt(prices, start - 60_000)), atEarly = implied(mainAt(prices, start - hoursBefore * 3600_000));
      if (atClose !== null) close.set(book, atClose);
      if (atEarly !== null) early.set(book, atEarly);
    }
    for (const [book, mean] of early) {
      const others = [...close].filter(([other]) => other !== book).map(([, value]) => value);
      if (others.length < 2) continue;
      const consensus = others.reduce((a, b) => a + b, 0) / others.length;
      const sd = Math.sqrt(varianceAt(profile.variance, consensus));
      if (sd > 0) scores.push({ book, sport, market, errorSd: (mean - consensus) / sd });
    }
  }
  return scores;
}

interface WeightsFile { version: number; fittedAt: string; scores: number; weights: Record<string, { weight: number; n: number; mse: number; prior: number }> }

export class BookWeightStore {
  private table: WeightsFile | null = null;
  private running = false;
  constructor(private readonly path: string | null, private readonly clock: () => Date = () => new Date(),
    /** More scores to fit with (each book's closing line against the actual stat, from PropLine). */
    private readonly extraScores: (() => Promise<readonly BookScore[]>) | null = null) {}

  /** Refits on the next pass (new accuracy scores arrived). */
  markDue(): void { if (this.table) this.table = { ...this.table, fittedAt: new Date(0).toISOString() }; }

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as WeightsFile;
      if (value.version === BOOK_WEIGHTS_VERSION && value.weights) { this.table = value; this.apply(); }
    } catch { /* first run */ }
  }

  private apply() {
    setLearnedBookWeights(new Map(Object.entries(this.table?.weights ?? {}).map(([key, value]) => [key, value.weight])));
  }

  due(): boolean {
    return !this.running && (!this.table || this.clock().getTime() - Date.parse(this.table.fittedAt) > 86_400_000);
  }

  /** Scores the last `days` days of finished games in the snapshot store and refits the weights. */
  async refit(snapshots: Pick<SnapshotStore, 'bookEvents' | 'bookRows'>, days = 14): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = this.clock().getTime();
      const events = snapshots.bookEvents(new Date(now - days * 86_400_000).toISOString(), new Date(now - 3600_000).toISOString());
      const scores: BookScore[] = [];
      for (const event of events) {
        await yieldToLoop();
        scores.push(...scoreEvent(snapshots.bookRows(event)));
      }
      scores.push(...await this.extraScores?.().catch(() => []) ?? []);
      const learned = learnBookWeights(scores);
      this.table = { version: BOOK_WEIGHTS_VERSION, fittedAt: new Date(now).toISOString(), scores: scores.length,
        weights: Object.fromEntries([...learned].map(([key, value]) => [key, { weight: round(value.weight), n: value.n, mse: round(value.mse), prior: value.prior }])) };
      this.apply();
      if (this.path) {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(`${this.path}.tmp`, JSON.stringify(this.table), { mode: 0o600 });
        await rename(`${this.path}.tmp`, this.path);
      }
      return learned.size;
    } finally { this.running = false; }
  }

  status() { return this.table; }
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;
