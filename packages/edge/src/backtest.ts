import { clamp, conditionalOver, makeDistribution, normalCdf, outcomeAt } from './distributions.js';
import type { MarketProfile, StatRow, StatSpec } from './markets.js';
import { projectFromRows } from './projection.js';

export interface ProjectionBacktest {
  readonly games: number;
  readonly edge: { readonly logScore: number; readonly mae: number; readonly brierAtMedian: number };
  /** The original GKR projection: plain mean and SD of the last 10 games as a normal. */
  readonly baseline: { readonly logScore: number; readonly mae: number; readonly brierAtMedian: number };
}

/** Walk-forward comparison: predict each game only from earlier games, score the
 * probability assigned to the actual result (log score, higher is better), absolute
 * error, and the Brier score of an over/under call at a line set at the player's
 * trailing median (a stand-in for a fair line when the historical PrizePicks line is absent). */
export function backtestProjection(rows: readonly StatRow[], spec: StatSpec, profile: MarketProfile,
  market?: string, warmup = 8): ProjectionBacktest | null {
  const sorted = [...rows].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const totals = { edge: { log: 0, mae: 0, brier: 0 }, base: { log: 0, mae: 0, brier: 0 } };
  let games = 0;
  for (let index = warmup; index < sorted.length; index++) {
    const target = sorted[index];
    const actual = market && Number.isFinite(target.marketValues?.[market]) ? target.marketValues![market]
      : spec.value(target.metrics);
    const opportunity = spec.opportunity?.(target.metrics);
    if (actual === null || !Number.isFinite(actual) || opportunity === 0) continue;
    const prior = sorted.slice(0, index);
    const projection = projectFromRows(prior, spec, profile, target.occurredAt, {}, market);
    if (!projection) continue;
    const recent = projection.values.slice(0, 10);
    if (recent.length < 5) continue;
    const baseMean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const baseSd = Math.max(Math.sqrt(recent.reduce((s, v) => s + (v - baseMean) ** 2, 0) / (recent.length - 1)), .5);
    const sortedRecent = [...recent].sort((a, b) => a - b);
    const line = Math.floor(sortedRecent[Math.floor(sortedRecent.length / 2)]) + .5;
    const dist = makeDistribution(profile.family, projection.mean,
      projection.variance + projection.standardError ** 2, profile.discrete);
    const exact = Math.round(actual);
    const edgeMass = profile.discrete ? Math.max(outcomeAt(dist, exact).push, 1e-6)
      : Math.max(normalCdf((actual + .5 - dist.mean) / Math.sqrt(dist.variance)) -
        normalCdf((actual - .5 - dist.mean) / Math.sqrt(dist.variance)), 1e-6);
    const baseMass = Math.max(normalCdf((actual + .5 - baseMean) / baseSd) -
      normalCdf((actual - .5 - baseMean) / baseSd), 1e-6);
    const hit = actual > line ? 1 : 0;
    const edgeOver = conditionalOver(dist, line);
    const baseOver = clamp(1 - normalCdf((line - baseMean) / baseSd), 0, 1);
    totals.edge.log += Math.log(edgeMass); totals.base.log += Math.log(baseMass);
    totals.edge.mae += Math.abs(actual - projection.mean); totals.base.mae += Math.abs(actual - baseMean);
    totals.edge.brier += (edgeOver - hit) ** 2; totals.base.brier += (baseOver - hit) ** 2;
    games++;
  }
  if (!games) return null;
  return { games,
    edge: { logScore: totals.edge.log / games, mae: totals.edge.mae / games, brierAtMedian: totals.edge.brier / games },
    baseline: { logScore: totals.base.log / games, mae: totals.base.mae / games, brierAtMedian: totals.base.brier / games } };
}

