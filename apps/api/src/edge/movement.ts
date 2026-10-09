import { fitMean, profileFor, varianceAt } from '@crowniq/edge';
import type { FairPrice } from '../context/sharp-props.js';
import { canonicalMarket, playerKey } from './market-map.js';

// Edge 2.0 movement intelligence (spec §3.1): each sportsbook's implied mean for a player and stat, compared across
// SharpAPI refreshes. A move is a change of at least 0.25 SD; steam is 3+ books moving the same way within 10 minutes
// (with 15-minute refreshes, the same refresh). The newest move tells the stale-line check (§3.2) when the books last
// repriced a player.

export interface BookMove { readonly book: string; readonly at: number; readonly deltaSd: number }
export interface MoveSummary {
  readonly lastMoveAt: number; readonly direction: 'UP' | 'DOWN'; readonly books: number; readonly steam: boolean;
  readonly firstMover: string;
}

const MOVE_SD = .25, STEAM_BOOKS = 3, STEAM_WINDOW = 10 * 60_000, KEEP = 3 * 3600_000;

export const moveKey = (sport: string, player: string, market: string) => `${playerKey(sport, player)}|${canonicalMarket(sport, market)}`;

export class MovementTracker {
  private last = new Map<string, { mean: number; sd: number }>();
  private moves = new Map<string, BookMove[]>();

  /** One SharpAPI refresh: records each book's move since its previous price for the same player and stat. */
  observe(prices: readonly FairPrice[], at: number): number {
    const seen = new Map<string, { mean: number; sd: number; key: string; book: string; weight: number }>();
    for (const price of prices) {
      if (price.stale) continue;
      const key = moveKey(price.sport, price.player, price.market), bookKey = `${key}|${price.book}`;
      const profile = profileFor(price.sport, price.market);
      const mean = fitMean(profile.family, profile.variance, price.line, price.fairOver, profile.discrete);
      // A book posts many rungs; the one nearest its own 50/50 is its main line.
      const weight = Math.abs(price.fairOver - .5);
      const existing = seen.get(bookKey);
      if (!existing || weight < existing.weight)
        seen.set(bookKey, { mean, sd: Math.sqrt(varianceAt(profile.variance, mean)), key, book: price.book, weight });
    }
    let recorded = 0;
    for (const [bookKey, now] of seen) {
      const before = this.last.get(bookKey);
      this.last.set(bookKey, { mean: now.mean, sd: now.sd });
      if (!before) continue;
      const deltaSd = (now.mean - before.mean) / Math.max(now.sd, 1e-6);
      if (Math.abs(deltaSd) < MOVE_SD) continue;
      const list = (this.moves.get(now.key) ?? []).filter((move) => at - move.at <= KEEP);
      list.push({ book: now.book, at, deltaSd });
      this.moves.set(now.key, list);
      recorded++;
    }
    return recorded;
  }

  /** PropLine's steam alerts (pushed; it watches 30+ books), newest first, for the owner page. */
  readonly pushedSteam: { at: string; sport: string; player: string; market: string; direction: 'UP' | 'DOWN'; books: number; score: number | null }[] = [];

  /**
   * A PropLine steam delivery for a player prop: recorded as each agreeing book's move, so the steam badge and the
   * stale-line check treat it exactly like steam CrownIQ saw itself.
   */
  pushSteam(event: { sport: string; player: string; market: string; direction: 'UP' | 'DOWN'; books: readonly string[]; at: number; score?: number | null }): void {
    if (!event.player || event.books.length < 1) return;
    const key = moveKey(event.sport, event.player, event.market);
    const list = (this.moves.get(key) ?? []).filter((move) => event.at - move.at <= KEEP);
    const deltaSd = event.direction === 'UP' ? MOVE_SD + .05 : -(MOVE_SD + .05);
    for (const book of new Set(event.books)) list.push({ book: `propline:${book}`, at: event.at, deltaSd });
    this.moves.set(key, list);
    this.pushedSteam.unshift({ at: new Date(event.at).toISOString(), sport: event.sport, player: event.player, market: event.market,
      direction: event.direction, books: new Set(event.books).size, score: event.score ?? null });
    this.pushedSteam.length = Math.min(this.pushedSteam.length, 50);
  }

  /** The newest move for a player and stat in the last 3 hours, with steam when 3+ books moved together. */
  summary(sport: string, player: string, market: string, nowMs: number): MoveSummary | null {
    const list = (this.moves.get(moveKey(sport, player, market)) ?? []).filter((move) => nowMs - move.at <= KEEP);
    if (!list.length) return null;
    const newest = list.reduce((best, move) => move.at > best.at ? move : best);
    const direction = newest.deltaSd > 0 ? 'UP' : 'DOWN';
    const together = list.filter((move) => Math.abs(move.at - newest.at) <= STEAM_WINDOW && Math.sign(move.deltaSd) === Math.sign(newest.deltaSd));
    const first = [...together].sort((a, b) => a.at - b.at)[0]!;
    return { lastMoveAt: newest.at, direction, books: new Set(together.map((move) => move.book)).size,
      steam: new Set(together.map((move) => move.book)).size >= STEAM_BOOKS, firstMover: first.book };
  }

  status() { return { tracked: this.last.size, moving: this.moves.size }; }
}
