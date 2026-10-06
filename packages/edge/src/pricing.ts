import type { EdgeEntry, EdgePick, EdgePlatform, EdgeTier, MarketQuote, PlayableDirection, PropLine } from '@crowniq/contracts';
import { applyCalibration } from './calibration.js';
import type { CalibrationModel } from './calibration.js';
import { clamp, conditionalOver, fitMean, makeDistribution, median, outcomeAt, varianceAt } from './distributions.js';
import type { Distribution } from './distributions.js';
import { profileFor } from './markets.js';
import type { MarketProfile, StatRow } from './markets.js';
import { fairQuote, sharpBooks } from './odds.js';
import type { FairQuote } from './odds.js';
import { defaultEntries, describeEntry } from './payouts.js';
import type { EntryDefinition } from './payouts.js';
import { projectFromRows, projectFromValues } from './projection.js';
import type { StatProjection } from './projection.js';

export const EDGE_MODEL_VERSION = 'EDGE-1.0';

export interface HistoryLookup {
  (player: { sport: string; playerId: string; playerName: string }): readonly StatRow[] | undefined;
}

export interface PricingInput {
  readonly lines: readonly PropLine[];
  readonly quotes?: readonly MarketQuote[];
  readonly history?: HistoryLookup;
  readonly now: Date;
  readonly entries?: readonly EntryDefinition[];
  readonly calibration?: CalibrationModel | null;
  /** Owner-verified payout factors for non-standard lines; absent means unknown payout. */
  readonly alternateFactors?: Partial<Record<'GOBLIN' | 'DEMON', number>>;
  /**
   * Goblin/Demon factor curves: when the player's regular line is on the board, each Goblin/Demon's factor is estimated as
   * (0.5 ÷ P)^k, where P is the chance of clearing it if the regular line were a coin flip. alternateFactors is then the
   * fallback for lines without a regular. Fitted to the owner's PrizePicks screenshots, conservatively (see alternateFactorFor).
   */
  readonly alternateCurve?: Partial<Record<'GOBLIN' | 'DEMON', number>>;
  /** The platform whose lines these are (default PrizePicks). */
  readonly platform?: EdgePlatform;
  /** A player's recent values for a line's stat (newest first), for stats without full game rows. */
  readonly values?: (line: PropLine) => readonly number[] | undefined;
  /** Books that never count toward the fair price (the platform being priced: a book never confirms its own price). */
  readonly excludeBooks?: readonly string[];
  /** Projection 2.0 (spec §5): a multiplier on the stats projection for this line's game (team environment from game
   * lines, rest), with the plain-words reasons. The sportsbooks' prices already carry these, so only the stats source moves. */
  readonly statsAdjust?: (line: PropLine) => { readonly factor: number; readonly reasons: readonly string[] } | null;
  /** The honesty gate (spec §5.6): the stats source's measured weight for a sport and market, 0–1 (1 = as the standard
   * error says). Below 1 the stats source counts less in the blend. */
  readonly statsWeight?: (sport: string, market: string) => number;
  /** When the books last moved on this player and stat (ms), from the movement tracker; quotes older than that count 4× less. */
  readonly lastMoveAt?: (line: PropLine) => number | null;
  /** Each side's own payout on its platform; default: a standard pick'em payout (Goblins/Demons from alternateFactors). */
  readonly sidePayout?: (line: PropLine, side: PlayableDirection) => SidePayout;
}

/**
 * What one side pays. ENTRY: a pick'em leg whose entry payout is multiplied by `multiplier` (1 = standard; null = unknown,
 * so no edge). ODDS: a sportsbook single at decimal odds. `blocked` names why a side is never ranked as an edge (a
 * promo pick), while its probability still shows.
 */
export type SidePayout = { readonly kind: 'ENTRY'; readonly multiplier: number | null; readonly blocked?: string }
  | { readonly kind: 'ODDS'; readonly decimal: number };

/** Quarter Kelly, capped at 2% of bankroll per bet (spec §4; EDGE_KELLY_FRACTION can change the fraction). */
export const kellyStake = (p: number, decimal: number, fraction = .25) =>
  decimal > 1 ? clamp(fraction * (p * decimal - 1) / (decimal - 1), 0, .02) : 0;
/** An edge this big is almost always mismatched data (spec §6): held for review, never ranked. */
export const REVIEW_EDGE = .15;
export const REVIEW_BOOK_EV = .25;

/** A line Edge could not read, with the reason shown to the user instead of hiding the line. */
export interface UnpricedLine {
  readonly line: PropLine;
  readonly reason: 'NO_DATA' | 'NO_INDEPENDENT_READ';
  readonly note: string;
}

export interface PricingResult {
  readonly picks: EdgePick[];
  readonly unpriced: number;
  readonly unpricedLines: UnpricedLine[];
  readonly referenceEntry: EdgeEntry;
  readonly entries: EdgeEntry[];
  readonly quotesUsed: number;
}

export const normalizePlayerName = (value: string) => value.normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ').trim().replace(/\s+(jr|sr|ii|iii|iv|v)$/, '');

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const tierFactor: Record<EdgeTier, number> = { SHARP: 1, MARKET: .85, MODEL: .6, LADDER: .5 };
const prettyBook: Record<string, string> = { pinnacle: 'Pinnacle', fanduel: 'FanDuel',
  draftkings: 'DraftKings', betmgm: 'BetMGM', williamhill_us: 'Caesars', espnbet: 'ESPN BET',
  betonlineag: 'BetOnline', betrivers: 'BetRivers', hardrockbet: 'Hard Rock', novig: 'Novig',
  circasports: 'Circa', fanatics: 'Fanatics', bovada: 'Bovada', prophetx: 'ProphetX' };
const bookName = (key: string) => prettyBook[key] ?? key;

interface Source { readonly mean: number; readonly se: number }

interface MarketSource extends Source {
  readonly quotes: readonly FairQuote[];
  readonly sharp: boolean;
  readonly books: number;
  readonly spread: number;
}

function marketSource(quotes: readonly FairQuote[], profile: MarketProfile, reference: number): MarketSource | null {
  if (!quotes.length) return null;
  const fitted = quotes.map((quote) => {
    const mean = fitMean(profile.family, profile.variance, quote.point, quote.fairOver, profile.discrete);
    return { quote, mean, sd: Math.sqrt(varianceAt(profile.variance, mean)) };
  });
  const scale = Math.max(...fitted.map((item) => item.sd), 1e-6);
  // Quotes far from the PrizePicks threshold say less about it because the distribution
  // shape is only approximate in the tails.
  const weights = fitted.map((item) => item.quote.weight *
    Math.exp(-Math.abs(item.quote.point - reference) / (1.5 * scale)));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) return null;
  const mean = fitted.reduce((sum, item, index) => sum + weights[index] * item.mean, 0) / totalWeight;
  const dispersion = fitted.reduce((sum, item, index) => sum + weights[index] * (item.mean - mean) ** 2, 0) / totalWeight;
  const books = new Set(quotes.map((quote) => quote.bookmaker)).size;
  const sd = Math.sqrt(varianceAt(profile.variance, mean));
  // Books copy each other, so precision stops improving after ~2.5 sharp-equivalents.
  const se = Math.sqrt((.25 * sd / Math.sqrt(Math.min(totalWeight, 2.5))) ** 2 + dispersion / books);
  const means = fitted.map((item) => item.mean);
  return { mean, se, quotes, books, spread: Math.max(...means) - Math.min(...means),
    sharp: quotes.some((quote) => quote.twoSided && sharpBooks.has(quote.bookmaker)) };
}

function combine(sources: readonly (Source | null)[]): Source & { weights: number[] } {
  const present = sources.map((source) => source && source.se > 0 ? 1 / source.se ** 2 : 0);
  const precision = present.reduce((a, b) => a + b, 0);
  const mean = sources.reduce((sum, source, index) => sum + (source ? source.mean * present[index] : 0), 0) / precision;
  return { mean, se: Math.sqrt(1 / precision), weights: present.map((value) => value / precision) };
}

/** Edge's own line: the half-point where MORE and LESS are closest to 50/50 (for a continuous stat, the mean
 * rounded to the nearest half). This is the number Edge would set if it were the book. */
export function edgeLine(dist: Distribution): number {
  if (!dist.discrete) return Math.round(dist.mean * 2) / 2;
  const middle = median(dist);
  const candidates = [middle - 1.5, middle - .5, middle + .5].filter((value) => value > 0);
  if (!candidates.length) return .5;
  return candidates.reduce((best, value) =>
    Math.abs(conditionalOver(dist, value) - .5) < Math.abs(conditionalOver(dist, best) - .5) ? value : best);
}

const fmt = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);
const pct = (value: number) => (value * 100).toFixed(1) + '%';

/** Price every PrizePicks line on the board as a calibrated hit probability. */
/**
 * A Goblin/Demon's payout factor: (0.5 ÷ P)^k when P (the chance of clearing it with the regular line as a coin flip) and a
 * curve exponent are known, else the flat fallback. Goblins are kept in [0.4, 1] and Demons in [1, 5].
 */
export function alternateFactorFor(type: 'GOBLIN' | 'DEMON', chance: number | null, exponent: number | undefined, fallback: number | undefined): number | null {
  if (chance === null || exponent === undefined) return fallback ?? null;
  const raw = (.5 / clamp(chance, .01, .99)) ** exponent;
  return round(type === 'GOBLIN' ? clamp(raw, .4, 1) : clamp(raw, 1, 5), 2);
}

export function priceBoard(input: PricingInput): PricingResult {
  const entries = (input.entries?.length ? input.entries : defaultEntries).map((entry) => describeEntry(entry));
  const referenceEntry = entries.reduce((best, entry) => entry.breakEven < best.breakEven ? entry : best);
  const reference = referenceEntry.breakEven;
  const now = input.now.getTime();

  const quoteGroups = new Map<string, Map<string, MarketQuote>>();
  const excluded = new Set(input.excludeBooks ?? []);
  for (const quote of input.quotes ?? []) {
    if (excluded.has(quote.bookmaker)) continue;
    // The sport is part of the key: PrizePicks posts 1st-period/half lines (sport OTHER) on the same game id and stat name as
    // the full-game line, and a full-game book price must never price them.
    const key = [quote.sport, quote.eventId, normalizePlayerName(quote.playerName), quote.market].join('|');
    const group = quoteGroups.get(key) ?? new Map<string, MarketQuote>();
    const id = quote.bookmaker + '|' + quote.point;
    const existing = group.get(id);
    if (!existing || existing.fetchedAt < quote.fetchedAt) group.set(id, quote);
    quoteGroups.set(key, group);
  }

  const playerGroups = new Map<string, PropLine[]>();
  for (const line of input.lines) {
    if (Date.parse(line.eventStartTime) <= now) continue;
    const key = [line.sport, line.eventId, normalizePlayerName(line.playerName), line.market].join('|');
    playerGroups.set(key, [...(playerGroups.get(key) ?? []), line]);
  }

  const picks: EdgePick[] = [];
  let unpriced = 0, quotesUsed = 0;
  const unpricedLines: UnpricedLine[] = [];
  const appName = { prizepicks: 'PrizePicks', underdog: 'Underdog', pick6: 'DK Pick’em', draftkings: 'DraftKings',
    hardrock: 'Hard Rock' }[input.platform ?? 'prizepicks'];
  // The exact inputs missing, so a No read says what Edge would need.
  const missing = (games: number, hasRegular: boolean) => [
    'no sportsbook price for this player and stat',
    games ? `only ${games} game${games === 1 ? '' : 's'} of history (needs 5)` : 'fewer than 5 games of history found for this player and stat',
    ...(hasRegular ? [] : [`no regular ${appName} line to anchor it`])].join('; ');
  const skip = (lines: readonly PropLine[], reason: UnpricedLine['reason'], games = 0, hasRegular = false) => {
    unpriced += lines.length;
    const note = reason === 'NO_DATA' ? `No read: ${missing(games, hasRegular)}.`
      : `No read: ${missing(games, true)}; ${appName}'s own number is the only input, so Edge has no independent read.`;
    for (const line of lines) unpricedLines.push({ line, reason, note });
  };
  const historyCache = new Map<string, readonly StatRow[] | undefined>();
  for (const [key, lines] of playerGroups) {
    const first = lines[0];
    const profile = profileFor(first.sport, first.market);
    const regulars = [...new Set(lines.filter((line) => line.lineType === 'REGULAR').map((line) => line.threshold))];
    const regular = regulars.length === 1 ? regulars[0] : null;
    const thresholds = [...new Set(lines.map((line) => line.threshold))].sort((a, b) => a - b);
    const referencePoint = regular ?? thresholds[Math.floor(thresholds.length / 2)];

    const rawQuotes = [...(quoteGroups.get(key)?.values() ?? [])];
    // Freshness (spec §2.4): a quote's weight decays with its age, faster near the start (τ = 20 minutes inside two
    // hours of the game, 3 hours before that). A price the books haven't touched in a while says less about the line.
    const toStart = Date.parse(first.eventStartTime) - now;
    const tau = toStart < 2 * 3600_000 ? 20 * 60_000 : 3 * 3600_000;
    // A quote from before the books' latest move is about where the line was, not where it is: 4× less weight.
    const movedAt = input.lastMoveAt?.(first) ?? null;
    const paired = rawQuotes.map((quote) => {
      const fair = fairQuote(quote);
      if (!fair) return null;
      const seen = Date.parse(quote.observedAt ?? quote.fetchedAt), age = Math.max(0, now - seen);
      const behind = movedAt !== null && seen < movedAt ? .25 : 1;
      return { quote, fair: { ...fair, weight: fair.weight * Math.max(.1, Math.exp(-age / tau)) * behind } };
    }).filter((item): item is { quote: MarketQuote; fair: FairQuote } => !!item);
    const fair = paired.map((item) => item.fair);
    quotesUsed += fair.length;
    const market = marketSource(fair, profile, referencePoint);
    const bookRows = paired.map(({ quote, fair: item }) => ({ bookmaker: quote.bookmaker, point: quote.point,
      overPrice: quote.overPrice, underPrice: quote.underPrice, fairOver: round(item.fairOver),
      twoSided: item.twoSided })).sort((a, b) => a.point - b.point || a.bookmaker.localeCompare(b.bookmaker));

    let stats: StatProjection | null = null, games = 0;
    if (profile.stat && input.history) {
      const historyKey = first.sport + '|' + normalizePlayerName(first.playerName);
      if (!historyCache.has(historyKey)) historyCache.set(historyKey,
        input.history({ sport: first.sport, playerId: first.playerId, playerName: first.playerName }));
      const rows = historyCache.get(historyKey);
      if (rows?.length) stats = projectFromRows(rows, profile.stat, profile, first.eventStartTime, {}, first.market);
      games = rows?.length ?? 0;
    }
    if (!stats && input.values) {
      const recent = input.values(first);
      if (recent?.length) stats = projectFromValues(recent, profile);
      games = Math.max(games, recent?.length ?? 0);
    }
    const adjust = stats ? input.statsAdjust?.(first) ?? null : null;
    if (stats && adjust && Number.isFinite(adjust.factor) && adjust.factor > 0 && Math.abs(adjust.factor - 1) > 1e-3)
      stats = { ...stats, mean: stats.mean * adjust.factor };
    const honesty = stats ? clamp(input.statsWeight?.(first.sport, first.market) ?? 1, .05, 1) : 1;
    const statSource: Source | null = stats ? { mean: stats.mean, se: stats.standardError / Math.sqrt(honesty) } : null;

    // The regular line as a coin flip, for estimating each Goblin/Demon's payout factor from how far it sits from it.
    const regularDist = regular !== null ? (() => { const mean = fitMean(profile.family, profile.variance, regular, .5, profile.discrete);
      return makeDistribution(profile.family, mean, varianceAt(profile.variance, mean), profile.discrete); })() : null;
    const altFactor = (line: PropLine, side: PlayableDirection) => line.lineType !== 'GOBLIN' && line.lineType !== 'DEMON' ? null
      : alternateFactorFor(line.lineType, regularDist && input.alternateCurve?.[line.lineType] !== undefined
        ? (side === 'MORE' ? conditionalOver(regularDist, line.threshold) : 1 - conditionalOver(regularDist, line.threshold)) : null,
      input.alternateCurve?.[line.lineType], input.alternateFactors?.[line.lineType]);
    let ladder: (Source & { regularThreshold: number }) | null = null;
    if (regular !== null) {
      const mean = fitMean(profile.family, profile.variance, regular, .5, profile.discrete);
      const sd = Math.sqrt(varianceAt(profile.variance, mean));
      ladder = { mean, se: (market ? .6 : .4) * sd, regularThreshold: regular };
    }
    if (!market && !statSource && !ladder) { skip(lines, 'NO_DATA', games, regular !== null); continue; }

    const blend = combine([market, statSource, ladder]);
    const tier: EdgeTier = market ? (market.sharp && market.books >= 2 ? 'SHARP' : 'MARKET')
      : statSource ? 'MODEL' : 'LADDER';
    let outcomeVariance = varianceAt(profile.variance, blend.mean);
    if (stats && stats.samples >= 10) {
      const scaled = stats.variance * Math.max(blend.mean, .1) / Math.max(stats.mean, .1);
      outcomeVariance = .5 * outcomeVariance + .5 * scaled;
    }
    const dist: Distribution = makeDistribution(profile.family, blend.mean,
      outcomeVariance + blend.se ** 2, profile.discrete);
    const marketDist = market ? makeDistribution(profile.family, market.mean,
      varianceAt(profile.variance, market.mean), profile.discrete) : null;
    const calibrated = !!(input.calibration?.bySport[first.sport] ?? input.calibration?.global);
    const fairLine = edgeLine(dist);

    const byThreshold = new Map<number, PropLine[]>();
    for (const line of lines) byThreshold.set(line.threshold, [...(byThreshold.get(line.threshold) ?? []), line]);
    for (const [threshold, thresholdLines] of byThreshold) {
      const onlyLadder = tier === 'LADDER';
      const isRegular = thresholdLines.some((line) => line.lineType === 'REGULAR');
      if (onlyLadder && isRegular) { skip(thresholdLines, 'NO_INDEPENDENT_READ', games); continue; }
      const outcome = outcomeAt(dist, threshold);
      const over = conditionalOver(dist, threshold);
      const sides = thresholdLines.map((line) => line.availableDirections.map((side) => ({ line, side })))
        .flat();
      const payoutOf = (line: PropLine, side: PlayableDirection): SidePayout => input.sidePayout?.(line, side)
        ?? { kind: 'ENTRY', multiplier: line.lineType === 'REGULAR' ? 1 : altFactor(line, side) };
      const scored = sides.map(({ line, side }) => {
        const probability = applyCalibration(input.calibration, line.sport, side === 'MORE' ? over : 1 - over);
        const payout = payoutOf(line, side);
        // Each side against its own bar: a pick'em leg needs the entry's break-even divided by its multiplier; a sportsbook
        // bet needs 1 / decimal odds.
        const breakEven = payout.kind === 'ODDS' ? 1 / payout.decimal
          : payout.multiplier ? reference / payout.multiplier : reference;
        const edge = payout.kind === 'ENTRY' && (payout.multiplier === null || payout.blocked) ? null : probability - breakEven;
        return { line, side, probability, payout, breakEven, edge };
      }).sort((a, b) => (b.edge ?? -9) - (a.edge ?? -9) || b.probability - a.probability);
      const best = scored[0];
      const opposite = scored.find((item) => item.side !== best.side) ?? null;
      const p = best.probability;
      // Spec §6: an edge over 15 points, or over 25% EV on a sportsbook, is held for review until a second source agrees.
      const bookEv = best.payout.kind === 'ODDS' ? p * best.payout.decimal - 1 : null;
      const review = best.edge !== null && (best.edge > REVIEW_EDGE || (bookEv !== null && bookEv > REVIEW_BOOK_EV));
      // A sportsbook bet is only ranked when other books price the same player and stat: a model-only read against a book's
      // own odds hasn't earned that trust yet (spec §5.6 honesty gate).
      const unbacked = best.payout.kind === 'ODDS' && !market;
      // A book's far rungs sit in the distribution's tail, where Edge's estimate is least reliable: shown, not ranked, until
      // the track record (CLV, calibration) shows the tails hold up.
      const sd = Math.sqrt(dist.variance);
      // Yardage is right-skewed and Edge prices it with a symmetric normal: away from the numbers other books actually post,
      // the normal understates big games (high-rung unders look too good). Those rungs aren't ranked either.
      const nearestQuote = paired.reduce((best, item) => Math.min(best, Math.abs(item.quote.point - threshold)), Infinity);
      const skewed = best.payout.kind === 'ODDS' && profile.family === 'NORMAL' && /yds|yards/.test(first.market) && nearestQuote > .75 * sd;
      const tail = best.payout.kind === 'ODDS' && (Math.abs(threshold - dist.mean) > 1.5 * sd || skewed);
      const edge = best.edge;
      // Plus/minus piles up at 0 and swings on the whole team; no model here reads it well enough to rank.
      const unrankable = /plus_minus/.test(first.market);
      const adjusted = edge === null || review || unbacked || tail || unrankable ? null : edge * tierFactor[tier];
      const rating = adjusted === null ? 'NONE' : adjusted >= .07 ? 'ELITE' : adjusted >= .045 ? 'STRONG'
        : adjusted >= .02 ? 'VALUE' : adjusted > 0 ? 'THIN' : 'NONE';
      const edgeScore = adjusted === null ? 0 : round(clamp(50 + 600 * adjusted, 0, 100), 1);
      const side: PlayableDirection = best.side;
      const factor = best.payout.kind === 'ENTRY' ? best.payout.multiplier : best.payout.decimal;

      const reasons: string[] = [], warnings: string[] = [];
      const label = `${side} ${fmt(threshold)}`;
      if (market) {
        const names = [...new Set(market.quotes.map((quote) => bookName(quote.bookmaker)))].slice(0, 4).join(', ');
        const marketP = conditionalOver(marketDist!, threshold);
        reasons.push(`${tier === 'SHARP' ? 'Sharp consensus' : 'Sportsbook pricing'} (${names}) implies ${label} hits ${pct(side === 'MORE' ? marketP : 1 - marketP)}.`);
        const gap = market.mean - threshold;
        if (Math.abs(gap) >= .5 && isRegular) reasons.push(`Books project ${fmt(round(market.mean, 1))}, ${fmt(round(Math.abs(gap), 1))} ${gap > 0 ? 'above' : 'below'} the ${appName} line.`);
        if (market.books === 1) warnings.push('Only one sportsbook priced this player market.');
        if (!market.quotes.some((quote) => quote.twoSided)) warnings.push('Only one-sided (alternate) book prices; vig is estimated.');
        const sd = Math.sqrt(varianceAt(profile.variance, market.mean));
        if (market.books > 1 && market.spread > .5 * sd) warnings.push('Sportsbooks disagree on this player; treat the edge with caution.');
      } else {
        warnings.push('No sportsbook prices for this player market; model-only estimate.');
      }
      let hitRateAtLine: number | null = null;
      if (stats) {
        reasons.push(`Stats projection ${fmt(round(stats.mean, 1))} over ${stats.samples} games (last 5 avg ${fmt(round(stats.recentMean, 1))}).`);
        const decided = stats.values.filter((value) => value !== threshold);
        const hits = decided.filter((value) => side === 'MORE' ? value > threshold : value < threshold).length;
        if (decided.length) {
          hitRateAtLine = hits / decided.length;
          reasons.push(`${side === 'MORE' ? 'Cleared' : 'Stayed under'} ${fmt(threshold)} in ${hits} of ${decided.length} games.`);
        }
        if (stats.samples < 8) warnings.push(`Small stats sample (${stats.samples} games).`);
        for (const reason of adjust?.reasons ?? []) reasons.push(reason);
        if (honesty < .95) warnings.push(`The stats model counts less on this stat (${Math.round(honesty * 100)}% weight): it hasn’t matched the books on graded picks.`);
      }
      if (ladder && !isRegular && !market) reasons.push(`Priced from the ${appName} regular line ${fmt(ladder.regularThreshold)} using the ${profile.family === 'NORMAL' ? 'normal' : 'count'} distribution.`);
      if (tail && !unbacked) warnings.push(skewed && Math.abs(threshold - dist.mean) <= 1.5 * sd
        ? 'A yardage rung away from where other books price it: Edge’s curve is least reliable there (yardage is skewed), so it’s shown but not ranked.'
        : 'A far rung of the book’s ladder (more than 1.5 SD from Edge’s projection): shown but not ranked yet.');
      if (unbacked) warnings.push('No other sportsbook prices this player and stat: a stats-only read against the book’s odds is shown but not ranked.');
      if (review) warnings.push(`Held for review: a ${pct(edge!)} edge is bigger than real edges get; usually the sources disagree on the stat or game.`);
      if (best.payout.kind === 'ENTRY' && best.payout.blocked) warnings.push(best.payout.blocked);
      if (unrankable) warnings.push('Plus/minus isn’t ranked: it swings on the whole team and no model reads it reliably.');
      if (factor !== null && best.payout.kind === 'ENTRY' && (best.line.lineType === 'GOBLIN' || best.line.lineType === 'DEMON') && !input.sidePayout)
        warnings.push(`Payout ${factor}× is Edge's estimate (the app often pays a bit more); worth it at ${round(reference / p, 2)}× or better. Power only.`);
      if (factor === null && best.line.lineType !== 'REGULAR') warnings.push(
        `${best.line.lineType === 'UNKNOWN_ALTERNATE' ? 'Alternate' : best.line.lineType} payout factor is unknown: worth it only if its payout factor is at least ${round(reference / p, 2)}×.`);
      if (outcome.push > .04) warnings.push(`${pct(outcome.push)} chance of landing exactly on ${fmt(threshold)} (pick is removed).`);
      const minutesToStart = (Date.parse(best.line.eventStartTime) - now) / 60_000;
      if (minutesToStart < 45) warnings.push('Starts soon; confirm the line is still offered and the player is active.');

      picks.push({
        platform: input.platform ?? 'prizepicks',
        key: key + '|' + threshold, lineId: best.line.id, oppositeLineId: opposite?.line.id ?? null,
        sport: best.line.sport, league: best.line.league, eventId: best.line.eventId,
        eventName: best.line.eventName, eventStartTime: best.line.eventStartTime,
        playerId: best.line.playerId, playerName: best.line.playerName, team: best.line.team ?? null, market: best.line.market,
        threshold, lineType: best.line.lineType, side,
        probability: round(p), pushProbability: round(outcome.push), oppositeProbability: round(1 - p),
        breakEven: round(best.breakEven), edge: edge === null ? null : round(edge),
        requiredPayoutFactor: round((best.payout.kind === 'ODDS' ? 1 : reference) / Math.max(p, 1e-4), 3), edgeScore, rating, tier,
        projection: { mean: round(dist.mean, 2), median: median(dist), sd: round(Math.sqrt(dist.variance), 2),
          family: dist.family },
        fairLine,
        lineGap: market ? round(market.mean - threshold, 2) : stats ? round(stats.mean - threshold, 2) : null,
        sources: {
          market: market ? { mean: round(market.mean, 2), weight: round(blend.weights[0]),
            books: bookRows } : null,
          stats: stats ? { mean: round(stats.mean, 2), weight: round(blend.weights[1]), samples: stats.samples,
            recentMean: round(stats.recentMean, 2), seasonMean: round(stats.seasonMean, 2),
            hitRateAtLine: hitRateAtLine === null ? null : round(hitRateAtLine) } : null,
          ladder: ladder ? { mean: round(ladder.mean, 2), weight: round(blend.weights[2]),
            regularThreshold: ladder.regularThreshold } : null,
        },
        reasons, warnings, calibrated, modelVersion: EDGE_MODEL_VERSION,
        ...(best.payout.kind === 'ODDS' ? { decimalOdds: round(best.payout.decimal, 3), payoutMultiplier: round(best.payout.decimal, 3),
          ev: round(p * best.payout.decimal - 1), kelly: round(kellyStake(p, best.payout.decimal)) }
          : best.payout.multiplier && best.payout.multiplier !== 1 ? { payoutMultiplier: best.payout.multiplier } : {}),
      });
    }
  }
  picks.sort((a, b) => (b.edge === null ? -1 : 1) - (a.edge === null ? -1 : 1) ||
    b.edgeScore - a.edgeScore || b.probability - a.probability);
  return { picks, unpriced, unpricedLines, referenceEntry, entries, quotesUsed };
}

