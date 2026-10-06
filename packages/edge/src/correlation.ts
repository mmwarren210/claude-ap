import { normalCdf } from './distributions.js';
import { hitDistribution } from './payouts.js';

// Correlation-aware slips (spec §7). Legs from different games are independent. Legs from the same game get a correlation
// from the spec's priors. A slip with any correlated pair is priced by a Gaussian copula: 20k correlated normal draws, where
// leg i hits when its draw is below Φ⁻¹(pᵢ), so each leg keeps its own chance exactly. Slips with no correlated pairs use
// the exact independent closed form.
// The loadings are priors only. Estimating them from residuals needs game and team on CrownIQ's history rows, which they
// don't carry yet.

export interface CorrelationLeg {
  readonly playerId: string; readonly eventId: string; readonly sport: string; readonly market: string;
  readonly side: 'MORE' | 'LESS'; readonly team?: string | null | undefined;
}

export interface PairCorrelation { readonly a: number; readonly b: number; readonly rho: number; readonly label: string }

const passing = /pass(ing)?_(yards|yds|tds|completions|attempts)|^passing_yards$|player_pass_(tds|completions|attempts|yds)$/;
const receiving = /reception|receptions|receiving/;
const pitcherKs = /pitcher_strikeouts|^strikeouts$/;
const pitcherAllowed = /hits_allowed|earned_runs|walks_allowed/;
const batterHits = /^(batter_)?(hits|total_bases|hits_runs_rbis|singles|batter_hits_runs_rbis)$|batter_(hits|total_bases|hits_runs_rbis|singles)/;
const nbaPoints = /^(player_)?points$/;
const volume = /points|yds|yards|reception|hits|bases|runs|rbis|shots|goals|assists|fantasy|threes|rebounds|attempts|completions|targets|sot/;
const sameTeam = (a: CorrelationLeg, b: CorrelationLeg) => a.team && b.team ? a.team.toLowerCase() === b.team.toLowerCase() : null;

/**
 * The prior correlation between two legs' stats (over vs over), with a label; 0 for different games.
 * - QB passing ↔ his own receivers: +0.35.
 * - Same-team NBA points ↔ points: −0.05.
 * - Pitcher strikeouts ↔ opposing hitters' hits: −0.15. Pitcher hits/runs allowed ↔ opposing hitters' hits: +0.15.
 * - Any other two volume stats in one game share the game total: +0.05.
 */
export function priorCorrelation(a: CorrelationLeg, b: CorrelationLeg): { rho: number; label: string } | null {
  if (a.eventId !== b.eventId || a.playerId === b.playerId) return null;
  const team = sameTeam(a, b);
  const either = (left: RegExp, right: RegExp) => (left.test(a.market) && right.test(b.market)) || (left.test(b.market) && right.test(a.market));
  if ((a.sport === 'NFL' || a.sport === 'NCAAFB') && team === true && either(passing, receiving)) return { rho: .35, label: 'QB + receiver stack' };
  if ((a.sport === 'NBA' || a.sport === 'WNBA' || a.sport === 'NCAAB') && team === true && nbaPoints.test(a.market) && nbaPoints.test(b.market))
    return { rho: -.05, label: 'Teammates sharing points' };
  if (a.sport === 'MLB' && team === false && either(pitcherKs, batterHits)) return { rho: -.15, label: 'Pitcher strikeouts vs opposing hitters' };
  if (a.sport === 'MLB' && team === false && either(pitcherAllowed, batterHits)) return { rho: .15, label: 'Pitcher allowed vs opposing hitters' };
  if (volume.test(a.market) && volume.test(b.market)) return { rho: .05, label: 'Same game total' };
  return null;
}

/** The legs' correlation matrix in hit terms (a LESS side flips the sign), with the pairs that aren't zero. */
export function correlationMatrix(legs: readonly CorrelationLeg[]): { matrix: number[][]; pairs: PairCorrelation[] } {
  const matrix: number[][] = legs.map((_, i) => legs.map((__, j) => (i === j ? 1 : 0)));
  const pairs: PairCorrelation[] = [];
  for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
    const prior = priorCorrelation(legs[i]!, legs[j]!);
    if (!prior) continue;
    const rho = prior.rho * (legs[i]!.side === legs[j]!.side ? 1 : -1);
    matrix[i]![j] = matrix[j]![i] = rho;
    pairs.push({ a: i, b: j, rho, label: prior.label });
  }
  return { matrix, pairs };
}

/** Cholesky factor; a matrix that isn't positive definite has its off-diagonals shrunk until it is. */
export function cholesky(matrix: readonly (readonly number[])[]): number[][] {
  const n = matrix.length;
  for (let shrink = 1; shrink > 0; shrink -= .1) {
    const lower = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    let ok = true;
    for (let i = 0; i < n && ok; i++) for (let j = 0; j <= i; j++) {
      let sum = (i === j ? 1 : matrix[i]![j]! * shrink);
      for (let k = 0; k < j; k++) sum -= lower[i]![k]! * lower[j]![k]!;
      if (i === j) { if (sum <= 1e-9) { ok = false; break; } lower[i]![i] = Math.sqrt(sum); }
      else lower[i]![j] = sum / lower[j]![j]!;
    }
    if (ok) return lower;
  }
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)));
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9 after one Newton step). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-.00778489400243029, -.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [.00778469570904146, .32246712907004, 2.445134137143, 3.75440866190742];
  const low = .02425;
  let x: number;
  if (p < low) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  else if (p > 1 - low) { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  else { const q = p - .5, r = q * q; x = (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1); }
  const e = normalCdf(x) - p;
  return x - e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
}

/** A seeded generator (mulberry32) so the same slip always gets the same simulated EV. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SIMULATION_DRAWS = 20_000;

/**
 * The distribution of hits for legs with these chances and this correlation matrix, from `draws` copula draws. The same
 * draws, uncorrelated, are a control variate: the estimate is (correlated − uncorrelated) counts plus the exact independent
 * distribution. That is unbiased and far less noisy. At zero correlation it equals the closed form exactly.
 */
export function simulateHits(probabilities: readonly number[], matrix: readonly (readonly number[])[],
  draws = SIMULATION_DRAWS, seed = 20261006): number[] {
  const n = probabilities.length, lower = cholesky(matrix), cut = probabilities.map(normalQuantile);
  const next = random(seed), counts = new Array<number>(n + 1).fill(0);
  const z = new Array<number>(n);
  let spare: number | null = null;
  const gaussian = () => {
    if (spare !== null) { const value = spare; spare = null; return value; }
    const u = Math.max(next(), 1e-12), v = next(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  for (let draw = 0; draw < draws; draw++) {
    for (let i = 0; i < n; i++) z[i] = gaussian();
    let hits = 0, independentHits = 0;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const row = lower[i]!;
      for (let k = 0; k <= i; k++) sum += row[k]! * z[k]!;
      if (sum < cut[i]!) hits++;
      if (z[i]! < cut[i]!) independentHits++;
    }
    counts[hits]!++;
    counts[independentHits]!--;
  }
  const exact = hitDistribution(probabilities);
  const estimate = exact.map((mass, hits) => Math.max(0, mass + counts[hits]! / draws));
  const total = estimate.reduce((a, b) => a + b, 0);
  return estimate.map((mass) => mass / total);
}

/** The hit distribution for a slip: exact when no pair is correlated, simulated otherwise. */
export function slipDistribution(legs: readonly (CorrelationLeg & { probability: number })[], draws = SIMULATION_DRAWS) {
  const probabilities = legs.map((leg) => leg.probability);
  const independent = hitDistribution(probabilities);
  const { matrix, pairs } = correlationMatrix(legs);
  return { independent, correlated: pairs.length ? simulateHits(probabilities, matrix, draws) : independent, pairs };
}

/**
 * The Kelly fraction and expected log growth for an entry with these returns per hit count (stake multiples): the f in
 * [0, 1) that maximizes Σ P(h) log(1 − f + f·R(h)), found by golden-section search. Zero for an entry without positive EV.
 */
export function entryGrowth(distribution: readonly number[], returns: (hits: number) => number): { fraction: number; growth: number } {
  const ev = distribution.reduce((sum, mass, hits) => sum + mass * returns(hits), 0);
  if (ev <= 1) return { fraction: 0, growth: 0 };
  const growth = (f: number) => distribution.reduce((sum, mass, hits) => mass > 0 ? sum + mass * Math.log(1 - f + f * returns(hits)) : sum, 0);
  let low = 0, high = .999;
  const ratio = (Math.sqrt(5) - 1) / 2;
  for (let step = 0; step < 60; step++) {
    const left = high - ratio * (high - low), right = low + ratio * (high - low);
    if (growth(left) < growth(right)) low = left; else high = right;
  }
  const fraction = (low + high) / 2;
  return { fraction, growth: growth(fraction) };
}
