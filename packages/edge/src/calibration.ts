import { clamp } from './distributions.js';

export interface GradedForecast {
  readonly probability: number;
  /** The chance before any correction (what the correction is learned from). Older picks lack it and use `probability`. */
  readonly rawProbability?: number;
  readonly hit: boolean;
  readonly sport: string;
}

export interface PlattParameters { readonly a: number; readonly b: number; readonly samples: number }

/** A bucket-based (isotonic) correction: raw chance → observed hit rate, as knots joined by straight lines. */
export interface CalibrationCurve { readonly knots: readonly (readonly [number, number])[]; readonly samples: number }

export interface CalibrationModel {
  readonly global: CalibrationCurve | null;
  readonly bySport: Readonly<Record<string, CalibrationCurve>>;
}

export const logit = (p: number) => { const q = clamp(p, 1e-6, 1 - 1e-6); return Math.log(q / (1 - q)); };
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Logistic recalibration p' = σ(a + b·logit p), fit by Newton's method with a Gaussian
 * prior centred on the identity map (a=0, b=1) so small samples barely move it. */
export function fitPlatt(rows: readonly GradedForecast[], priorStrength = 50): PlattParameters {
  let a = 0, b = 1;
  for (let iteration = 0; iteration < 50; iteration++) {
    let ga = -priorStrength * a / 100, gb = -priorStrength * (b - 1) / 100;
    let haa = -priorStrength / 100, hab = 0, hbb = -priorStrength / 100;
    for (const row of rows) {
      const x = logit(row.probability), p = sigmoid(a + b * x), y = row.hit ? 1 : 0;
      const w = p * (1 - p);
      ga += y - p; gb += (y - p) * x;
      haa -= w; hab -= w * x; hbb -= w * x * x;
    }
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  // Never invert or explode the forecast: keep the slope in a sane range.
  return { a: clamp(a, -1, 1), b: clamp(b, .3, 1.5), samples: rows.length };
}

/**
 * The correction from graded picks (owner, 2026-10-11): Edge's raw chances, in 5-point buckets, against how often those picks
 * hit. Each bucket's rate is pulled toward its own raw chance by 30 picks' worth (small buckets barely move), then the buckets
 * are made non-decreasing (pool-adjacent-violators), so a higher raw chance never shows lower. It is learned from the raw
 * chance, never the corrected one, so it doesn't correct its own corrections. Beyond the outer buckets the curve follows the
 * end bucket's gap: nothing shows 95% unless picks like it hit that often.
 */
export function fitIsotonic(rows: readonly GradedForecast[], prior = 30, width = .05): CalibrationCurve {
  const bins = new Map<number, { n: number; hits: number; sum: number }>();
  for (const row of rows) {
    const p = clamp(row.rawProbability ?? row.probability, 0, 1), index = Math.min(Math.floor(p / width), Math.round(1 / width) - 1);
    const bin = bins.get(index) ?? { n: 0, hits: 0, sum: 0 };
    bin.n++; bin.sum += p; if (row.hit) bin.hits++; bins.set(index, bin);
  }
  const blocks = [...bins.entries()].sort((x, y) => x[0] - y[0]).map(([, bin]) => {
    const x = bin.sum / bin.n;
    return { x, weight: bin.n + prior, y: (bin.hits + prior * x) / (bin.n + prior), xs: [x] };
  });
  const merged: typeof blocks = [];
  for (const block of blocks) {
    merged.push(block);
    while (merged.length > 1 && merged[merged.length - 2].y > merged[merged.length - 1].y) {
      const top = merged.pop()!, below = merged.pop()!, weight = below.weight + top.weight;
      merged.push({ x: (below.x * below.weight + top.x * top.weight) / weight, weight,
        y: (below.y * below.weight + top.y * top.weight) / weight, xs: [...below.xs, ...top.xs] });
    }
  }
  // A pooled block keeps one knot per original bucket (a flat stretch), so the curve stays piecewise and monotone.
  const knots = merged.flatMap((block) => block.xs.map((x) => [x, clamp(block.y, .01, .99)] as const));
  return { knots, samples: rows.length };
}

export function fitCalibration(rows: readonly GradedForecast[], minimum = 150): CalibrationModel {
  const bySport: Record<string, CalibrationCurve> = {};
  for (const sport of new Set(rows.map((row) => row.sport))) {
    const subset = rows.filter((row) => row.sport === sport);
    if (subset.length >= minimum) bySport[sport] = fitIsotonic(subset);
  }
  return { global: rows.length >= minimum ? fitIsotonic(rows) : null, bySport };
}

/** A raw chance through the curve: straight lines between knots; past the ends, the end knot's gap carries on (capped). */
export function applyCurve(curve: CalibrationCurve, p: number): number {
  const knots = curve.knots;
  if (!knots.length) return p;
  if (p <= knots[0][0]) return clamp(p + knots[0][1] - knots[0][0], .01, Math.max(knots[0][1], .01));
  const last = knots[knots.length - 1];
  if (p >= last[0]) return clamp(p + last[1] - last[0], last[1], .99);
  for (let index = 1; index < knots.length; index++) {
    const [x1, y1] = knots[index], [x0, y0] = knots[index - 1];
    if (p <= x1) return x1 === x0 ? y1 : y0 + (y1 - y0) * (p - x0) / (x1 - x0);
  }
  return last[1];
}

export function applyCalibration(model: CalibrationModel | null | undefined, sport: string, p: number): number {
  const curve = model?.bySport[sport] ?? model?.global;
  return curve ? applyCurve(curve, p) : p;
}

export interface ForecastReport {
  readonly graded: number;
  readonly hitRate: number | null;
  readonly averageForecast: number | null;
  readonly brier: number | null;
  /** Brier skill vs always forecasting the observed hit rate (positive = skill). */
  readonly brierSkill: number | null;
  readonly logLoss: number | null;
  readonly bins: readonly { from: number; to: number; count: number; forecast: number; observed: number }[];
}

export function forecastReport(rows: readonly GradedForecast[]): ForecastReport {
  if (!rows.length) return { graded: 0, hitRate: null, averageForecast: null, brier: null,
    brierSkill: null, logLoss: null, bins: [] };
  const n = rows.length, hits = rows.filter((row) => row.hit).length, rate = hits / n;
  const brier = rows.reduce((sum, row) => sum + (row.probability - (row.hit ? 1 : 0)) ** 2, 0) / n;
  const reference = rate * (1 - rate);
  const logLoss = -rows.reduce((sum, row) => {
    const p = clamp(row.probability, 1e-6, 1 - 1e-6);
    return sum + (row.hit ? Math.log(p) : Math.log(1 - p));
  }, 0) / n;
  const edges = [0, .45, .5, .525, .55, .575, .6, .65, .7, .8, 1.0001];
  const bins = edges.slice(0, -1).map((from, index) => {
    const to = edges[index + 1];
    const subset = rows.filter((row) => row.probability >= from && row.probability < to);
    return { from, to: Math.min(to, 1), count: subset.length,
      forecast: subset.length ? subset.reduce((s, r) => s + r.probability, 0) / subset.length : 0,
      observed: subset.length ? subset.filter((r) => r.hit).length / subset.length : 0 };
  }).filter((bin) => bin.count > 0);
  return { graded: n, hitRate: rate, averageForecast: rows.reduce((s, r) => s + r.probability, 0) / n,
    brier, brierSkill: reference > 0 ? 1 - brier / reference : null, logLoss, bins };
}
