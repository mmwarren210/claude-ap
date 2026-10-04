import type { BoardResponse, PlayableDirection } from '@crowniq/contracts';
import { normalizedName } from './match.js';
import type { FairPrice } from './sharp-props.js';

/**
 * The chance each pick must hit to break even. PrizePicks' best Flex payouts (5 or 6 picks) need about 54.2% per pick;
 * a 2-pick Power play needs 57.7%. CrownIQ uses the lowest common bar and says so on screen.
 */
export const DEFAULT_BREAK_EVEN = 0.5421;

export interface EvPick {
  readonly lineId: string; readonly playerName: string; readonly sport: string; readonly market: string;
  readonly threshold: number; readonly side: PlayableDirection; readonly eventStartTime: string;
  /** Average no-vig chance across the sportsbooks that price this exact number, 0–1. */
  readonly fairProbability: number;
  /** fairProbability minus the break-even chance; positive means +EV. */
  readonly edge: number;
  readonly books: readonly { book: string; fair: number; overAmerican: number | null; underAmerican: number | null }[];
  /** What GKR says about the same line, for comparison only. */
  readonly gkr: { direction: string; score: number | null } | null;
}

/** The sportsbooks' no-vig view of one standard line: their average chance of MORE, and each book's. */
export interface BookView {
  readonly fairMore: number;
  readonly books: readonly { book: string; fairMore: number; overAmerican: number | null; underAmerican: number | null }[];
}

/**
 * Sportsbook prices for each standard, not-yet-started board line at the same sport, player, stat and exact number.
 * Goblins and Demons are left out: their numbers are moved on purpose, so a book's price at that number says little.
 */
export function bookViews(board: BoardResponse, prices: readonly FairPrice[], now: Date): Map<string, BookView> {
  const byKey = new Map<string, FairPrice[]>();
  for (const price of prices) {
    const key = JSON.stringify([price.sport, normalizedName(price.player), price.market, price.line]);
    byKey.set(key, [...byKey.get(key) ?? [], price]);
  }
  const views = new Map<string, BookView>();
  for (const line of board.board.lines) {
    const start = Date.parse(line.eventStartTime);
    if (line.lineType !== 'REGULAR' || start <= now.getTime()) continue;
    const matched = (byKey.get(JSON.stringify([line.sport, normalizedName(line.playerName), line.market, line.threshold])) ?? [])
      .filter((price) => Math.abs(Date.parse(price.startTime) - start) <= 6 * 3600_000);
    const books = [...new Map(matched.map((price) => [price.book, price])).values()];
    if (!books.length) continue;
    views.set(line.id, { fairMore: Math.round(books.reduce((sum, price) => sum + price.fairOver, 0) / books.length * 10_000) / 10_000,
      books: books.map((price) => ({ book: price.book, fairMore: price.fairOver, overAmerican: price.overAmerican,
        underAmerican: price.underAmerican })) });
  }
  return views;
}

/**
 * CrownIQ's own +EV: for each standard pick'em line, the sportsbooks' no-vig chance at the same player, stat and number,
 * compared with the break-even chance. Separate from GKR; it never changes a GKR score.
 */
export function evPicks(board: BoardResponse, prices: readonly FairPrice[], now: Date,
  breakEven = DEFAULT_BREAK_EVEN): EvPick[] {
  const lines = new Map(board.board.lines.map((line) => [line.id, line]));
  const analyses = new Map(board.analyses.map((item) => [item.lineId, item]));
  const picks: EvPick[] = [];
  for (const [lineId, view] of bookViews(board, prices, now)) {
    const line = lines.get(lineId)!;
    const best = line.availableDirections.map((side) => ({ side, fair: side === 'MORE' ? view.fairMore : 1 - view.fairMore }))
      .sort((a, b) => b.fair - a.fair)[0];
    if (!best) continue;
    const analysis = analyses.get(lineId);
    picks.push({ lineId, playerName: line.playerName, sport: line.sport, market: line.market, threshold: line.threshold,
      side: best.side, eventStartTime: line.eventStartTime, fairProbability: Math.round(best.fair * 10_000) / 10_000,
      edge: Math.round((best.fair - breakEven) * 10_000) / 10_000,
      books: view.books.map((book) => ({ book: book.book,
        fair: best.side === 'MORE' ? book.fairMore : Math.round((1 - book.fairMore) * 10_000) / 10_000,
        overAmerican: book.overAmerican, underAmerican: book.underAmerican })),
      gkr: analysis ? { direction: analysis.direction, score: analysis.score } : null });
  }
  return picks.sort((a, b) => b.edge - a.edge);
}
