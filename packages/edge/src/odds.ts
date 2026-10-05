import { clamp } from './distributions.js';

/** Relative sharpness of each bookmaker's player-prop prices (1 = market-making book).
 * Weights only order the consensus; they are not claims of accuracy for any one book. */
export const bookWeights: Readonly<Record<string, number>> = {
  pinnacle: 1, circasports: .95, novig: .85, prophetx: .75, fanduel: .8, draftkings: .7,
  betonlineag: .65, lowvig: .65, williamhill_us: .55, espnbet: .5, hardrockbet: .5,
  betmgm: .45, betrivers: .4, fanatics: .45, bovada: .4, ballybet: .35, betparx: .35,
  fliff: .3, mybookieag: .3, betus: .3,
};
export const sharpBooks = new Set(['pinnacle', 'circasports', 'novig', 'fanduel', 'prophetx']);
export const defaultConsensusBooks = ['pinnacle', 'fanduel', 'draftkings', 'betmgm',
  'williamhill_us', 'espnbet', 'betonlineag', 'betrivers', 'hardrockbet'] as const;

export const bookWeight = (book: string) => bookWeights[book] ?? .3;

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
  overPrice: number | null; underPrice: number | null }): FairQuote | null {
  const { overPrice: over, underPrice: under } = quote;
  if (over !== null && under !== null) return { bookmaker: quote.bookmaker, point: quote.point,
    fairOver: devigPower(over, under), twoSided: true, weight: bookWeight(quote.bookmaker) };
  if (over !== null) return { bookmaker: quote.bookmaker, point: quote.point,
    fairOver: devigOneSided(over), twoSided: false, weight: bookWeight(quote.bookmaker) * .5 };
  if (under !== null) return { bookmaker: quote.bookmaker, point: quote.point,
    fairOver: 1 - devigOneSided(under), twoSided: false, weight: bookWeight(quote.bookmaker) * .5 };
  return null;
}
