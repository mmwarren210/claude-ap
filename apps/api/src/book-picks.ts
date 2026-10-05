import type { Analysis, PlayableDirection, PropLine } from '@crowniq/contracts';
import { normalizedName } from './context/match.js';
import type { FairPrice } from './context/sharp-props.js';

// Sportsbook picks (DraftKings, Hard Rock): GKR on each book's player-prop line, at the book's own number, on the
// research of the same player and stat on the PrizePicks board (the same way GKR scores Underdog and Pick6 lines).
// Only lines GKR picks a side on are kept; a PASS never shows.

export const sportsbooks = ['draftkings', 'hardrock'] as const;
export type Sportsbook = typeof sportsbooks[number];
export const sportsbookNames: Readonly<Record<Sportsbook, string>> = { draftkings: 'DraftKings', hardrock: 'Hard Rock' };

export interface BookPick {
  readonly id: string; readonly book: Sportsbook; readonly sport: string; readonly league: string;
  readonly playerName: string; readonly team: string | null; readonly opponent: string | null;
  readonly eventName: string; readonly eventStartTime: string; readonly market: string; readonly line: number;
  readonly side: PlayableDirection; readonly gkr: { readonly score: number; readonly modelVersion: string };
  /** The book's price on GKR's side, and the chance that price implies (vig included). */
  readonly american: number | null; readonly impliedChance: number | null;
  /** The book's no-vig chance of GKR's side. */
  readonly fairChance: number;
  /** The other book's price on the same side and number, for line shopping. */
  readonly otherBook: { readonly book: Sportsbook; readonly american: number | null } | null;
  /** The PrizePicks line for the same player and stat, for comparison. */
  readonly prizePicks: { readonly line: number; readonly gkr: { readonly direction: string; readonly score: number | null } | null } | null;
}

export const impliedChance = (american: number | null) => american === null ? null
  : Math.round((american < 0 ? -american / (-american + 100) : 100 / (american + 100)) * 10_000) / 10_000;

const dayKey = (iso: string) => iso.slice(0, 10);

/**
 * The best GKR picks on one book: for each player and stat the book prices, GKR's side at the book's number when it
 * picks one. One pick per player and stat (the highest score), strongest first.
 */
export function bookPicks(book: Sportsbook, prices: readonly FairPrice[], boardLines: readonly PropLine[],
  analyses: ReadonlyMap<string, Analysis>, scoreLines: (lines: readonly PropLine[]) => Analysis[], now: Date): BookPick[] {
  const byPlayer = new Map<string, PropLine[]>();
  for (const line of boardLines) {
    const key = JSON.stringify([line.sport, normalizedName(line.playerName), line.market]);
    byPlayer.set(key, [...byPlayer.get(key) ?? [], line]);
  }
  const others = new Map(prices.filter((price) => price.book !== book).map((price) =>
    [JSON.stringify([price.sport, normalizedName(price.player), price.market, price.line, dayKey(price.startTime)]), price]));
  const pairs = prices.flatMap((price) => {
    const start = Date.parse(price.startTime);
    if (price.book !== book || start <= now.getTime()) return [];
    // The PrizePicks line for the same player and stat in the same game (within 6 hours): standard first, then closest.
    const research = (byPlayer.get(JSON.stringify([price.sport, normalizedName(price.player), price.market])) ?? [])
      .filter((line) => Math.abs(Date.parse(line.eventStartTime) - start) <= 6 * 3600_000)
      .sort((a, b) => Number(b.lineType === 'REGULAR') - Number(a.lineType === 'REGULAR') ||
        Math.abs(a.threshold - price.line) - Math.abs(b.threshold - price.line))[0];
    if (!research) return [];
    const id = `${book}:${research.eventId}:${research.playerId}:${price.market}:${price.line}`;
    const { payoutMultiplier: _payout, ...base } = research;
    const line: PropLine = { ...base, id, sourceLineId: id, threshold: price.line, availableDirections: ['MORE', 'LESS'],
      lineType: 'REGULAR' };
    return [{ price, research, line }];
  });
  const scored = scoreLines(pairs.map((pair) => pair.line));
  const best = new Map<string, BookPick>();
  pairs.forEach(({ price, research, line }, index) => {
    const analysis = scored[index];
    if (!analysis || analysis.direction === 'PASS' || analysis.score === null || !analysis.modelVersion) return;
    const side = analysis.direction, american = side === 'MORE' ? price.overAmerican : price.underAmerican;
    const other = others.get(JSON.stringify([price.sport, normalizedName(price.player), price.market, price.line, dayKey(price.startTime)]));
    const reference = analyses.get(research.id);
    const pick: BookPick = { id: line.id, book, sport: research.sport, league: research.league, playerName: research.playerName,
      team: research.team ?? null, opponent: research.opponent ?? null, eventName: research.eventName,
      eventStartTime: research.eventStartTime, market: price.market, line: price.line, side,
      gkr: { score: analysis.score, modelVersion: analysis.modelVersion }, american, impliedChance: impliedChance(american),
      fairChance: Math.round((side === 'MORE' ? price.fairOver : 1 - price.fairOver) * 10_000) / 10_000,
      otherBook: other ? { book: other.book as Sportsbook, american: side === 'MORE' ? other.overAmerican : other.underAmerican } : null,
      prizePicks: { line: research.threshold, gkr: reference ? { direction: reference.direction, score: reference.score } : null } };
    const key = `${research.eventId}|${research.playerId}|${price.market}`, current = best.get(key);
    if (!current || pick.gkr.score > current.gkr.score) best.set(key, pick);
  });
  return [...best.values()].sort((a, b) => b.gkr.score - a.gkr.score);
}
