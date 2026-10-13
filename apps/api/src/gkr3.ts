import type { Analysis, EdgePick } from '@crowniq/contracts';

// GKR 3 (owner, 2026-10-13: "add history and the way GKR+ operates to GKR 2, run it in shadow"): GKR 2's read, blended the way
// GKR+ blends, with the player's history at the number and Edge's market chance. Shadow only: recorded and graded on its own
// record beside GKR 2, never shown or scored on the app.

export const GKR3_VERSION = 'gkr3-shadow-v1';
/** GKR 3 plays a line when its blended chance on GKR 2's side is at least this. */
export const GKR3_MIN_CHANCE = 0.55;

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (p: number, low: number, high: number) => Math.min(high, Math.max(low, p));

export interface Gkr3Read { readonly side: 'MORE' | 'LESS'; readonly chance: number; readonly strength: number; readonly reasons: string[] }

/**
 * GKR 3 on one line: GKR 2's side, its score read as a chance (score ÷ 100, kept within 50–95%), Edge's chance on that side
 * (when Edge reads the line) and the player's hit rate at the number (shrunk toward even, counting more with more games, as
 * GKR+ does), averaged as log-odds. Null when GKR 2 passes or the blend falls under GKR3_MIN_CHANCE.
 */
export function gkr3Read(gkr2: Analysis | undefined, edge: EdgePick | undefined): Gkr3Read | null {
  if (!gkr2 || gkr2.direction === 'PASS' || gkr2.score === null) return null;
  const side = gkr2.direction as 'MORE' | 'LESS';
  const gkr2Chance = clamp(gkr2.score / 100, .5, .95);
  const parts = [{ logit: logit(gkr2Chance), weight: 1 }];
  const reasons = [`GKR 2: ${side} ${Math.round(gkr2.score)}.`];
  if (edge) {
    const chance = clamp(edge.side === side ? edge.probability : edge.oppositeProbability, .02, .98);
    parts.push({ logit: logit(chance), weight: 1 });
    reasons.push(`Edge: ${Math.round(chance * 100)}% on ${side}.`);
    const games = edge.sources.stats?.samples ?? 0, rate = edge.sources.stats?.hitRateAtLine ?? null;
    if (rate !== null && games >= 5) {
      const onSide = edge.side === side ? rate : 1 - rate, hits = Math.round(onSide * games);
      const weight = .6 * games / (games + 10);
      parts.push({ logit: logit((hits + 1) / (games + 2)), weight });
      reasons.push(`History: ${hits} of ${games} at ${edge.threshold} on ${side}.`);
    }
  }
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  const chance = Math.round(sigmoid(parts.reduce((sum, part) => sum + part.logit * part.weight, 0) / total) * 1e4) / 1e4;
  if (chance < GKR3_MIN_CHANCE) return null;
  return { side, chance, strength: Math.round(chance * 100), reasons };
}
