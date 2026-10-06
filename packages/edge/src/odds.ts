import { clamp } from './distributions.js';
import { profileKey } from './markets.js';

/** Relative sharpness of each bookmaker's player-prop prices (1 = market-making book).
 * Weights only order the consensus; they are not claims of accuracy for any one book. */
export const bookWeights: Readonly<Record<string, number>> = {
  pinnacle: 1, circasports: .95, novig: .85, prophetx: .75, fanduel: .8, draftkings: .7,
  betonlineag: .65, lowvig: .65, williamhill_us: .55, espnbet: .5, hardrockbet: .5,
  betmgm: .45, betrivers: .4, fanatics: .45, bovada: .4, ballybet: .35, betparx: .35,
  fliff: .3, mybookieag: .3, betus: .3,
  // SharpAPI's book ids.
  hardrock: .5, betonline: .65, caesars: .55,
};
export const sharpBooks = new Set(['pinnacle', 'circasports', 'novig', 'fanduel', 'prophetx']);
export const defaultConsensusBooks = ['pinnacle', 'fanduel', 'draftkings', 'betmgm',
  'williamhill_us', 'espnbet', 'betonlineag', 'betrivers', 'hardrockbet'] as const;

// Learned weights (spec §2.2), keyed `${book}|${sport}` and, where a market has 300+ scored prices, `${book}|${sport}:${market}`.
let learnedWeights: ReadonlyMap<string, number> = new Map();
/** Replaces the learned book weights (empty map = the prior table above). */
export function setLearnedBookWeights(weights: ReadonlyMap<string, number>): void { learnedWeights = weights; }

/** A book's weight: learned for this sport and market when there is one, else the prior. */
export const bookWeight = (book: string, sport?: string, market?: string) =>
  (sport && market ? learnedWeights.get(`${book}|${profileKey(sport, market) ?? `${sport}:${market}`}`) : undefined) ??
  (sport ? learnedWeights.get(`${book}|${sport}`) : undefined) ?? bookWeights[book] ?? .3;

export interface BookScore { readonly book: string; readonly sport: string; readonly market: string; readonly errorSd: number }

/**
 * Learned book weights from scored prices (spec §2.2): each score is how far a book's de-vigged price some hours before the
 * start sat from the closing consensus of the *other* books, in SDs of the stat. Weight ∝ 1 / mean squared error, scaled
 * so the books' average matches the prior's, then shrunk toward the prior with 200 scores of prior per sport (and kept as
 * a per-market override only when that market has 300+ scores).
 */
export function learnBookWeights(scores: readonly BookScore[]): Map<string, { weight: number; n: number; mse: number; prior: number }> {
  const groups = new Map<string, { sse: number; n: number; book: string }>();
  const add = (key: string, book: string, error: number) => {
    const group = groups.get(key) ?? { sse: 0, n: 0, book };
    group.sse += error * error; group.n++; groups.set(key, group);
  };
  for (const score of scores) {
    if (!Number.isFinite(score.errorSd)) continue;
    const error = Math.min(Math.abs(score.errorSd), 3);
    add(`${score.book}|${score.sport}`, score.book, error);
    add(`${score.book}|${profileKey(score.sport, score.market) ?? `${score.sport}:${score.market}`}`, score.book, error);
  }
  const out = new Map<string, { weight: number; n: number; mse: number; prior: number }>();
  // Scale within each scope (a sport, or a sport:market) so learned weights stay on the prior's scale.
  const scopes = new Map<string, string[]>();
  for (const key of groups.keys()) { const scope = key.slice(key.indexOf('|') + 1); scopes.set(scope, [...scopes.get(scope) ?? [], key]); }
  for (const [scope, keys] of scopes) {
    const market = scope.includes(':'), minimum = market ? 300 : 30;
    const usable = keys.filter((key) => groups.get(key)!.n >= minimum && groups.get(key)!.sse > 0);
    if (usable.length < 2) continue;
    const priors = usable.map((key) => bookWeights[groups.get(key)!.book] ?? .3);
    const inverse = usable.map((key) => groups.get(key)!.n / groups.get(key)!.sse);
    const scale = priors.reduce((a, b) => a + b, 0) / inverse.reduce((a, b) => a + b, 0);
    usable.forEach((key, index) => {
      const group = groups.get(key)!, prior = priors[index]!, measured = clamp(inverse[index]! * scale, .05, 1.5);
      out.set(key, { weight: (group.n * measured + 200 * prior) / (group.n + 200), n: group.n, mse: group.sse / group.n, prior });
    });
  }
  return out;
}

/** Remove the bookmaker margin from a two-way price with the power method, which
 * corrects favourite–longshot bias better than proportional scaling: find k so that
 * (1/o₁)^k + (1/o₂)^k = 1. Returns the fair probability of the first side. */
export function devigPower(overPrice: number, underPrice: number): number {
  const a = 1 / overPrice, b = 1 / underPrice;
  if (a + b <= 1) return a / (a + b); // no margin (exchange) or arbitrage: normalize
  let lo = 1, hi = 10;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    if (a ** k + b ** k > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  return a ** k / (a ** k + b ** k);
}

/** One-sided prices (typical for alternate "X+" lines) carry a larger, unknown margin. */
export function devigOneSided(price: number, assumedMargin = .07): number {
  return clamp(1 / price / (1 + assumedMargin), .005, .995);
}

export interface FairQuote {
  readonly bookmaker: string;
  readonly point: number;
  readonly fairOver: number;
  readonly twoSided: boolean;
  readonly weight: number;
}

export function fairQuote(quote: { bookmaker: string; point: number;
  overPrice: number | null; underPrice: number | null; sport?: string; market?: string }): FairQuote | null {
  const { overPrice: over, underPrice: under } = quote;
  const weight = bookWeight(quote.bookmaker, quote.sport, quote.market);
  if (over !== null && under !== null) return { bookmaker: quote.bookmaker, point: quote.point,
    fairOver: devigPower(over, under), twoSided: true, weight };
  if (over !== null) return { bookmaker: quote.bookmaker, point: quote.point,
    fairOver: devigOneSided(over), twoSided: false, weight: weight * .5 };
  if (under !== null) return { bookmaker: quote.bookmaker, point: quote.point,
    fairOver: 1 - devigOneSided(under), twoSided: false, weight: weight * .5 };
  return null;
}
