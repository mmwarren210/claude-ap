import type { EdgePick } from '@crowniq/contracts';
import { rankScore } from '@crowniq/edge';

// GKR+ (owner approved 2026-10-07: "build the gkr+history+edge"): an opt-in model shown only to the owner, recorded and
// graded on its own ledger next to Edge. It changes no GKR or Edge score.
//
// For each line Edge reads, on the side Edge picks:
// 1. Edge's chance (books, stats and the other apps' numbers, as priced).
// 2. History at this exact number: the player's hit rate over recent games, shrunk toward 50/50 ((hits + 1) / (games + 2))
//    and weighted by sample size (0.6 × games / (games + 10): 15 games count 0.36 of Edge's weight).
// 3. GKR's side where GKR plays the line (PrizePicks, and Underdog / DK Pick'em / the books where GKR scores them): a nudge
//    of up to 0.3 in log-odds toward GKR's side, or away from it when GKR plays the other side, scaled by GKR's score.
// Blended in log-odds; the edge is the blended chance less the same break-even Edge uses. Picks Edge holds back (held for
// review, unbacked book bets, far rungs, promos) stay unranked here too.

export const GKR_PLUS_VERSION = 'gkr-plus-v1';

export interface GkrSide { readonly direction: 'MORE' | 'LESS'; readonly score: number }

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clampP = (p: number) => Math.min(.995, Math.max(.005, p));
const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Edge's ratings on the blended edge (Edge's own thresholds). */
export const ratingOf = (edge: number) => edge >= .07 ? 'ELITE' as const : edge >= .045 ? 'STRONG' as const
  : edge >= .02 ? 'VALUE' as const : edge > 0 ? 'THIN' as const : 'NONE' as const;

export function blendPick(pick: EdgePick, gkr: GkrSide | null): EdgePick {
  const stats = pick.sources.stats;
  const games = stats?.samples ?? 0, hitRate = stats?.hitRateAtLine ?? null;
  const parts: { logit: number; weight: number }[] = [{ logit: logit(clampP(pick.probability)), weight: 1 }];
  const reasons: string[] = [`Edge: ${Math.round(pick.probability * 100)}%.`];
  if (hitRate !== null && games >= 5) {
    const hits = Math.round(hitRate * games), shrunk = (hits + 1) / (games + 2), weight = .6 * games / (games + 10);
    parts.push({ logit: logit(shrunk), weight });
    reasons.push(`History: hit ${hits} of ${games} at ${pick.threshold} (counted ${Math.round(weight * 100)}% of Edge's weight).`);
  }
  let nudge = 0;
  if (gkr) {
    nudge = (gkr.direction === pick.side ? 1 : -1) * .3 * Math.min(1, Math.max(0, gkr.score) / 100);
    reasons.push(`GKR ${gkr.direction === pick.side ? 'agrees' : 'plays the other side'} (score ${Math.round(gkr.score)}).`);
  }
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  const probability = round(sigmoid(parts.reduce((sum, part) => sum + part.logit * part.weight, 0) / total + nudge));
  // Picks Edge holds back for a reason (it has a positive edge but no rating) stay held.
  const heldByEdge = pick.edge !== null && pick.edge > 0 && pick.rating === 'NONE';
  const edge = pick.edge === null ? null : round(probability - pick.breakEven);
  const rating = edge === null || heldByEdge ? 'NONE' as const : ratingOf(edge);
  // A sportsbook bet's EV and quarter-Kelly stake (capped at 2%) on the blended chance; Edge's entry EVs don't carry over.
  const { ev: _ev, kelly: _kelly, ...rest } = pick;
  const odds = pick.decimalOdds, ev = odds ? round(probability * odds - 1) : undefined;
  const kelly = odds && ev !== undefined ? round(Math.min(.02, Math.max(0, ev / (odds - 1) / 4))) : undefined;
  return { ...rest, probability, oppositeProbability: round(1 - probability), edge, rating,
    edgeScore: rating === 'NONE' ? 0 : round(Math.min(100, Math.max(0, 50 + 600 * edge!)), 1),
    rank: rating === 'NONE' ? undefined : edge!, modelVersion: GKR_PLUS_VERSION,
    reasons: [...reasons, ...pick.reasons], ...(ev !== undefined ? { ev, kelly } : {}) };
}

/** Blended picks, ranked by blended edge (unranked ones after, by chance). */
export function blendPicks(picks: readonly EdgePick[], gkrFor: (pick: EdgePick) => GkrSide | null): EdgePick[] {
  return picks.map((pick) => reRank(pick, blendPick(pick, gkrFor(pick))))
    .sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1) || b.probability - a.probability);
}

/**
 * GKR+'s own order (2026-10-08: the list kept Edge's rank after blending, so GKR+'s top was Edge's top). The blended value
 * times the trust Edge gave the read (its rank ÷ its value: price source, agreement, freshness); a fresh score when Edge had
 * no positive value to take that from.
 */
export function reRank(edge: EdgePick, blended: EdgePick): EdgePick {
  const before = edge.ev ?? edge.edge, after = blended.ev ?? blended.edge;
  if (after === null || after === undefined || blended.rating === 'NONE') { const { rank: _rank, ...rest } = blended; return rest; }
  const trust = edge.rank !== null && edge.rank !== undefined && before !== null && before !== undefined && before > 0 ? edge.rank / before : null;
  const rank = trust !== null ? Math.round(after * trust * 1e5) / 1e5 : rankScore(blended);
  if (rank === null) { const { rank: _rank, ...rest } = blended; return rest; }
  return { ...blended, rank };
}
