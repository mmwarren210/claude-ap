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
  /** The price needs 60% or more to break even (-150 or steeper): labeled, never hidden (owner, 2026-10-05). */
  readonly pricey: boolean;
  /** The book's no-vig chance of GKR's side. */
  readonly fairChance: number;
  /** The other book's price on the same side and number, for line shopping. */
  readonly otherBook: { readonly book: Sportsbook; readonly american: number | null } | null;
  /** The PrizePicks line for the same player and stat, for comparison. */
  readonly prizePicks: { readonly line: number; readonly lineType: string; readonly sides: readonly PlayableDirection[];
    readonly gkr: { readonly direction: string; readonly score: number | null; readonly reasonCode: string | null } | null } | null;
}

/** A price that needs this win rate or more to break even is labeled pricey. */
export const PRICEY = 0.6;
export const impliedChance = (american: number | null) => american === null ? null
  : Math.round((american < 0 ? -american / (-american + 100) : 100 / (american + 100)) * 10_000) / 10_000;

const dayKey = (iso: string) => iso.slice(0, 10);
const statKey = (price: FairPrice) => JSON.stringify([price.book, price.sport, normalizedName(price.player), price.market,
  dayKey(price.startTime)]);

/**
 * Each book's main line per player and stat: the number whose no-vig chance is closest to 50/50. Books that post a ladder
 * of alternate numbers (Hard Rock) would otherwise put the easiest number of the ladder on the picks tab.
 */
export function mainLines(prices: readonly FairPrice[]): FairPrice[] {
  const best = new Map<string, FairPrice>();
  for (const price of prices) {
    const key = statKey(price), current = best.get(key);
    if (!current || Math.abs(price.fairOver - 0.5) < Math.abs(current.fairOver - 0.5)) best.set(key, price);
  }
  return [...best.values()];
}

/**
 * The best GKR picks on one book: for each player and stat the book prices, GKR's side at the book's number when it
 * picks one. One pick per player and stat (the highest score), strongest first.
 */
export function bookPicks(book: Sportsbook, prices: readonly FairPrice[], boardLines: readonly PropLine[],
  analyses: ReadonlyMap<string, Analysis>, scoreLines: (lines: readonly PropLine[]) => Analysis[], now: Date,
  counts?: Record<string, number>, linesOut?: Map<string, PropLine>): BookPick[] {
  const byPlayer = new Map<string, PropLine[]>();
  for (const line of boardLines) {
    const key = JSON.stringify([line.sport, normalizedName(line.playerName), line.market]);
    byPlayer.set(key, [...byPlayer.get(key) ?? [], line]);
  }
  const others = new Map(prices.filter((price) => price.book !== book).map((price) =>
    [JSON.stringify([price.sport, normalizedName(price.player), price.market, price.line, dayKey(price.startTime)]), price]));
  const main = mainLines(prices.filter((price) => price.book === book));
  const pairs = main.flatMap((price) => {
    const start = Date.parse(price.startTime);
    if (start <= now.getTime()) return [];
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
  if (counts) {
    const mine = prices.filter((price) => price.book === book);
    for (const price of mine) counts[`prices:${price.sport}`] = (counts[`prices:${price.sport}`] ?? 0) + 1;
    counts.upcoming = mine.filter((price) => Date.parse(price.startTime) > now.getTime()).length;
    // Alternate lines: how many player-stat pairs the book prices at more than one number.
    const numbers = new Map<string, Set<number>>();
    for (const price of mine) {
      const key = JSON.stringify([price.sport, normalizedName(price.player), price.market, dayKey(price.startTime)]);
      numbers.set(key, (numbers.get(key) ?? new Set()).add(price.line));
    }
    counts.playerStats = numbers.size;
    counts.withAltLines = [...numbers.values()].filter((set) => set.size > 1).length;
    counts.maxLinesPerStat = Math.max(0, ...[...numbers.values()].map((set) => set.size));
    counts.onPrizePicks = pairs.length;
    for (const analysis of scored) {
      const key = analysis.direction === 'PASS' ? `pass:${analysis.reasonCode ?? 'NONE'}` : 'picked';
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
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
      pricey: (impliedChance(american) ?? 0) >= PRICEY,
      fairChance: Math.round((side === 'MORE' ? price.fairOver : 1 - price.fairOver) * 10_000) / 10_000,
      otherBook: other ? { book: other.book as Sportsbook, american: side === 'MORE' ? other.overAmerican : other.underAmerican } : null,
      // PrizePicks' own line can PASS for a reason the book's line doesn't have: a Goblin or Demon offers only More.
      prizePicks: { line: research.threshold, lineType: research.lineType, sides: [...research.availableDirections],
        gkr: reference ? { direction: reference.direction, score: reference.score, reasonCode: reference.reasonCode ?? null } : null } };
    linesOut?.set(line.id, line);
    const key = `${research.eventId}|${research.playerId}|${price.market}`, current = best.get(key);
    if (!current || pick.gkr.score > current.gkr.score) best.set(key, pick);
  });
  return [...best.values()].sort((a, b) => b.gkr.score - a.gkr.score);
}

export interface LadderRow {
  readonly book: Sportsbook; readonly line: number; readonly american: number | null; readonly needs: number | null;
  /** The book's no-vig chance of the side at this number. */
  readonly fairChance: number;
  /** GKR's score for the side at this number, or null when GKR doesn't back it there. */
  readonly gkr: number | null;
  readonly pricey: boolean;
  /** The book's main line (closest to 50/50) for this player and stat. */
  readonly main: boolean;
}

/**
 * The sportsbooks' numbers for one PrizePicks line's player and stat (Hard Rock posts alternate ladders; DraftKings
 * comes through with its main line), for GKR's side: the four numbers nearest the PrizePicks line on the easier side
 * (lower for More, higher for Less), the same number, and the two nearest on the harder side. Each number is scored by
 * GKR on the same research. Display only.
 */
export function bookLadder(line: PropLine, side: PlayableDirection, prices: readonly FairPrice[],
  scoreLines: (lines: readonly PropLine[]) => Analysis[]): LadderRow[] {
  const start = Date.parse(line.eventStartTime), name = normalizedName(line.playerName);
  const mine = prices.filter((price) => price.sport === line.sport && price.market === line.market &&
    normalizedName(price.player) === name && Math.abs(Date.parse(price.startTime) - start) <= 6 * 3600_000 &&
    (sportsbooks as readonly string[]).includes(price.book));
  if (!mine.length) return [];
  const numbers = [...new Set(mine.map((price) => price.line))];
  const easier = numbers.filter((value) => side === 'MORE' ? value < line.threshold : value > line.threshold)
    .sort((a, b) => Math.abs(a - line.threshold) - Math.abs(b - line.threshold)).slice(0, 4);
  const harder = numbers.filter((value) => side === 'MORE' ? value > line.threshold : value < line.threshold)
    .sort((a, b) => Math.abs(a - line.threshold) - Math.abs(b - line.threshold)).slice(0, 2);
  const keep = new Set([...easier, ...harder, ...numbers.filter((value) => value === line.threshold)]);
  const kept = [...keep];
  const { payoutMultiplier: _payout, ...base } = line;
  const scored = scoreLines(kept.map((value) => ({ ...base, id: `${line.id}@${value}`, sourceLineId: `${line.id}@${value}`,
    threshold: value, availableDirections: ['MORE', 'LESS'], lineType: 'REGULAR' })));
  const gkrAt = new Map(kept.map((value, index) => {
    const analysis = scored[index];
    return [value, analysis && analysis.direction === side && analysis.score !== null ? Math.round(analysis.score) : null];
  }));
  const main = new Set(mainLines(mine).map((price) => `${price.book}|${price.line}`));
  return mine.filter((price) => keep.has(price.line)).map((price) => {
    const american = side === 'MORE' ? price.overAmerican : price.underAmerican, needs = impliedChance(american);
    return { book: price.book as Sportsbook, line: price.line, american, needs,
      fairChance: Math.round((side === 'MORE' ? price.fairOver : 1 - price.fairOver) * 10_000) / 10_000,
      gkr: gkrAt.get(price.line) ?? null, pricey: (needs ?? 0) >= PRICEY, main: main.has(`${price.book}|${price.line}`) };
  }).sort((a, b) => (side === 'MORE' ? a.line - b.line : b.line - a.line) || a.book.localeCompare(b.book));
}
