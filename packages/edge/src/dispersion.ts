import { cdf, makeDistribution, normalCdf, varianceAt } from './distributions.js';
import type { VarianceModel } from './distributions.js';
import type { MarketProfile } from './markets.js';

// Learned dispersion (spec §2.1): each sport:market's variance function V(μ) = φμ + ψμ², fitted by maximum likelihood over
// player-games (each game's μ is that player's average), then shrunk toward the hand-set default with weight n/(n+500).
// Count markets fit ψ with φ = 1 (negative binomial). Normal markets fit φ and ψ. The probability integral transform of
// each actual result under the fitted distribution should be uniform. Its KS statistic is the check.

export interface DispersionFit {
  readonly n: number; readonly players: number;
  readonly phi: number; readonly psi: number;
  /** The maximum-likelihood values before shrinking toward the default. */
  readonly fittedPhi: number; readonly fittedPsi: number;
  readonly defaultPhi: number; readonly defaultPsi: number;
  /** KS distance of the (randomized) PIT from uniform, under the shrunk fit. */
  readonly ks: number;
}

export const DISPERSION_PRIOR_GAMES = 500;

function logGamma(x: number): number {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < .5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + g + .5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (x + i);
  return .5 * Math.log(2 * Math.PI) + (x + .5) * Math.log(t) - t + Math.log(a);
}

/** Log-likelihood of count k under a negative binomial with mean μ and variance μ + ψμ² (Poisson at ψ → 0). */
function negbinLog(k: number, mean: number, psi: number): number {
  const m = Math.max(mean, 1e-6);
  if (psi < 1e-6) return k * Math.log(m) - m - logGamma(k + 1);
  const r = 1 / psi;
  return logGamma(k + r) - logGamma(r) - logGamma(k + 1) + r * Math.log(r / (r + m)) + k * Math.log(m / (r + m));
}

function golden(f: (x: number) => number, low: number, high: number, steps = 50): number {
  const ratio = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < steps; i++) {
    const left = high - ratio * (high - low), right = low + ratio * (high - low);
    if (f(left) > f(right)) high = right; else low = left;
  }
  return (low + high) / 2;
}

interface Game { readonly value: number; readonly mean: number }

/** Each player-game as (value, the player's mean), keeping players with at least `minGames` games. */
export function playerGames(players: Iterable<readonly number[]>, minGames = 10, inflateResiduals = true): { games: Game[]; players: number } {
  const games: Game[] = [];
  let count = 0;
  for (const values of players) {
    const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
    if (clean.length < minGames) continue;
    count++;
    // The sample mean sits closer to its own games than the true mean does; scaling residuals by √(n/(n−1)) undoes that.
    // (Counts stay as observed integers; the small downward bias in ψ that leaves is well inside the shrinkage.)
    const mean = clean.reduce((a, b) => a + b, 0) / clean.length, inflate = inflateResiduals ? Math.sqrt(clean.length / (clean.length - 1)) : 1;
    for (const value of clean) games.push({ value: mean + (value - mean) * inflate, mean });
  }
  return { games, players: count };
}

/** The KS distance of the PIT values from uniform. */
export function ksUniform(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  let distance = 0;
  sorted.forEach((value, index) => { distance = Math.max(distance, (index + 1) / n - value, value - index / n); });
  return distance;
}

/** Randomized PIT of each game under `model` (for counts: F(k−1) + U·P(k), so it is exactly uniform when the model is right). */
export function pitValues(games: readonly Game[], profile: MarketProfile, model: VarianceModel, seed = 11): number[] {
  let state = seed >>> 0;
  const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  return games.map((game) => {
    const dist = makeDistribution(profile.family, game.mean, varianceAt(model, game.mean), profile.discrete);
    if (dist.family === 'NORMAL') return normalCdf((game.value - dist.mean) / Math.sqrt(dist.variance));
    const k = Math.round(game.value), below = cdf(dist, k - 1), at = cdf(dist, k);
    return below + random() * (at - below);
  });
}

/** Fits one market's variance function from player-games; null with fewer than 200 games. */
export function fitDispersion(players: Iterable<readonly number[]>, profile: MarketProfile): DispersionFit | null {
  const { games, players: count } = playerGames(players, 10, profile.family === 'NORMAL');
  if (games.length < 200) return null;
  const defaults = profile.variance;
  let fittedPhi = defaults.phi, fittedPsi = defaults.psi;
  if (profile.family === 'NORMAL') {
    const floor = defaults.floor ?? 1e-6;
    const log = (phi: number, psi: number) => games.reduce((sum, game) => {
      const variance = Math.max(phi * game.mean + psi * game.mean * game.mean, floor);
      return sum - .5 * Math.log(variance) - (game.value - game.mean) ** 2 / (2 * variance);
    }, 0);
    for (let round = 0; round < 6; round++) {
      fittedPhi = golden((phi) => log(phi, fittedPsi), 0, Math.max(10, defaults.phi * 10));
      fittedPsi = golden((psi) => log(fittedPhi, psi), 0, Math.max(1, defaults.psi * 10));
    }
  } else {
    const counts = games.map((game) => ({ k: Math.max(0, Math.round(game.value)), mean: game.mean }));
    fittedPhi = 1;
    fittedPsi = golden((psi) => counts.reduce((sum, game) => sum + negbinLog(game.k, game.mean, psi), 0), 0, 2, 60);
  }
  const weight = games.length / (games.length + DISPERSION_PRIOR_GAMES);
  const phi = weight * fittedPhi + (1 - weight) * defaults.phi, psi = weight * fittedPsi + (1 - weight) * defaults.psi;
  const model: VarianceModel = { ...defaults, phi, psi };
  return { n: games.length, players: count, phi, psi, fittedPhi, fittedPsi, defaultPhi: defaults.phi, defaultPsi: defaults.psi,
    ks: ksUniform(pitValues(games, profile, model)) };
}
