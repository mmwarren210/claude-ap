// Edge 2.0 evaluation (spec §9): how Edge's picks did, measured only on their own terms. CLV first (does the close move
// toward Edge's side?), then hit rate against break-even with a 95% interval, ROI with a bootstrap interval, and
// calibration by 5-point buckets.

export interface GradedPick {
  readonly hit: boolean;
  /** Edge's chance at first sighting and at the last sighting before the start (its view at the close). */
  readonly firstProbability: number;
  readonly closeProbability: number;
  /** What the side needed to break even when first shown (pick'em: entry break-even ÷ multiplier; books: 1 ÷ odds). */
  readonly breakEven: number;
  /** Sportsbook odds taken (decimal); absent for pick'em legs, which are valued at a fair 1 ÷ break-even payout. */
  readonly decimal?: number;
}

export interface Interval { readonly value: number; readonly low: number; readonly high: number }

/** Wilson 95% interval for a hit rate. */
export function wilson(hits: number, n: number): Interval | null {
  if (!n) return null;
  const z = 1.96, p = hits / n, denominator = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denominator, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return { value: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Mean with a normal 95% interval. */
export function meanInterval(values: readonly number[]): Interval | null {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
  const half = 1.96 * Math.sqrt(variance / values.length);
  return { value: mean, low: mean - half, high: mean + half };
}

/** Bootstrap 95% interval for the mean (deterministic seed, so reports don't jitter). */
export function bootstrapInterval(values: readonly number[], iterations = 1000, seed = 7): Interval | null {
  if (!values.length) return null;
  let state = seed >>> 0;
  const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < values.length; j++) total += values[Math.floor(random() * values.length)]!;
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { value: mean, low: means[Math.floor(.025 * iterations)]!, high: means[Math.ceil(.975 * iterations) - 1]! };
}

export interface Bucket { readonly from: number; readonly to: number; readonly n: number; readonly forecast: number; readonly hitRate: number }

/** 5-point calibration buckets of Edge's forecast against the hit rate. */
export function calibrationBuckets(picks: readonly GradedPick[], width = .05): Bucket[] {
  const buckets = new Map<number, GradedPick[]>();
  for (const pick of picks) {
    const index = Math.min(Math.floor(pick.closeProbability / width), Math.floor(1 / width) - 1);
    buckets.set(index, [...buckets.get(index) ?? [], pick]);
  }
  return [...buckets].sort((a, b) => a[0] - b[0]).map(([index, list]) => ({ from: index * width, to: (index + 1) * width, n: list.length,
    forecast: list.reduce((sum, pick) => sum + pick.closeProbability, 0) / list.length,
    hitRate: list.filter((pick) => pick.hit).length / list.length }));
}

export interface Evaluation {
  readonly graded: number;
  readonly hitRate: Interval | null;
  readonly averageBreakEven: number | null;
  /** Close-fair chance minus the break-even when the pick was shown (spec §9 CLV for DFS; for books, EV at the close). */
  readonly clv: Interval | null;
  /** Share of picks whose chance rose between first sighting and the close. */
  readonly beatClose: number | null;
  /** Return per $1: books at their odds; pick'em legs at a fair 1 ÷ break-even payout. */
  readonly roi: Interval | null;
  readonly brier: number | null;
  /** 1 − Brier(first chance) ÷ Brier(closing chance). */
  readonly brierSkill: number | null;
  readonly calibration: Bucket[];
  /** Largest gap between forecast and hit rate in buckets with 50+ picks (spec target ≤ 3 points). */
  readonly maxCalibrationGap: number | null;
}

/** Brier skill of the chance shown when the pick was made, against the closing chance: ≥ 0 means as good as the close (spec §9). */
export function brierSkill(picks: readonly GradedPick[]): number | null {
  if (!picks.length) return null;
  const score = (select: (pick: GradedPick) => number) => picks.reduce((sum, pick) => sum + (select(pick) - (pick.hit ? 1 : 0)) ** 2, 0);
  const close = score((pick) => pick.closeProbability);
  return close > 0 ? 1 - score((pick) => pick.firstProbability) / close : null;
}

export function evaluate(picks: readonly GradedPick[]): Evaluation {
  const hits = picks.filter((pick) => pick.hit).length;
  const clv = picks.map((pick) => pick.decimal ? pick.closeProbability * pick.decimal - 1 : pick.closeProbability - pick.breakEven);
  const roi = picks.map((pick) => pick.hit ? (pick.decimal ?? 1 / Math.max(pick.breakEven, 1e-3)) - 1 : -1);
  const calibration = calibrationBuckets(picks);
  const big = calibration.filter((bucket) => bucket.n >= 50);
  return { graded: picks.length, hitRate: wilson(hits, picks.length),
    averageBreakEven: picks.length ? picks.reduce((sum, pick) => sum + pick.breakEven, 0) / picks.length : null,
    clv: meanInterval(clv), beatClose: picks.length ? picks.filter((pick) => pick.closeProbability > pick.firstProbability).length / picks.length : null,
    roi: bootstrapInterval(roi), brier: picks.length ? picks.reduce((sum, pick) => sum + (pick.closeProbability - (pick.hit ? 1 : 0)) ** 2, 0) / picks.length : null,
    brierSkill: brierSkill(picks),
    calibration, maxCalibrationGap: big.length ? Math.max(...big.map((bucket) => Math.abs(bucket.forecast - bucket.hitRate))) : null };
}
