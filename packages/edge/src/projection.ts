import { varianceAt } from './distributions.js';
import type { MarketProfile, StatRow, StatSpec } from './markets.js';

export interface StatProjection {
  readonly mean: number;
  /** Game-to-game outcome variance (not the uncertainty of the mean). */
  readonly variance: number;
  /** Standard error of the projected mean, including a model-misspecification allowance. */
  readonly standardError: number;
  readonly samples: number;
  readonly recentMean: number;
  readonly seasonMean: number;
  readonly values: readonly number[];
}

export interface ProjectionOptions {
  readonly minSamples?: number;
  readonly maxSamples?: number;
  readonly rateHalfLife?: number;
  readonly opportunityHalfLife?: number;
}

const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;

function weighted(values: readonly number[], halfLife: number) {
  let total = 0, weights = 0, squares = 0;
  values.forEach((value, index) => {
    const weight = .5 ** (index / halfLife);
    total += weight * value; weights += weight; squares += weight * weight;
  });
  return { mean: total / weights, weightSum: weights, effective: weights * weights / squares };
}

/** A scoring event's projection blended toward a typical scorer's rate (the profile's prior), weighted by games. */
function withPrior(projected: number, games: number, profile: MarketProfile): number {
  return profile.prior ? (projected * games + profile.prior.mean * profile.prior.games) / (games + profile.prior.games) : projected;
}

/** Recency-weighted, shrunk projection from pre-event game rows.
 *
 * - DNP/inactive rows (zero opportunity) are removed instead of averaged in as zeros.
 * - With an opportunity measure, mean = projected opportunity × per-opportunity rate, so a
 *   role change (minutes, snaps, plate appearances) moves the projection immediately while
 *   efficiency is estimated over a longer window.
 * - Variance is the observed game-to-game variance shrunk toward the market profile.
 * - The standard error is inflated 1.5× because opponent, pace and role are not modeled. */
/** Projection from a player's recent values for one stat alone (newest first): the shared History values every tab uses,
 * for sports and stats without full game rows. Same shrinkage and 1.5× error inflation as `projectFromRows`. */
export function projectFromValues(recent: readonly number[], profile: MarketProfile,
  options: ProjectionOptions = {}): StatProjection | null {
  const values = recent.filter((value) => Number.isFinite(value)).slice(0, options.maxSamples ?? 40);
  if (values.length < (options.minSamples ?? 5)) return null;
  const seasonMean = mean(values), recentMean = mean(values.slice(0, 5));
  const weightedRecent = weighted(values, options.rateHalfLife ?? 8);
  const projected = withPrior(.65 * weightedRecent.mean + .35 * seasonMean, values.length, profile);
  const sampleVariance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - seasonMean) ** 2, 0) / (values.length - 1) : 0;
  const prior = varianceAt(profile.variance, projected);
  const variance = (values.length * sampleVariance + 15 * prior) / (values.length + 15);
  const sd = Math.sqrt(variance);
  const standardError = Math.sqrt((1.5 * sd / Math.sqrt(weightedRecent.effective)) ** 2 + (.15 * sd) ** 2);
  return { mean: projected, variance, standardError, samples: values.length, recentMean, seasonMean, values };
}

export function projectFromRows(rows: readonly StatRow[], spec: StatSpec, profile: MarketProfile,
  before: string, options: ProjectionOptions = {}, market?: string): StatProjection | null {
  const minSamples = options.minSamples ?? 4, maxSamples = options.maxSamples ?? 40;
  const cutoff = Date.parse(before);
  const games = rows.filter((row) => Date.parse(row.occurredAt) < cutoff)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .map((row) => {
      const override = market ? row.marketValues?.[market] : undefined;
      const value = Number.isFinite(override) ? override! : spec.value(row.metrics);
      const opportunity = spec.opportunity ? spec.opportunity(row.metrics) : null;
      return { value, opportunity };
    })
    .filter((game): game is { value: number; opportunity: number | null } =>
      game.value !== null && Number.isFinite(game.value) &&
      (game.opportunity === null || game.opportunity > 0))
    .slice(0, maxSamples);
  if (games.length < minSamples) return null;
  const values = games.map((game) => game.value);
  const seasonMean = mean(values), recentMean = mean(values.slice(0, 5));

  let projected: number, effective: number;
  const withOpportunity = games.every((game) => game.opportunity !== null);
  if (withOpportunity) {
    const opportunities = games.map((game) => game.opportunity!);
    // Role (minutes, snaps, PA) is persistent, so it uses a short half-life on its own.
    const shrunkOpportunity = weighted(opportunities, options.opportunityHalfLife ?? 4).mean;
    // Ratio of weighted sums is a stable rate estimate when opportunity varies by game.
    const halfLife = options.rateHalfLife ?? 10;
    let numerator = 0, denominator = 0;
    games.forEach((game, index) => {
      const weight = .5 ** (index / halfLife);
      numerator += weight * game.value; denominator += weight * game.opportunity!;
    });
    const rate = numerator / denominator;
    const longRate = values.reduce((a, b) => a + b, 0) / opportunities.reduce((a, b) => a + b, 0);
    const shrunkRate = .75 * rate + .25 * longRate;
    projected = shrunkOpportunity * shrunkRate;
    effective = weighted(values, halfLife).effective;
  } else {
    const recent = weighted(values, options.rateHalfLife ?? 8);
    projected = .65 * recent.mean + .35 * seasonMean;
    effective = recent.effective;
  }
  projected = withPrior(projected, values.length, profile);
  if (!Number.isFinite(projected)) return null;
  const sampleVariance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - seasonMean) ** 2, 0) / (values.length - 1) : 0;
  const prior = varianceAt(profile.variance, projected);
  const variance = (values.length * sampleVariance + 15 * prior) / (values.length + 15);
  const sd = Math.sqrt(variance);
  const standardError = Math.sqrt((1.5 * sd / Math.sqrt(effective)) ** 2 + (.15 * sd) ** 2);
  return { mean: projected, variance, standardError, samples: values.length, recentMean, seasonMean, values };
}
