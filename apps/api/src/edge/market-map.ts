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
  'NFL:rush_rec_tds': 'anytime_tds', 'NFL:rush_plus_rec_tds': 'anytime_tds', 'NFL:rush_plus_rec_td_scorer': 'anytime_tds',
  'NCAAFB:rush_rec_tds': 'anytime_tds', 'NCAAFB:rush_plus_rec_tds': 'anytime_tds', 'NCAAFB:rush_plus_rec_td_scorer': 'anytime_tds',
  'NCAAFB:pass_plus_rush_yds': 'player_pass_rush_yds', 'NCAAFB:rush_plus_rec_yds': 'player_rush_reception_yds',
  'MLB:earned_runs': 'pitcher_earned_runs', 'MLB:earned_runs_allowed': 'pitcher_earned_runs', 'MLB:stolen_bases': 'sb',
  'MLB:pitcher_hits_allowed': 'hits_allowed',
  // Market audit (2026-10-06): the same stat under the scraper's short labels and the books' names.
  'WNBA:3ptm': 'player_threes', 'WNBA:pra': 'player_points_rebounds_assists', 'NBA:3ptm': 'player_threes',
  'NBA:pra': 'player_points_rebounds_assists', 'NHL:player_assists': 'assists', 'NHL:player_blocked_shots': 'blocked_shots',
  'NHL:player_goals': 'goals', 'NHL:player_points': 'points', 'NHL:player_total_saves': 'saves', 'NHL:player_shots_on_goal': 'shots_on_goal',
  'TENNIS:total_games_won': 'games_won', 'MLB:po': 'pitcher_outs', 'MLB:pitching_outs': 'pitcher_outs',
  'MLB:batter_runs_scored': 'runs', 'MLB:batter_singles': 'singles', 'MLB:batter_doubles': 'doubles', 'MLB:batter_rbis': 'rbis',
  'MLB:pitcher_walks': 'walks_allowed', 'MLB:pitcher_strikeouts': 'pitcher_strikeouts',
  'NCAAFB:recs': 'player_receptions', 'NCAAFB:pass_tds': 'player_pass_tds', 'NCAAFB:rush_atts': 'player_rush_attempts',
  'NCAAFB:pass_attempts': 'player_pass_attempts', 'NCAAFB:pass_comp': 'player_pass_completions',
  'NCAAFB:longest_rec': 'player_reception_longest', 'NCAAFB:longest_rush': 'player_rush_longest',
  'NCAAFB:longest_completion': 'player_pass_longest_completion', 'NCAAFB:int': 'player_pass_interceptions',
  'NCAAFB:kicking_points': 'player_kicking_points', 'NCAAFB:pat_made': 'player_pats',
  'NFL:longest_rec': 'player_reception_longest', 'NFL:longest_rush': 'player_rush_longest', 'NFL:int': 'player_pass_interceptions',
};

/** The one market key every source maps into. */
export const canonicalMarket = (sport: string, market: string): string => {
  // A partial-game key keeps its segment and canonicalizes the rest (1h_rec_tds and 1h_player_reception_tds meet).
  const segmented = /^(1h|2h|1q|2q|3q|4q|1p|2p|3p)_(.+)$/.exec(market);
  if (segmented) return `${segmented[1]}_${canonicalMarket(sport, segmented[2]!)}`;
  return marketAliases[`${sport}:${market}`] ?? market;
};
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
  /** A few prices that found the player and stat but no game, for diagnosing the match rate. */
  readonly noEventSamples: readonly { player: string; book: string; start: string; teams: string; boardStarts: string; boardTeams: string }[];
  readonly mismatchSamples: readonly { player: string; market: string; book: string; bookLine: number; boardLine: number }[];
  /** 9b: MARKET_MISMATCH rejections per market and book, each with one example of both sources' numbers. */
  readonly mismatchByMarket?: Readonly<Record<string, { count: number; example: string }>>;
}

const SIX_HOURS = 6 * 3600_000, THREE_HOURS = 3 * 3600_000;

/** Team names across sources: full names ("New York Yankees"), nicknames, or the boards' abbreviations ("NYY", "TB"). */
export function teamsMatch(a: string, b: string): boolean {
  if (sameTeam(a, b)) return true;
  const short = a.replace(/[^A-Za-z]/g, '').length <= 4 && !a.includes(' ') ? a : b.replace(/[^A-Za-z]/g, '').length <= 4 && !b.includes(' ') ? b : null;
  if (!short) return false;
  const long = short === a ? b : a, code = short.toLowerCase().replace(/[^a-z]/g, '');
  const words = normalizedName(long).split(' ').filter(Boolean);
  if (words.length < 2 || code.length < 2) return false;
  const initials = words.map((word) => word[0]).join('');
  // NYY = New York Yankees, TB = Tampa Bay (Rays), LAD = Los Angeles Dodgers, KC = Kansas City, SF = San Francisco.
  return initials === code || initials.startsWith(code) || (words[0]!.startsWith(code) && code.length >= 3);
}

/**
 * SharpAPI book prices as Edge quotes on the board's own events. `exclude` names the books that may not count (the
 * platform being priced). Returns the quotes and the match report.
 */
export function matchBookPrices(lines: readonly PropLine[], prices: readonly FairPrice[], fetchedAt: string,
  exclude: readonly string[] = [], promos: ReadonlyMap<string, number | null> = new Map()): { quotes: MarketQuote[]; report: MatchReport } {
  const byPlayer = new Map<string, PropLine[]>();
  for (const line of lines) {
    const key = `${playerKey(line.sport, line.playerName)}|${canonicalMarket(line.sport, line.market)}`;
    byPlayer.set(key, [...byPlayer.get(key) ?? [], line]);
  }
  const quotes: MarketQuote[] = [];
  let considered = 0, ambiguous = 0, noEvent = 0;
  const noEventSamples: MatchReport['noEventSamples'][number][] = [];
  const pricedGroups = new Set<string>(), matchedGroups = new Set<string>();
  for (const price of prices) {
    if (exclude.includes(price.book) || price.stale) continue;
    const key = `${playerKey(price.sport, price.player)}|${canonicalMarket(price.sport, price.market)}`;
    const candidates = byPlayer.get(key);
    if (!candidates) continue;
    considered++;
    pricedGroups.add(key);
    const start = Date.parse(price.startTime);
    const window = candidates.filter((line) => Math.abs(Date.parse(line.eventStartTime) - start) <= SIX_HOURS);
    let near = window.filter((line) => !price.home || !line.homeTeam || [line.homeTeam, line.awayTeam, line.team].some((team) =>
      team && (teamsMatch(team, price.home!) || teamsMatch(team, price.away ?? ''))));
    // Team names that can't be compared (a source's own abbreviations, tennis players as "teams"): one game for this player
    // within three hours of the book's start is the same game; anything wider or with two games stays unmatched.
    // Full team names that disagree are a different game, so they never fall back.
    const comparable = (line: PropLine) => [line.homeTeam, line.awayTeam].some((team) => team && team.trim().includes(' '));
    // A player plays one game at a time: one board game for this player starting within 30 minutes of the book's start is
    // the same game, whatever each source calls the teams (college nicknames vs school names: "Golden Eagles" = "Southern Miss").
    if (!near.length) {
      const sameTime = window.filter((line) => Math.abs(Date.parse(line.eventStartTime) - start) <= 30 * 60_000);
      const close = sameTime.length ? sameTime
        : window.filter((line) => Math.abs(Date.parse(line.eventStartTime) - start) <= THREE_HOURS && !comparable(line));
      if (new Set(close.map((line) => line.eventId)).size === 1) near = close;
    }
    const events = [...new Set(near.map((line) => line.eventId))];
    if (!events.length) {
      noEvent++;
      if (noEventSamples.length < 8) noEventSamples.push({ player: price.player, book: price.book, start: price.startTime,
        teams: `${price.away ?? '?'} @ ${price.home ?? '?'}`, boardStarts: [...new Set(candidates.map((line) => line.eventStartTime))].slice(0, 3).join(','),
        boardTeams: [...new Set(candidates.map((line) => `${line.awayTeam ?? '?'} @ ${line.homeTeam ?? '?'}`))].slice(0, 2).join(',') });
      continue;
    }
    if (events.length > 1) { ambiguous++; continue; }
    const line = near[0]!;
    const over = decimalOdds(price.overAmerican), under = decimalOdds(price.underAmerican);
    if (over === null && under === null) continue;
    matchedGroups.add(key);
    quotes.push({ bookmaker: price.book, sport: line.sport, eventId: line.eventId, sourceMarketKey: price.market,
      market: line.market, playerName: line.playerName, point: price.line, overPrice: over, underPrice: under, fetchedAt,
      ...(price.observedAt ? { observedAt: new Date(price.observedAt).toISOString() } : {}) });
  }
  const { kept, mismatches, samples, byMarket } = rejectMismatches(lines, quotes, promos);
  const regularGroups = new Set(lines.filter((line) => line.lineType === 'REGULAR')
    .map((line) => `${playerKey(line.sport, line.playerName)}|${canonicalMarket(line.sport, line.market)}`));
  return { quotes: kept, report: { prices: considered, matched: kept.length, ambiguous, noEvent,
    linesWithBookPrice: [...pricedGroups].filter((key) => regularGroups.has(key)).length,
    linesMatched: [...matchedGroups].filter((key) => regularGroups.has(key)).length,
    mismatches, mismatchSamples: samples, mismatchByMarket: byMarket, noEventSamples } };
}

/**
 * Drops quotes whose implied mean is more than 3 SD from the board's regular line for the same player and stat.
 * A promo line (Pick6 moving Dak Prescott's passing yards to 0.5) is checked at its original number, or not at all without one.
 */
export function rejectMismatches(lines: readonly PropLine[], quotes: readonly MarketQuote[],
  promos: ReadonlyMap<string, number | null> = new Map()) {
  const regular = new Map<string, PropLine>();
  for (const line of lines) if (line.lineType === 'REGULAR') regular.set(`${line.eventId}|${normalizedName(line.playerName)}|${line.market}`, line);
  const kept: MarketQuote[] = [], samples: MatchReport['mismatchSamples'][number][] = [];
  const byMarket: Record<string, { count: number; example: string }> = {};
  let mismatches = 0;
  for (const quote of quotes) {
    const line = regular.get(`${quote.eventId}|${normalizedName(quote.playerName)}|${quote.market}`);
    // A promo with no original number can't be checked; it isn't a mislabeled stat, and its payout is blocked anyway.
    if (!line || promos.get(line.id) === null) { kept.push(quote); continue; }
    const profile = profileFor(line.sport, line.market);
    const fairOver = quote.overPrice && quote.underPrice
      ? (1 / quote.overPrice) / (1 / quote.overPrice + 1 / quote.underPrice) : 0.5;
    const quoteMean = fitMean(profile.family, profile.variance, quote.point, fairOver, profile.discrete);
    const boardMean = fitMean(profile.family, profile.variance, promos.get(line.id) ?? line.threshold, 0.5, profile.discrete);
    const sd = Math.sqrt(varianceAt(profile.variance, boardMean));
    if (Math.abs(quoteMean - boardMean) > 3 * sd) {
      mismatches++;
      if (samples.length < 10) samples.push({ player: line.playerName, market: line.market, book: quote.bookmaker,
        bookLine: quote.point, boardLine: line.threshold });
      const group = `${line.sport}:${line.market}|${quote.bookmaker}:${quote.sourceMarketKey}`;
      byMarket[group] = { count: (byMarket[group]?.count ?? 0) + 1,
        example: byMarket[group]?.example ?? `${line.playerName}: board ${line.threshold}, ${quote.bookmaker} ${quote.point}` };
      continue;
    }
    kept.push(quote);
  }
  return { kept, mismatches, samples, byMarket };
}
