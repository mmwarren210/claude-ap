import type { EdgeEntry, EdgePick, EdgeTier, MarketQuote, PlayableDirection, PropLine } from '@crowniq/contracts';
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
import { projectFromRows } from './projection.js';
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
}

export interface PricingResult {
  readonly picks: EdgePick[];
  readonly unpriced: number;
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

const fmt = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);
const pct = (value: number) => (value * 100).toFixed(1) + '%';

/** Price every PrizePicks line on the board as a calibrated hit probability. */
export function priceBoard(input: PricingInput): PricingResult {
  const entries = (input.entries?.length ? input.entries : defaultEntries).map((entry) => describeEntry(entry));
  const referenceEntry = entries.reduce((best, entry) => entry.breakEven < best.breakEven ? entry : best);
  const reference = referenceEntry.breakEven;
  const now = input.now.getTime();

  const quoteGroups = new Map<string, Map<string, MarketQuote>>();
  for (const quote of input.quotes ?? []) {
    const key = [quote.eventId, normalizePlayerName(quote.playerName), quote.market].join('|');
    const group = quoteGroups.get(key) ?? new Map<string, MarketQuote>();
    const id = quote.bookmaker + '|' + quote.point;
    const existing = group.get(id);
    if (!existing || existing.fetchedAt < quote.fetchedAt) group.set(id, quote);
    quoteGroups.set(key, group);
  }

  const playerGroups = new Map<string, PropLine[]>();
  for (const line of input.lines) {
    if (Date.parse(line.eventStartTime) <= now) continue;
    const key = [line.eventId, normalizePlayerName(line.playerName), line.market].join('|');
    playerGroups.set(key, [...(playerGroups.get(key) ?? []), line]);
  }

  const picks: EdgePick[] = [];
  let unpriced = 0, quotesUsed = 0;
  const historyCache = new Map<string, readonly StatRow[] | undefined>();
  for (const [key, lines] of playerGroups) {
    const first = lines[0];
    const profile = profileFor(first.sport, first.market);
    const regulars = [...new Set(lines.filter((line) => line.lineType === 'REGULAR').map((line) => line.threshold))];
    const regular = regulars.length === 1 ? regulars[0] : null;
    const thresholds = [...new Set(lines.map((line) => line.threshold))].sort((a, b) => a - b);
    const referencePoint = regular ?? thresholds[Math.floor(thresholds.length / 2)];

    const rawQuotes = [...(quoteGroups.get(key)?.values() ?? [])];
    const paired = rawQuotes.map((quote) => ({ quote, fair: fairQuote(quote) }))
      .filter((item): item is { quote: MarketQuote; fair: FairQuote } => !!item.fair);
    const fair = paired.map((item) => item.fair);
    quotesUsed += fair.length;
    const market = marketSource(fair, profile, referencePoint);
    const bookRows = paired.map(({ quote, fair: item }) => ({ bookmaker: quote.bookmaker, point: quote.point,
      overPrice: quote.overPrice, underPrice: quote.underPrice, fairOver: round(item.fairOver),
      twoSided: item.twoSided })).sort((a, b) => a.point - b.point || a.bookmaker.localeCompare(b.bookmaker));

    let stats: StatProjection | null = null;
    if (profile.stat && input.history) {
      const historyKey = first.sport + '|' + normalizePlayerName(first.playerName);
      if (!historyCache.has(historyKey)) historyCache.set(historyKey,
        input.history({ sport: first.sport, playerId: first.playerId, playerName: first.playerName }));
      const rows = historyCache.get(historyKey);
      if (rows?.length) stats = projectFromRows(rows, profile.stat, profile, first.eventStartTime, {}, first.market);
    }
    const statSource: Source | null = stats ? { mean: stats.mean, se: stats.standardError } : null;

    let ladder: (Source & { regularThreshold: number }) | null = null;
    if (regular !== null) {
      const mean = fitMean(profile.family, profile.variance, regular, .5, profile.discrete);
      const sd = Math.sqrt(varianceAt(profile.variance, mean));
      ladder = { mean, se: (market ? .6 : .4) * sd, regularThreshold: regular };
    }
    if (!market && !statSource && !ladder) { unpriced += lines.length; continue; }

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

    const byThreshold = new Map<number, PropLine[]>();
    for (const line of lines) byThreshold.set(line.threshold, [...(byThreshold.get(line.threshold) ?? []), line]);
    for (const [threshold, thresholdLines] of byThreshold) {
      const onlyLadder = tier === 'LADDER';
      const isRegular = thresholdLines.some((line) => line.lineType === 'REGULAR');
      if (onlyLadder && isRegular) { unpriced += thresholdLines.length; continue; } // no independent view
      const outcome = outcomeAt(dist, threshold);
      const over = conditionalOver(dist, threshold);
      const sides = thresholdLines.map((line) => line.availableDirections.map((side) => ({ line, side })))
        .flat();
      const scored = sides.map(({ line, side }) => ({ line, side,
        probability: applyCalibration(input.calibration, line.sport, side === 'MORE' ? over : 1 - over) }))
        .sort((a, b) => b.probability - a.probability);
      const best = scored[0];
      const opposite = scored.find((item) => item.side !== best.side) ?? null;
      const p = best.probability;
      const factor = best.line.lineType === 'REGULAR' ? 1
        : best.line.lineType === 'GOBLIN' || best.line.lineType === 'DEMON'
          ? input.alternateFactors?.[best.line.lineType] ?? null : null;
      const edge = factor === null ? null : p * factor - reference;
      const adjusted = edge === null ? null : edge * tierFactor[tier];
      const rating = adjusted === null ? 'NONE' : adjusted >= .07 ? 'ELITE' : adjusted >= .045 ? 'STRONG'
        : adjusted >= .02 ? 'VALUE' : adjusted > 0 ? 'THIN' : 'NONE';
      const edgeScore = adjusted === null ? 0 : round(clamp(50 + 600 * adjusted, 0, 100), 1);
      const side: PlayableDirection = best.side;

      const reasons: string[] = [], warnings: string[] = [];
      const label = `${side} ${fmt(threshold)}`;
      if (market) {
        const names = [...new Set(market.quotes.map((quote) => bookName(quote.bookmaker)))].slice(0, 4).join(', ');
        const marketP = conditionalOver(marketDist!, threshold);
        reasons.push(`${tier === 'SHARP' ? 'Sharp consensus' : 'Sportsbook pricing'} (${names}) implies ${label} hits ${pct(side === 'MORE' ? marketP : 1 - marketP)}.`);
        const gap = market.mean - threshold;
        if (Math.abs(gap) >= .5 && isRegular) reasons.push(`Books project ${fmt(round(market.mean, 1))}, ${fmt(round(Math.abs(gap), 1))} ${gap > 0 ? 'above' : 'below'} the PrizePicks line.`);
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
      }
      if (ladder && !isRegular && !market) reasons.push(`Priced from the PrizePicks regular line ${fmt(ladder.regularThreshold)} using the ${profile.family === 'NORMAL' ? 'normal' : 'count'} distribution.`);
      if (factor === null && best.line.lineType !== 'REGULAR') warnings.push(
        `${best.line.lineType === 'UNKNOWN_ALTERNATE' ? 'Alternate' : best.line.lineType} payout factor is unknown: worth it only if its payout factor is at least ${round(reference / p, 2)}×.`);
      if (outcome.push > .04) warnings.push(`${pct(outcome.push)} chance of landing exactly on ${fmt(threshold)} (pick is removed).`);
      const minutesToStart = (Date.parse(best.line.eventStartTime) - now) / 60_000;
      if (minutesToStart < 45) warnings.push('Starts soon; confirm the line is still offered and the player is active.');

      picks.push({
        key: key + '|' + threshold, lineId: best.line.id, oppositeLineId: opposite?.line.id ?? null,
        sport: best.line.sport, league: best.line.league, eventId: best.line.eventId,
        eventName: best.line.eventName, eventStartTime: best.line.eventStartTime,
        playerId: best.line.playerId, playerName: best.line.playerName, market: best.line.market,
        threshold, lineType: best.line.lineType, side,
        probability: round(p), pushProbability: round(outcome.push), oppositeProbability: round(1 - p),
        breakEven: round(reference), edge: edge === null ? null : round(edge),
        requiredPayoutFactor: round(reference / Math.max(p, 1e-4), 3), edgeScore, rating, tier,
        projection: { mean: round(dist.mean, 2), median: median(dist), sd: round(Math.sqrt(dist.variance), 2),
          family: dist.family },
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
      });
    }
  }
  picks.sort((a, b) => (b.edge === null ? -1 : 1) - (a.edge === null ? -1 : 1) ||
    b.edgeScore - a.edgeScore || b.probability - a.probability);
  return { picks, unpriced, referenceEntry, entries, quotesUsed };
}

