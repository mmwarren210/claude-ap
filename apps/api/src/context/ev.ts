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
  /** Which app the line is on. */
  readonly app?: string;
  /** How the books' chance was found (see BookView.how). */
  readonly how?: 'EXACT' | 'BETWEEN' | 'FLOOR';
  /** The History Read on the same line, when it has one: the same history every tab uses. */
  readonly history?: { direction: string; score: number | null; text: string } | null;
  /** The break-even this pick was measured against (its app's easiest entry, and a pick's own payout boost). */
  readonly breakEven?: number;
}

/** The sportsbooks' no-vig view of one standard line: their average chance of MORE, and each book's. */
export interface BookView {
  readonly fairMore: number;
  readonly books: readonly { book: string; fairMore: number; overAmerican: number | null; underAmerican: number | null }[];
  /**
   * How the chance was found: the same number, between two numbers a book prices (estimated), or a floor for one side from
   * a harder number (a book's Over at 25.5 is the least the Over at 24.5 can be). Exact when absent.
   */
  readonly how?: 'EXACT' | 'BETWEEN' | 'FLOOR';
  /** For a FLOOR, the only side the chance is good for. */
  readonly side?: PlayableDirection;
}

/**
 * A book's no-vig chance of MORE at any number, from the numbers it prices for one player and stat: the same number;
 * else a straight line between the nearest numbers on each side (at most 3 units apart); else a floor for one side from
 * the nearest harder number (within 2 units).
 */
export function chanceAt(prices: readonly FairPrice[], threshold: number):
  { fairMore: number; how: 'EXACT' | 'BETWEEN' | 'FLOOR'; side?: PlayableDirection; price: FairPrice } | null {
  const exact = prices.find((price) => price.line === threshold);
  if (exact) return { fairMore: exact.fairOver, how: 'EXACT', price: exact };
  const below = prices.filter((price) => price.line < threshold).sort((a, b) => b.line - a.line)[0];
  const above = prices.filter((price) => price.line > threshold).sort((a, b) => a.line - b.line)[0];
  if (below && above && above.line - below.line <= 3) {
    const weight = (threshold - below.line) / (above.line - below.line);
    return { fairMore: Math.round((below.fairOver + (above.fairOver - below.fairOver) * weight) * 10_000) / 10_000, how: 'BETWEEN',
      price: weight < 0.5 ? below : above };
  }
  // A harder number for More sits above the line; for Less, below it.
  if (above && above.line - threshold <= 2) return { fairMore: above.fairOver, how: 'FLOOR', side: 'MORE', price: above };
  if (below && threshold - below.line <= 2) return { fairMore: below.fairOver, how: 'FLOOR', side: 'LESS', price: below };
  return null;
}

/**
 * Sportsbook prices for each standard, not-yet-started board line at the same sport, player, stat and exact number.
 * Goblins and Demons are left out: their numbers are moved on purpose, so a book's price at that number says little.
 */
export function bookViews(board: BoardResponse, prices: readonly FairPrice[], now: Date, nearby = false): Map<string, BookView> {
  const byKey = new Map<string, FairPrice[]>();
  for (const price of prices) {
    const key = JSON.stringify([price.sport, normalizedName(price.player), price.market, price.line]);
    byKey.set(key, [...byKey.get(key) ?? [], price]);
  }
  const views = new Map<string, BookView>();
  // Every number each book prices per player and stat, for nearby numbers.
  const ladders = new Map<string, FairPrice[]>();
  if (nearby) for (const price of prices) {
    const key = JSON.stringify([price.sport, normalizedName(price.player), price.market]);
    ladders.set(key, [...ladders.get(key) ?? [], price]);
  }
  for (const line of board.board.lines) {
    const start = Date.parse(line.eventStartTime);
    if (line.lineType !== 'REGULAR' || start <= now.getTime()) continue;
    if (nearby && !byKey.has(JSON.stringify([line.sport, normalizedName(line.playerName), line.market, line.threshold]))) {
      const game = (ladders.get(JSON.stringify([line.sport, normalizedName(line.playerName), line.market])) ?? [])
        .filter((price) => Math.abs(Date.parse(price.startTime) - start) <= 6 * 3600_000);
      const found = [...new Set(game.map((price) => price.book))].flatMap((book) => {
        const at = chanceAt(game.filter((price) => price.book === book), line.threshold);
        return at ? [{ book, ...at }] : [];
      });
      // Estimates between numbers first; a floor only when no book brackets the number, and all floors for the same side.
      const between = found.filter((item) => item.how === 'BETWEEN');
      const floors = found.filter((item) => item.how === 'FLOOR');
      const use = between.length ? between : floors.length && floors.every((item) => item.side === floors[0]!.side) ? floors : [];
      if (!use.length) continue;
      views.set(line.id, { fairMore: Math.round(use.reduce((sum, item) => sum + item.fairMore, 0) / use.length * 10_000) / 10_000,
        how: between.length ? 'BETWEEN' : 'FLOOR', ...(between.length ? {} : { side: use[0]!.side }),
        books: use.map((item) => ({ book: item.book, fairMore: item.fairMore, overAmerican: item.price.overAmerican,
          underAmerican: item.price.underAmerican })) });
      continue;
    }
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
  breakEven = DEFAULT_BREAK_EVEN, options: { nearby?: boolean; app?: string;
    /** A side's own payout on the app (Underdog and Pick6 multiply some picks): below 0.95 is left out, a boost lowers the bar. */
    multiplier?: (lineId: string, side: PlayableDirection) => number | null;
    history?: ReadonlyMap<string, { direction: string; score: number | null; text: string }> } = {}): EvPick[] {
  const lines = new Map(board.board.lines.map((line) => [line.id, line]));
  const analyses = new Map(board.analyses.map((item) => [item.lineId, item]));
  const picks: EvPick[] = [];
  for (const [lineId, view] of bookViews(board, prices, now, options.nearby)) {
    const line = lines.get(lineId)!;
    const best = line.availableDirections.filter((side) => !view.side || view.side === side).flatMap((side) => {
      const multiplier = options.multiplier?.(lineId, side) ?? 1;
      if (multiplier < 0.95) return [];
      const fair = side === 'MORE' ? view.fairMore : 1 - view.fairMore, bar = breakEven / Math.max(1, multiplier);
      return [{ side, fair, bar }];
    }).sort((a, b) => (b.fair - b.bar) - (a.fair - a.bar))[0];
    if (!best) continue;
    const analysis = analyses.get(lineId);
    const read = options.history?.get(lineId);
    picks.push({ lineId, playerName: line.playerName, sport: line.sport, market: line.market, threshold: line.threshold,
      side: best.side, eventStartTime: line.eventStartTime, fairProbability: Math.round(best.fair * 10_000) / 10_000,
      edge: Math.round((best.fair - best.bar) * 10_000) / 10_000, ...(options.app ? { app: options.app } : {}),
      how: view.how ?? 'EXACT', breakEven: Math.round(best.bar * 10_000) / 10_000,
      history: read && read.direction !== 'PASS' ? read : null,
      books: view.books.map((book) => ({ book: book.book,
        fair: best.side === 'MORE' ? book.fairMore : Math.round((1 - book.fairMore) * 10_000) / 10_000,
        overAmerican: book.overAmerican, underAmerican: book.underAmerican })),
      gkr: analysis ? { direction: analysis.direction, score: analysis.score } : null });
  }
  return picks.sort((a, b) => b.edge - a.edge);
}

/** A side the books back where GKR couldn't score: their no-vig chance must reach this (above PrizePicks' 54.2%). */
export const BOOKS_PICK_MIN = 0.56;
/** GKR could not score these lines (no model for the stat, or missing or stale data); a PASS on the merits is not one. */
const UNSCORED = new Set(['MODEL_SUPPORT_INCOMPLETE', 'STALE_OR_MISSING_EVIDENCE', 'INSUFFICIENT_MODEL_COVERAGE',
  'MODEL_CALIBRATION_UNAPPROVED']);

export interface BooksPick { readonly side: PlayableDirection; readonly fair: number; readonly books: number }

/**
 * Books picks (owner approved 2026-10-05): on a standard line GKR couldn't score, the side DraftKings and Hard Rock
 * back, when their average no-vig chance for it is at least BOOKS_PICK_MIN and the app offers that side. Shown with its
 * own Books label; never a GKR score and never changes one.
 */
export function booksPicks(board: BoardResponse, views: ReadonlyMap<string, BookView>, min = BOOKS_PICK_MIN): Map<string, BooksPick> {
  const lines = new Map(board.board.lines.map((line) => [line.id, line]));
  const analyses = new Map(board.analyses.map((item) => [item.lineId, item]));
  const picks = new Map<string, BooksPick>();
  for (const [lineId, view] of views) {
    const line = lines.get(lineId), analysis = analyses.get(lineId);
    if (!line || (analysis && (analysis.score !== null || !analysis.reasonCode || !UNSCORED.has(analysis.reasonCode)))) continue;
    const side: PlayableDirection = view.fairMore >= 0.5 ? 'MORE' : 'LESS';
    const fair = side === 'MORE' ? view.fairMore : Math.round((1 - view.fairMore) * 10_000) / 10_000;
    if (fair >= min && line.availableDirections.includes(side)) picks.set(lineId, { side, fair, books: view.books.length });
  }
  return picks;
}
