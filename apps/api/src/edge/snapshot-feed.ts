import type { MarketOdds } from '../context/feeds.js';
import type { FairPrice, PickemLine } from '../context/sharp-props.js';
import type { StoredLine } from '../scrapers/line-store.js';
import { leagueInfo, lineMarket } from '../scrapers/markets.js';
import { decimalOdds, eventKey, playerKey } from './market-map.js';
import type { SnapshotRow } from './snapshots.js';

// Every source's observations in the snapshot store's one row shape (spec §1.1 write path): SharpAPI book prices and
// PrizePicks lines, the scraped PrizePicks / Underdog / Pick6 boards (with each side's multiplier), and Kalshi's prices.

/** SharpAPI book prices: one row per side, at the book's decimal price. */
export function bookRows(prices: readonly FairPrice[], at: string): SnapshotRow[] {
  return prices.flatMap((price) => (['MORE', 'LESS'] as const).flatMap((side) => {
    const decimal = decimalOdds(side === 'MORE' ? price.overAmerican : price.underAmerican);
    return decimal === null ? [] : [{ observedAt: price.observedAt ? new Date(price.observedAt).toISOString() : at,
      source: 'sharpapi' as const, platform: price.book, eventKey: eventKey(price.sport, price.home, price.away, price.startTime),
      playerKey: playerKey(price.sport, price.player), market: price.market, number: price.line, side, price: decimal,
      startTime: new Date(price.startTime).toISOString() }];
  }));
}

/** SharpAPI's PrizePicks lines: the number and sides offered (their price is the app's payout, kept as the price). */
export function pickemRows(lines: readonly PickemLine[], at: string): SnapshotRow[] {
  return lines.flatMap((line) => line.sides.map((side) => ({ observedAt: at, source: 'sharpapi' as const,
    platform: line.book, eventKey: eventKey(line.sport ?? line.league, line.home, line.away, line.startTime),
    playerKey: playerKey(line.sport ?? line.league, line.player), market: line.market ?? line.marketType, number: line.line, side,
    lineType: line.alternate ? 'ALTERNATE' : 'REGULAR', price: decimalOdds(line.american),
    startTime: new Date(line.startTime).toISOString() })));
}

/** The scraped pick'em boards: each line and side, with its payout multiplier when the app shows one. */
export function scrapedRows(lines: readonly StoredLine[], at: string): SnapshotRow[] {
  return lines.filter((line) => !line.removedAt).flatMap((line) => {
    const sport = leagueInfo(line.league).sport;
    return line.directions.map((side) => ({ observedAt: at, source: 'scraper' as const, platform: line.app,
      eventKey: eventKey(sport, line.home?.name ?? line.home?.abbreviation, line.away?.name ?? line.away?.abbreviation, line.startTime),
      playerKey: playerKey(sport, line.player), market: lineMarket(line), number: line.line, side, lineType: line.tier,
      multiplier: line.multipliers?.[side] ?? null, startTime: new Date(line.startTime).toISOString(), rawId: line.appLineId }));
  });
}

/** Kalshi's live market prices: each outcome's probability. */
export function kalshiRows(markets: readonly MarketOdds[], at: string): SnapshotRow[] {
  return markets.filter((market) => market.closeTime).flatMap((market) => market.outcomes.map((outcome) => ({
    observedAt: at, source: 'kalshi-api' as const, platform: 'kalshi', eventKey: `KALSHI|${market.eventTitle}`,
    playerKey: '', market: market.question, number: null, side: outcome.name, probability: outcome.probability / 100,
    startTime: new Date(market.closeTime!).toISOString(), rawId: market.url })));
}
