import type { PlayableDirection, PropLine } from '@crowniq/contracts';
import { statKey } from './app-boards.js';
import type { AppLine } from './app-boards.js';
import { normalizedName } from './context/match.js';
import type { FairPrice } from './context/sharp-props.js';

// Line shopping (owner, 2026-10-05): the same player and stat on PrizePicks, Underdog and Pick6 often sits at different
// numbers. For each one we show every app's number, the easiest number for More (lowest) and Less (highest), and where
// the sportsbooks put it. When GKR or a History Read backs a side, the shop says where that side is easiest to play.
// Display only: nothing here changes a score.

export type ShopSource = 'prizepicks' | 'underdog' | 'pick6';
export interface ShopOffer {
  readonly source: ShopSource; readonly lineId: string; readonly threshold: number; readonly lineType: string;
  readonly sides: readonly PlayableDirection[];
  /** The app's own payout on a side, when it sets one (Underdog and Pick6). */
  readonly multipliers: Partial<Record<PlayableDirection, number>> | null;
}
export interface ShopBook { readonly book: string; readonly line: number; readonly fairOver: number;
  readonly overAmerican: number | null; readonly underAmerican: number | null }
export interface ShopPick { readonly side: PlayableDirection; readonly by: 'GKR' | 'HISTORY'; readonly score: number }
export interface ShopEntry {
  readonly key: string; readonly sport: string; readonly league: string; readonly playerName: string; readonly team: string | null;
  readonly market: string; readonly eventStartTime: string; readonly eventName: string | null;
  readonly offers: readonly ShopOffer[];
  readonly bestMore: { readonly source: ShopSource; readonly threshold: number } | null;
  readonly bestLess: { readonly source: ShopSource; readonly threshold: number } | null;
  /** Highest app number minus lowest. */
  readonly spread: number;
  readonly books: readonly ShopBook[];
  /** The sportsbooks' main number (closest to 50/50) and their average no-vig chance of the over there. */
  readonly booksLine: number | null; readonly booksOver: number | null;
  /** GKR's side (or the History Read's), and where it's easiest to play. */
  readonly pick: (ShopPick & { readonly best: { readonly source: ShopSource; readonly threshold: number } | null }) | null;
}

const keyOf = (sport: string, player: string, market: string, startTime: string) =>
  `${sport}|${normalizedName(player)}|${statKey(market)}|${startTime.slice(0, 10)}`;

/** The easiest number for a side: lowest for More, highest for Less; a better payout breaks ties. */
export function bestFor(offers: readonly ShopOffer[], side: PlayableDirection) {
  const open = offers.filter((offer) => offer.sides.includes(side));
  if (!open.length) return null;
  const best = [...open].sort((a, b) => (side === 'MORE' ? a.threshold - b.threshold : b.threshold - a.threshold) ||
    (b.multipliers?.[side] ?? 1) - (a.multipliers?.[side] ?? 1))[0];
  return { source: best.source, threshold: best.threshold };
}

export function lineShop(prizePicks: readonly PropLine[], apps: readonly AppLine[], prices: readonly FairPrice[],
  picks: ReadonlyMap<string, ShopPick>, now: Date): ShopEntry[] {
  type Group = { sample: { sport: string; league: string; playerName: string; team: string | null; market: string;
    eventStartTime: string; eventName: string | null }; offers: ShopOffer[]; books: ShopBook[]; pick: ShopPick | null };
  const groups = new Map<string, Group>();
  const group = (key: string, sample: Group['sample']) => {
    let entry = groups.get(key);
    if (!entry) { entry = { sample, offers: [], books: [], pick: null }; groups.set(key, entry); }
    return entry;
  };
  const future = (startTime: string) => Date.parse(startTime) > now.getTime();
  // PrizePicks: standard lines only (Goblins and Demons pay differently, so their numbers don't compare).
  for (const line of prizePicks) {
    if (line.lineType !== 'REGULAR' || !future(line.eventStartTime)) continue;
    const entry = group(keyOf(line.sport, line.playerName, line.market, line.eventStartTime), { sport: line.sport,
      league: line.league, playerName: line.playerName, team: line.team ?? null, market: line.market,
      eventStartTime: line.eventStartTime, eventName: line.homeTeam && line.awayTeam ? `${line.awayTeam} @ ${line.homeTeam}` : null });
    entry.offers.push({ source: 'prizepicks', lineId: line.id, threshold: line.threshold, lineType: line.lineType,
      sides: line.availableDirections, multipliers: null });
    const pick = picks.get(line.id);
    if (pick && (!entry.pick || pick.by === 'GKR' && entry.pick.by !== 'GKR')) entry.pick = pick;
  }
  for (const line of apps) {
    if (!future(line.eventStartTime)) continue;
    const entry = group(keyOf(line.sport, line.playerName, line.market, line.eventStartTime), { sport: line.sport,
      league: line.league, playerName: line.playerName, team: line.team, market: line.market,
      eventStartTime: line.eventStartTime, eventName: line.eventName });
    entry.offers.push({ source: line.app, lineId: line.id, threshold: line.threshold, lineType: line.lineType,
      sides: line.availableDirections, multipliers: line.multipliers });
  }
  // Each book's main number per player and stat (the one closest to 50/50).
  const main = new Map<string, FairPrice>();
  for (const price of prices) {
    if (!future(price.startTime)) continue;
    const key = `${price.book}|${keyOf(price.sport, price.player, price.market, price.startTime)}`, current = main.get(key);
    if (!current || Math.abs(price.fairOver - 0.5) < Math.abs(current.fairOver - 0.5)) main.set(key, price);
  }
  for (const price of main.values()) {
    const entry = groups.get(keyOf(price.sport, price.player, price.market, price.startTime));
    entry?.books.push({ book: price.book, line: price.line, fairOver: Math.round(price.fairOver * 1000) / 1000,
      overAmerican: price.overAmerican, underAmerican: price.underAmerican });
  }
  const out: ShopEntry[] = [];
  for (const [key, { sample, offers, books, pick }] of groups) {
    // Worth shopping: two apps list it, or one app and a sportsbook.
    const apps = new Set(offers.map((offer) => offer.source));
    if (apps.size < 2 && !(apps.size === 1 && books.length)) continue;
    const thresholds = offers.map((offer) => offer.threshold);
    const counts = new Map<number, number>();
    for (const book of books) counts.set(book.line, (counts.get(book.line) ?? 0) + 1);
    const booksLine = books.length ? [...counts].sort((a, b) => b[1] - a[1] ||
      Math.abs(books.find((item) => item.line === a[0])!.fairOver - 0.5) - Math.abs(books.find((item) => item.line === b[0])!.fairOver - 0.5))[0][0] : null;
    const atLine = books.filter((book) => book.line === booksLine);
    out.push({ key, ...sample, offers: [...offers].sort((a, b) => a.threshold - b.threshold), bestMore: bestFor(offers, 'MORE'),
      bestLess: bestFor(offers, 'LESS'), spread: Math.round((Math.max(...thresholds) - Math.min(...thresholds)) * 10) / 10,
      books, booksLine, booksOver: atLine.length ? Math.round(atLine.reduce((sum, book) => sum + book.fairOver, 0) / atLine.length * 1000) / 1000 : null,
      pick: pick ? { ...pick, best: bestFor(offers, pick.side) } : null });
  }
  // Biggest gaps first, then a backed side, then game time.
  return out.sort((a, b) => b.spread - a.spread || Number(!!b.pick) - Number(!!a.pick) ||
    a.eventStartTime.localeCompare(b.eventStartTime));
}
