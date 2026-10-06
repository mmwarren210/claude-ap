/** Outcome distributions for player stats.
 *
 * Box-score stats are integers, so most markets use discrete families: Poisson when the
 * variance is close to the mean, negative binomial when it is larger. Large-scale stats
 * (yards, saves, fantasy points) use a normal approximation that is discretized for
 * integer stats so an integer PrizePicks line has a real push probability.
 */
export type Family = 'POISSON' | 'NEGBIN' | 'NORMAL';

export interface Distribution {
  readonly family: Family;
  readonly mean: number;
  readonly variance: number;
  /** Integer-valued outcome (true for every box-score count, false for fantasy points). */
  readonly discrete: boolean;
}

/** Variance as a function of the mean: V(μ) = φμ + ψμ² (+ floor). */
export interface VarianceModel {
  readonly phi: number;
  readonly psi: number;
  readonly floor?: number;
}

export interface Outcome { readonly over: number; readonly under: number; readonly push: number }

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Standard normal CDF (Abramowitz–Stegun 26.2.17, |error| < 7.5e-8). */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const density = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
    t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

export function varianceAt(model: VarianceModel, mean: number): number {
  const m = Math.max(mean, 0);
  return Math.max(model.phi * m + model.psi * m * m, model.floor ?? 1e-6);
}

export function makeDistribution(family: Family, mean: number, variance: number, discrete = true): Distribution {
  if (family === 'NORMAL') return { family, mean, variance: Math.max(variance, 1e-6), discrete };
  const m = Math.max(mean, 1e-6);
  // A count model cannot be under-dispersed; fall back to Poisson at variance ≈ mean.
  if (family === 'POISSON' || variance <= m * 1.0001) return { family: 'POISSON', mean: m, variance: m, discrete: true };
  return { family: 'NEGBIN', mean: m, variance, discrete: true };
}

/** Probability mass for k = 0..limit of a discrete family. */
function countPmf(dist: Distribution, limit: number): number[] {
  const out: number[] = new Array(limit + 1).fill(0);
  if (dist.family === 'POISSON') {
    let term = Math.exp(-dist.mean);
    if (term === 0) return normalPmf(dist, limit);
    for (let k = 0; k <= limit; k++) { out[k] = term; term *= dist.mean / (k + 1); }
    return out;
  }
  const r = dist.mean * dist.mean / (dist.variance - dist.mean);
  const p = r / (r + dist.mean);
  let term = Math.exp(r * Math.log(p));
  if (term === 0) return normalPmf(dist, limit);
  for (let k = 0; k <= limit; k++) { out[k] = term; term *= (k + r) / (k + 1) * (1 - p); }
  return out;
}

function normalPmf(dist: Distribution, limit: number): number[] {
  const sd = Math.sqrt(dist.variance);
  return Array.from({ length: limit + 1 }, (_, k) =>
    normalCdf((k + .5 - dist.mean) / sd) - normalCdf((k - .5 - dist.mean) / sd));
}

/** P(X ≤ k) for integer k. */
export function cdf(dist: Distribution, k: number): number {
  if (dist.family === 'NORMAL') {
    const sd = Math.sqrt(dist.variance);
    return normalCdf(((dist.discrete ? Math.floor(k) + .5 : k) - dist.mean) / sd);
  }
  if (k < 0) return 0;
  const pmf = countPmf(dist, Math.floor(k));
  return Math.min(1, pmf.reduce((sum, value) => sum + value, 0));
}

export function pmfAt(dist: Distribution, k: number): number {
  if (!dist.discrete || !Number.isInteger(k)) return 0;
  return Math.max(0, cdf(dist, k) - cdf(dist, k - 1));
}

/** Unconditional over/under/push probabilities at an exact threshold. */
export function outcomeAt(dist: Distribution, threshold: number): Outcome {
  if (!dist.discrete) {
    const over = 1 - normalCdf((threshold - dist.mean) / Math.sqrt(dist.variance));
    return { over, under: 1 - over, push: 0 };
  }
  if (Number.isInteger(threshold)) {
    const below = cdf(dist, threshold - 1), atOrBelow = cdf(dist, threshold);
    return { over: Math.max(0, 1 - atOrBelow), under: below, push: Math.max(0, atOrBelow - below) };
  }
  const under = cdf(dist, Math.floor(threshold));
  return { over: Math.max(0, 1 - under), under, push: 0 };
}

/** P(MORE wins | no push). PrizePicks and sportsbooks both refund an exact tie. */
export function conditionalOver(dist: Distribution, threshold: number): number {
  const result = outcomeAt(dist, threshold);
  const decided = result.over + result.under;
  return decided > 0 ? result.over / decided : .5;
}

export function median(dist: Distribution): number {
  if (!dist.discrete) return dist.mean;
  const sd = Math.sqrt(dist.variance);
  let k = Math.max(0, Math.floor(dist.mean - 6 * sd));
  while (cdf(dist, k) < .5 && k < dist.mean + 12 * sd + 50) k++;
  return k;
}

/** Find the mean μ such that P(over line | no push) = target under the variance model.
 * This translates a price at one line into a full distribution, which is then evaluated
 * at the PrizePicks threshold (including every Goblin/Demon rung). */
export function fitMean(family: Family, model: VarianceModel, line: number, targetOver: number,
  discrete = true): number {
  const target = clamp(targetOver, .01, .99);
  const scale = Math.sqrt(varianceAt(model, Math.max(Math.abs(line), 1))) + 1;
  const allowNegative = family === 'NORMAL';
  let lo = allowNegative ? line - 10 * scale : 1e-4;
  let hi = Math.max(line, 0) + 10 * scale + 1;
  const at = (mean: number) => conditionalOver(makeDistribution(family, mean, varianceAt(model, mean), discrete), line);
  for (let i = 0; i < 8 && at(hi) < target; i++) hi *= 2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < target) lo = mid; else hi = mid;
    if (hi - lo < 1e-6 * Math.max(1, Math.abs(mid))) break;
  }
  return (lo + hi) / 2;
}
