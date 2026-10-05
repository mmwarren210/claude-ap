import type { Analysis, PlayableDirection, PropLine } from '@crowniq/contracts';
import { createHash } from 'node:crypto';
import { normalizedName } from './context/match.js';
import { leagueInfo, leagueLabel } from './scrapers/markets.js';
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
  readonly side: PlayableDirection;
  /** Who backs the side: GKR's model, the History Read at the book's number, or a price better than the other book's fair. */
  readonly by: 'GKR' | 'HISTORY' | 'VALUE';
  /** The pick's strength: GKR's score, the History Read's chance, or the other book's fair chance (0-100). */
  readonly score: number;
  /** Why, in plain words (History and Value picks). */
  readonly note: string | null;
  readonly gkr: { readonly score: number; readonly modelVersion: string } | null;
  /** The book's price on GKR's side, and the chance that price implies (vig included). */
  readonly american: number | null; readonly impliedChance: number | null;
  /** The price needs 60% or more to break even (-150 or steeper): labeled, never hidden (owner, 2026-10-05). */
  readonly pricey: boolean;
  /** The book's no-vig chance of GKR's side. */
  readonly fairChance: number;
  /** The other book's price on the same side and number, for line shopping. */
  readonly otherBook: { readonly book: Sportsbook; readonly american: number | null } | null;
  /**
   * An easier number for GKR's side another listing offers (Hard Rock's alternate ladder): lower for Over, higher for
   * Under, the easiest one whose price still needs under 60%. DraftKings usually has alternates too, but they don't come
   * through the feed, so its cards point to Hard Rock's.
   */
  readonly altLine: { readonly book: Sportsbook; readonly line: number; readonly american: number | null } | null;
  /**
   * For a pricey pick: a harder number for the same side priced under 60% (higher for Over, lower for Under), the
   * nearest one. Replaces the PRICEY tag with "check higher/lower line" when there is one.
   */
  readonly fairerLine?: { readonly book: Sportsbook; readonly line: number; readonly american: number | null } | null;
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

/** A side backed some other way than GKR, for a book line (see bookPicks). */
export interface BookFallback { readonly side: PlayableDirection; readonly score: number; readonly note: string }
/** A Value pick needs the other book's fair chance at least this far above what this book's price needs. */
export const VALUE_EDGE = 0.03;
const byRank = { GKR: 3, HISTORY: 2, VALUE: 1 } as const;
const hashName = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

/** A board-shaped line for a player PrizePicks doesn't list, so History can still read the book's number. */
export function syntheticLine(id: string, price: Pick<FairPrice, 'sport' | 'player' | 'market' | 'line' | 'startTime' | 'home' | 'away'>,
  now: Date): PropLine {
  const league = leagueLabel(price.sport);
  return { id, provider: 'prizepicks', sourceLineId: id, sourceLineIdIsSynthetic: true, sport: price.sport, league,
    eventId: `book-game:${price.sport}:${price.home ?? ''}:${price.away ?? ''}:${price.startTime.slice(0, 13)}`,
    eventName: price.home && price.away ? `${price.away} @ ${price.home}` : `${league} game`,
    eventStartTime: new Date(price.startTime).toISOString(),
    playerId: `${leagueInfo(league).key}:${hashName(price.player.trim().toLowerCase())}`, playerName: price.player,
    team: null, opponent: null, homeTeam: price.home, awayTeam: price.away, market: price.market, threshold: price.line,
    availableDirections: ['MORE', 'LESS'], lineType: 'REGULAR', fetchedAt: now.toISOString() } as PropLine;
}

/** Each book main line as a board line: on the PrizePicks player's game when PrizePicks lists them, else synthetic. */
export interface BookLine { readonly price: FairPrice; readonly research: PropLine | null; readonly line: PropLine }
export function bookLines(book: Sportsbook, prices: readonly FairPrice[], boardLines: readonly PropLine[], now: Date): BookLine[] {
  const byPlayer = new Map<string, PropLine[]>();
  for (const line of boardLines) {
    const key = JSON.stringify([line.sport, normalizedName(line.playerName), line.market]);
    byPlayer.set(key, [...byPlayer.get(key) ?? [], line]);
  }
  return mainLines(prices.filter((price) => price.book === book)).flatMap((price): BookLine[] => {
    const start = Date.parse(price.startTime);
    if (start <= now.getTime()) return [];
    // The PrizePicks line for the same player and stat in the same game (within 6 hours): standard first, then closest.
    const research = (byPlayer.get(JSON.stringify([price.sport, normalizedName(price.player), price.market])) ?? [])
      .filter((line) => Math.abs(Date.parse(line.eventStartTime) - start) <= 6 * 3600_000)
      .sort((a, b) => Number(b.lineType === 'REGULAR') - Number(a.lineType === 'REGULAR') ||
        Math.abs(a.threshold - price.line) - Math.abs(b.threshold - price.line))[0] ?? null;
    if (!research) {
      const id = `${book}:x:${hashName(JSON.stringify([price.sport, normalizedName(price.player), price.market, price.line, dayKey(price.startTime)]))}`;
      return [{ price, research: null, line: syntheticLine(id, price, now) }];
    }
    const id = `${book}:${research.eventId}:${research.playerId}:${price.market}:${price.line}`;
    const { payoutMultiplier: _payout, ...base } = research;
    const line: PropLine = { ...base, id, sourceLineId: id, threshold: price.line, availableDirections: ['MORE', 'LESS'],
      lineType: 'REGULAR' };
    return [{ price, research, line }];
  });
}

/**
 * Picks on one book, for each player and stat it prices: GKR's side at the book's number when GKR picks one; else the
 * History Read's side there (`history`, keyed by line id); else a Value side, when this book's price needs at least
 * VALUE_EDGE less than the other book's fair chance at the same number. One pick per player and stat (GKR first, then
 * History, then Value; the higher strength within each), strongest first.
 */
export function bookPicks(book: Sportsbook, prices: readonly FairPrice[], boardLines: readonly PropLine[],
  analyses: ReadonlyMap<string, Analysis>, scoreLines: (lines: readonly PropLine[]) => Analysis[], now: Date,
  counts?: Record<string, number>, linesOut?: Map<string, PropLine>, history: ReadonlyMap<string, BookFallback> = new Map()): BookPick[] {
  const others = new Map(prices.filter((price) => price.book !== book).map((price) =>
    [JSON.stringify([price.sport, normalizedName(price.player), price.market, price.line, dayKey(price.startTime)]), price]));
  // Every number either book prices per player and stat (Hard Rock's ladders), for the easier-line hint.
  const ladders = new Map<string, FairPrice[]>();
  for (const price of prices) {
    if (!(sportsbooks as readonly string[]).includes(price.book)) continue;
    const key = JSON.stringify([price.sport, normalizedName(price.player), price.market, dayKey(price.startTime)]);
    ladders.set(key, [...ladders.get(key) ?? [], price]);
  }
  const all = bookLines(book, prices, boardLines, now);
  // GKR scores only lines on a PrizePicks player's game (its research); the rest get History and Value.
  const pairs = all.filter((pair): pair is BookLine & { research: PropLine } => pair.research !== null);
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
  const scoredBy = new Map(pairs.map((pair, index) => [pair.line.id, scored[index]]));
  all.forEach(({ price, research, line }) => {
    const analysis = scoredBy.get(line.id);
    const other = others.get(JSON.stringify([price.sport, normalizedName(price.player), price.market, price.line, dayKey(price.startTime)]));
    const fallback = history.get(line.id);
    // Value: this book's price on a side needs less than the other book's no-vig chance of it.
    const value = other ? (['MORE', 'LESS'] as const).map((side) => {
      const needs = impliedChance(side === 'MORE' ? price.overAmerican : price.underAmerican);
      const fair = side === 'MORE' ? other.fairOver : 1 - other.fairOver;
      return needs === null ? null : { side, edge: fair - needs, fair, needs };
    }).filter((item): item is NonNullable<typeof item> => !!item && item.edge >= VALUE_EDGE).sort((a, b) => b.edge - a.edge)[0] : undefined;
    const backing = analysis && analysis.direction !== 'PASS' && analysis.score !== null && analysis.modelVersion
      ? { by: 'GKR' as const, side: analysis.direction, score: analysis.score, note: null,
        gkr: { score: analysis.score, modelVersion: analysis.modelVersion } }
      : fallback ? { by: 'HISTORY' as const, side: fallback.side, score: fallback.score, note: fallback.note, gkr: null }
        : value ? { by: 'VALUE' as const, side: value.side, score: Math.round(value.fair * 100), gkr: null,
          note: `${sportsbookNames[other!.book as Sportsbook] ?? other!.book}’s fair price gives ${value.side === 'MORE' ? 'Over' : 'Under'} ` +
            `${Math.round(value.fair * 100)}%; this price needs ${Math.round(value.needs * 100)}%.` } : null;
    if (!backing) return;
    const side = backing.side, american = side === 'MORE' ? price.overAmerican : price.underAmerican;
    const reference = research ? analyses.get(research.id) : undefined;
    const source = research ?? line;
    const alternates = (ladders.get(JSON.stringify([price.sport, normalizedName(price.player), price.market, dayKey(price.startTime)])) ?? [])
      .filter((item) => (side === 'MORE' ? item.line < price.line : item.line > price.line) &&
        (impliedChance(side === 'MORE' ? item.overAmerican : item.underAmerican) ?? 1) < PRICEY)
      .sort((a, b) => side === 'MORE' ? a.line - b.line : b.line - a.line);
    const alt = alternates[0];
    const pricey = (impliedChance(american) ?? 0) >= PRICEY;
    const fairer = pricey ? (ladders.get(JSON.stringify([price.sport, normalizedName(price.player), price.market, dayKey(price.startTime)])) ?? [])
      .filter((item) => (side === 'MORE' ? item.line > price.line : item.line < price.line) &&
        (impliedChance(side === 'MORE' ? item.overAmerican : item.underAmerican) ?? 1) < PRICEY)
      .sort((a, b) => Math.abs(a.line - price.line) - Math.abs(b.line - price.line) ||
        Number(b.book === book) - Number(a.book === book))[0] : undefined;
    const pick: BookPick = { id: line.id, book, sport: source.sport, league: source.league, playerName: source.playerName,
      team: source.team ?? null, opponent: source.opponent ?? null, eventName: source.eventName,
      eventStartTime: source.eventStartTime, market: price.market, line: price.line, side,
      by: backing.by, score: Math.round(backing.score), note: backing.note, gkr: backing.gkr,
      american, impliedChance: impliedChance(american),
      pricey,
      fairChance: Math.round((side === 'MORE' ? price.fairOver : 1 - price.fairOver) * 10_000) / 10_000,
      fairerLine: fairer ? { book: fairer.book as Sportsbook, line: fairer.line,
        american: side === 'MORE' ? fairer.overAmerican : fairer.underAmerican } : null,
      altLine: alt ? { book: alt.book as Sportsbook, line: alt.line, american: side === 'MORE' ? alt.overAmerican : alt.underAmerican } : null,
      otherBook: other ? { book: other.book as Sportsbook, american: side === 'MORE' ? other.overAmerican : other.underAmerican } : null,
      // PrizePicks' own line can PASS for a reason the book's line doesn't have: a Goblin or Demon offers only More.
      prizePicks: research ? { line: research.threshold, lineType: research.lineType, sides: [...research.availableDirections],
        gkr: reference ? { direction: reference.direction, score: reference.score, reasonCode: reference.reasonCode ?? null } : null } : null };
    linesOut?.set(line.id, line);
    const key = `${source.eventId}|${source.playerId}|${price.market}`, current = best.get(key);
    if (!current || byRank[pick.by] > byRank[current.by] || byRank[pick.by] === byRank[current.by] && pick.score > current.score)
      best.set(key, pick);
  });
  return [...best.values()].sort((a, b) => byRank[b.by] - byRank[a.by] || b.score - a.score);
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
