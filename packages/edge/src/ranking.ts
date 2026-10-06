import type { EdgePick } from '@crowniq/contracts';

// Spec §6: what the user sees first. rank = value × confidence × freshness, where value is the bet's EV (sportsbooks) or
// the edge in probability points (pick'em). Confidence: sharp consensus with 3+ books 1.0, other sharp reads 0.95, any
// sportsbook price 0.85, a stats-only read its measured honesty weight (0.6 until graded results say otherwise), a
// ladder-only read 0.5; halved when the books disagree. A line the books moved past in the last 30 minutes gets ×1.25,
// fading to ×1 at two hours.

export interface RankOptions {
  /** The stats model's measured weight by sport:market (spec §5.6); 0.6 when unmeasured. */
  readonly honesty?: (sport: string, market: string) => number;
  /** Tiers measured as not beating the close after 300 picks (spec §9): their picks' confidence is halved. */
  readonly weakTiers?: ReadonlySet<string>;
}

export function confidenceOf(pick: EdgePick, options: RankOptions = {}): number {
  const books = new Set(pick.sources.market?.books.map((book) => book.bookmaker) ?? []).size;
  const base = pick.tier === 'SHARP' ? books >= 3 ? 1 : .95 : pick.tier === 'MARKET' ? .85
    : pick.tier === 'MODEL' ? options.honesty?.(pick.sport, pick.market) ?? .6 : .5;
  const disagree = pick.warnings.some((warning) => warning.startsWith('Sportsbooks disagree')) ? .5 : 1;
  const weak = options.weakTiers && (options.weakTiers.has(pick.stale ? 'STALE' : pick.tier) ||
    options.weakTiers.has(`${pick.platform}:${pick.tier}`)) ? .5 : 1;
  return base * disagree * weak;
}

export function freshnessBoost(pick: EdgePick): number {
  if (!pick.stale) return 1;
  const minutes = pick.stale.minutesAgo;
  return minutes <= 30 ? 1.25 : minutes >= 120 ? 1 : 1.25 - .25 * (minutes - 30) / 90;
}

/** The sort score; null for picks that are never ranked (no edge, rating NONE). */
export function rankScore(pick: EdgePick, options: RankOptions = {}): number | null {
  if (pick.edge === null || pick.rating === 'NONE') return null;
  const value = pick.ev ?? pick.edge;
  return Math.round(value * confidenceOf(pick, options) * freshnessBoost(pick) * 1e5) / 1e5;
}
