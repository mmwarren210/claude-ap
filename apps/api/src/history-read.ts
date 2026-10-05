import type { PropLine } from '@crowniq/contracts';

// History Read (owner, 2026-10-05): a free More/Less on any line with enough history, so Scout's paid research is saved
// for lines with none. It reads the player's last 15 results for the exact stat against the line (how often they went
// over, the average, how steady), blends in the sportsbooks' no-vig chance when one exists, and asks more of Goblins
// (moved easier on purpose). Shown labeled "History", never as a GKR score, and graded in its own record.

export interface HistoryRead {
  readonly direction: 'MORE' | 'LESS' | 'PASS';
  /** The chance (0-100) of the side it picks; null on PASS. */
  readonly score: number | null;
  readonly over: number; readonly under: number; readonly games: number;
  readonly average: number;
  /** The sportsbooks' no-vig chance of MORE, when blended in. */
  readonly books: number | null;
  readonly text: string;
  readonly source: string;
}

export const MIN_GAMES = 5;
/** The chance a side needs to be a play, by line type: Goblins are moved easier on purpose, so they need more. */
export const HISTORY_BAR: Readonly<Record<string, number>> = { REGULAR: 0.6, GOBLIN: 0.72, DEMON: 0.55 };

/**
 * The read for one line from the player's recent values (newest first). Null with fewer than five games. The chance of
 * MORE is the over rate with one game of doubt each way, averaged with the books' no-vig chance when there is one; a
 * side is a play only when that chance clears the bar and the average agrees with it.
 */
export function historyRead(line: Pick<PropLine, 'threshold' | 'lineType' | 'availableDirections'>, recent: readonly number[],
  booksMore: number | null, source: string): HistoryRead | null {
  const values = recent.filter((value) => Number.isFinite(value)).slice(0, 15);
  if (values.length < MIN_GAMES) return null;
  const over = values.filter((value) => value > line.threshold).length;
  const under = values.filter((value) => value < line.threshold).length;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const fromHistory = (over + 1) / (values.length + 2);
  const books = booksMore !== null && Number.isFinite(booksMore) && booksMore > 0 && booksMore < 1 ? booksMore : null;
  const more = books === null ? fromHistory : (fromHistory + books) / 2;
  const bar = HISTORY_BAR[line.lineType] ?? 0.6;
  const canMore = line.availableDirections.includes('MORE'), canLess = line.availableDirections.includes('LESS');
  const direction = canMore && more >= bar && average > line.threshold ? 'MORE'
    : canLess && 1 - more >= bar && average < line.threshold ? 'LESS' : 'PASS';
  const text = `Over in ${over} of last ${values.length} · avg ${average.toFixed(1)} vs ${line.threshold}` +
    (books === null ? '' : ` · books ${Math.round(books * 100)}% over`);
  return { direction, score: direction === 'PASS' ? null : Math.round((direction === 'MORE' ? more : 1 - more) * 100),
    over, under, games: values.length, average: Math.round(average * 10) / 10, books, text, source };
}

/** Where a player's recent values for a stat come from (CrownIQ's history, then the free public sources). */
export type HistoryValues = (line: PropLine) => Promise<{ values: number[]; source: string } | null>;

/** History Reads for many lines, each player and stat looked up once per ten minutes. */
export class HistoryReads {
  private cache = new Map<string, { until: number; value: Promise<{ values: number[]; source: string } | null> }>();
  constructor(private readonly lookup: HistoryValues, private readonly clock: () => Date = () => new Date()) {}

  private values(line: PropLine) {
    const key = `${line.sport}|${line.playerId}|${line.market}`, now = this.clock().getTime(), cached = this.cache.get(key);
    if (cached && cached.until > now) return cached.value;
    const value = this.lookup(line).catch(() => null);
    this.cache.set(key, { until: now + 10 * 60_000, value });
    if (this.cache.size > 20_000) this.cache.clear();
    return value;
  }

  /** Reads for the lines whose games haven't started (lines without enough history are left out). */
  async readsFor(lines: readonly PropLine[], booksMore: (lineId: string) => number | null = () => null) {
    const now = this.clock().getTime(), out = new Map<string, HistoryRead>();
    for (const line of lines) {
      if (Date.parse(line.eventStartTime) <= now) continue;
      const found = await this.values(line);
      const read = found ? historyRead(line, found.values, booksMore(line.id), found.source) : null;
      if (read) out.set(line.id, read);
    }
    return out;
  }
}
