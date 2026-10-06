import { clamp } from './distributions.js';

export interface GradedForecast {
  readonly probability: number;
  readonly hit: boolean;
  readonly sport: string;
}

export interface PlattParameters { readonly a: number; readonly b: number; readonly samples: number }

export interface CalibrationModel {
  readonly global: PlattParameters | null;
  readonly bySport: Readonly<Record<string, PlattParameters>>;
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

export function fitCalibration(rows: readonly GradedForecast[], minimum = 150): CalibrationModel {
  const bySport: Record<string, PlattParameters> = {};
  for (const sport of new Set(rows.map((row) => row.sport))) {
    const subset = rows.filter((row) => row.sport === sport);
    if (subset.length >= minimum) bySport[sport] = fitPlatt(subset);
  }
  return { global: rows.length >= minimum ? fitPlatt(rows) : null, bySport };
}

export function applyCalibration(model: CalibrationModel | null | undefined, sport: string, p: number): number {
  const params = model?.bySport[sport] ?? model?.global;
  return params ? sigmoid(params.a + params.b * logit(p)) : p;
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
