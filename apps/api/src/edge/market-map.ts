import type { MarketQuote, PropLine } from '@crowniq/contracts';
import { fitMean, profileFor, varianceAt } from '@crowniq/edge';
import type { FairPrice } from '../context/sharp-props.js';
import { normalizedName } from '../context/match.js';
import { sameTeam } from '../team-match.js';

// Edge 2.0 identity layer (spec §1.2): one key for player, event and market across sources (scraped PrizePicks,
// Underdog and Pick6 boards, SharpAPI books and PrizePicks lines). Names go through `normalizedName`; events match
// on team pair plus start within ±6h; markets go through the one table below. Ambiguity yields no match and a counter,
// never a guess. A matched quote whose implied mean sits more than 3 SD from the board's own line is rejected as a
// MARKET_MISMATCH (mislabeled stats, such as tennis "total games" vs "games won").

/** Every source's market key → the board's key (the scraped PrizePicks key), where they differ. */
const marketAliases: Readonly<Record<string, string>> = {
  'NFL:pass_plus_rush_yds': 'player_pass_rush_yds', 'NFL:rush_plus_rec_yds': 'player_rush_reception_yds',
  'NFL:rush_rec_tds': 'anytime_tds', 'NFL:rush_plus_rec_tds': 'anytime_tds',
  'NCAAFB:pass_plus_rush_yds': 'player_pass_rush_yds', 'NCAAFB:rush_plus_rec_yds': 'player_rush_reception_yds',
  'MLB:earned_runs': 'pitcher_earned_runs', 'MLB:earned_runs_allowed': 'pitcher_earned_runs', 'MLB:stolen_bases': 'sb',
  'MLB:pitcher_hits_allowed': 'hits_allowed',
};

/** The one market key every source maps into. */
export const canonicalMarket = (sport: string, market: string) => marketAliases[`${sport}:${market}`] ?? market;
export const playerKey = (sport: string, name: string) => `${sport}|${normalizedName(name)}`;
/** An event's key for the snapshot store: sport, the two teams and the UTC start hour. */
export const eventKey = (sport: string, home: string | null | undefined, away: string | null | undefined, startTime: string) =>
  `${sport}|${normalizedName(home ?? '')}|${normalizedName(away ?? '')}|${new Date(startTime).toISOString().slice(0, 13)}`;

export const decimalOdds = (american: number | null) => american === null || american === 0 ? null
  : Math.round((american > 0 ? 1 + american / 100 : 1 + 100 / -american) * 10_000) / 10_000;

export interface MatchReport {
  /** Book prices offered to the matcher, and how many found exactly one board event. */
  readonly prices: number; readonly matched: number;
  /** Prices whose player and stat fit more than one board event (left out). */
  readonly ambiguous: number;
  /** Prices for a player and stat the board has, but no game within ±6h with a matching team. */
  readonly noEvent: number;
  /** Board lines (standard) whose player and stat any book prices, and how many of those got a quote. */
  readonly linesWithBookPrice: number; readonly linesMatched: number;
  readonly mismatches: number;
  readonly mismatchSamples: readonly { player: string; market: string; book: string; bookLine: number; boardLine: number }[];
}

const SIX_HOURS = 6 * 3600_000;

/**
 * SharpAPI book prices as Edge quotes on the board's own events. `exclude` names the books that may not count (the
 * platform being priced). Returns the quotes and the match report.
 */
export function matchBookPrices(lines: readonly PropLine[], prices: readonly FairPrice[], fetchedAt: string,
  exclude: readonly string[] = []): { quotes: MarketQuote[]; report: MatchReport } {
  const byPlayer = new Map<string, PropLine[]>();
  for (const line of lines) {
    const key = `${playerKey(line.sport, line.playerName)}|${canonicalMarket(line.sport, line.market)}`;
    byPlayer.set(key, [...byPlayer.get(key) ?? [], line]);
  }
  const quotes: MarketQuote[] = [];
  let considered = 0, ambiguous = 0, noEvent = 0;
  const pricedGroups = new Set<string>(), matchedGroups = new Set<string>();
  for (const price of prices) {
    if (exclude.includes(price.book) || price.stale) continue;
    const key = `${playerKey(price.sport, price.player)}|${canonicalMarket(price.sport, price.market)}`;
    const candidates = byPlayer.get(key);
    if (!candidates) continue;
    considered++;
    pricedGroups.add(key);
    const start = Date.parse(price.startTime);
    const near = candidates.filter((line) => Math.abs(Date.parse(line.eventStartTime) - start) <= SIX_HOURS &&
      (!price.home || !line.homeTeam || [line.homeTeam, line.awayTeam].some((team) => team &&
        (sameTeam(team, price.home!) || sameTeam(team, price.away ?? '')))));
    const events = [...new Set(near.map((line) => line.eventId))];
    if (!events.length) { noEvent++; continue; }
    if (events.length > 1) { ambiguous++; continue; }
    const line = near[0]!;
    const over = decimalOdds(price.overAmerican), under = decimalOdds(price.underAmerican);
    if (over === null && under === null) continue;
    matchedGroups.add(key);
    quotes.push({ bookmaker: price.book, sport: line.sport, eventId: line.eventId, sourceMarketKey: price.market,
      market: line.market, playerName: line.playerName, point: price.line, overPrice: over, underPrice: under, fetchedAt,
      ...(price.observedAt ? { observedAt: new Date(price.observedAt).toISOString() } : {}) });
  }
  const { kept, mismatches, samples } = rejectMismatches(lines, quotes);
  const regularGroups = new Set(lines.filter((line) => line.lineType === 'REGULAR')
    .map((line) => `${playerKey(line.sport, line.playerName)}|${canonicalMarket(line.sport, line.market)}`));
  return { quotes: kept, report: { prices: considered, matched: kept.length, ambiguous, noEvent,
    linesWithBookPrice: [...pricedGroups].filter((key) => regularGroups.has(key)).length,
    linesMatched: [...matchedGroups].filter((key) => regularGroups.has(key)).length,
    mismatches, mismatchSamples: samples } };
}

/** Drops quotes whose implied mean is more than 3 SD from the board's regular line for the same player and stat. */
export function rejectMismatches(lines: readonly PropLine[], quotes: readonly MarketQuote[]) {
  const regular = new Map<string, PropLine>();
  for (const line of lines) if (line.lineType === 'REGULAR') regular.set(`${line.eventId}|${normalizedName(line.playerName)}|${line.market}`, line);
  const kept: MarketQuote[] = [], samples: MatchReport['mismatchSamples'][number][] = [];
  let mismatches = 0;
  for (const quote of quotes) {
    const line = regular.get(`${quote.eventId}|${normalizedName(quote.playerName)}|${quote.market}`);
    if (!line) { kept.push(quote); continue; }
    const profile = profileFor(line.sport, line.market);
    const fairOver = quote.overPrice && quote.underPrice
      ? (1 / quote.overPrice) / (1 / quote.overPrice + 1 / quote.underPrice) : 0.5;
    const quoteMean = fitMean(profile.family, profile.variance, quote.point, fairOver, profile.discrete);
    const boardMean = fitMean(profile.family, profile.variance, line.threshold, 0.5, profile.discrete);
    const sd = Math.sqrt(varianceAt(profile.variance, boardMean));
    if (Math.abs(quoteMean - boardMean) > 3 * sd) {
      mismatches++;
      if (samples.length < 10) samples.push({ player: line.playerName, market: line.market, book: quote.bookmaker,
        bookLine: quote.point, boardLine: line.threshold });
      continue;
    }
    kept.push(quote);
  }
  return { kept, mismatches, samples };
}
