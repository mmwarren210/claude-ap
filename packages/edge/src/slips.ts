import type { EdgeEntry, EdgePick, EdgeSlip } from '@crowniq/contracts';
import { hitDistribution } from './payouts.js';

export interface SlipOptions {
  /** Legs allowed from one game; same-game legs are correlated and this model treats them as independent. */
  readonly maxPerEvent?: number;
  readonly slipsPerEntry?: number;
  readonly minEdge?: number;
  /** Games an entry needs (pick'em apps: 2; sportsbook parlays: 1). */
  readonly minEvents?: number;
}

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

/** A leg's value for building entries: its hit chance times its own payout multiplier (EV rises with both). */
export const legValue = (pick: EdgePick) => pick.probability * (pick.payoutMultiplier ?? 1);

export function evaluateSlip(entry: EdgeEntry, legs: readonly EdgePick[], options: { minEvents?: number } = {}): EdgeSlip {
  const probabilities = legs.map((leg) => leg.probability);
  const distribution = hitDistribution(probabilities);
  // Underdog / DK Pick'em multiply the entry's payout by each pick's own multiplier; a parlay's legs carry their odds.
  // (Only the all-hit payout is boosted by a parlay's odds; pick'em multipliers apply to every paying outcome.)
  const boost = legs.reduce((product, leg) => product * (leg.payoutMultiplier ?? 1), 1);
  const expected = distribution.reduce((sum, mass, hits) => sum + mass * (entry.payouts[String(hits)] ?? 0) * boost, 0);
  const events = new Map<string, number>();
  for (const leg of legs) events.set(leg.eventId, (events.get(leg.eventId) ?? 0) + 1);
  const sameGameLegs = [...events.values()].filter((count) => count > 1).reduce((a, b) => a + b, 0);
  const warnings: string[] = [];
  if (legs.length !== entry.size) warnings.push(`Entry needs ${entry.size} legs; ${legs.length} supplied.`);
  if (new Set(legs.map((leg) => leg.playerId)).size !== legs.length) warnings.push('The same player appears twice.');
  if (events.size < (options.minEvents ?? 2)) warnings.push('The app requires players from at least two teams; legs come from one game.');
  if (sameGameLegs) warnings.push(`${sameGameLegs} legs share a game with another leg; correlated outcomes make the EV approximate.`);
  if (legs.some((leg) => leg.edge === null)) warnings.push('Includes a line whose payout is unknown; EV assumes a standard payout for it.');
  return {
    entry,
    legs: legs.map((leg) => ({ lineId: leg.lineId, playerName: leg.playerName, market: leg.market,
      threshold: leg.threshold, side: leg.side, probability: leg.probability, eventId: leg.eventId, sport: leg.sport,
      ...(leg.payoutMultiplier ? { payoutMultiplier: leg.payoutMultiplier } : {}) })),
    allHitProbability: round(probabilities.reduce((a, b) => a * b, 1)),
    expectedReturn: round(expected), expectedProfit: round(expected - 1),
    hitDistribution: distribution.map((value) => round(value)), sameGameLegs, warnings,
  };
}

/** Best entries from positive-edge standard lines. Expected return rises with every leg's
 * probability, so choosing the highest-probability eligible legs is optimal for each size
 * under the one-player and per-game limits. */
export function buildSlips(picks: readonly EdgePick[], entries: readonly EdgeEntry[], options: SlipOptions = {}): EdgeSlip[] {
  const maxPerEvent = options.maxPerEvent ?? 2, perEntry = options.slipsPerEntry ?? 2;
  const minEvents = options.minEvents ?? 2;
  const pool = picks.filter((pick) => pick.edge !== null && pick.edge > (options.minEdge ?? 0) && pick.rating !== 'NONE')
    .sort((a, b) => legValue(b) - legValue(a));
  const slips: EdgeSlip[] = [];
  for (const entry of entries) {
    const used = new Set<string>();
    for (let variant = 0; variant < perEntry; variant++) {
      const legs: EdgePick[] = [], players = new Set<string>(), events = new Map<string, number>();
      for (const pick of pool) {
        if (legs.length === entry.size) break;
        if (used.has(pick.key) || players.has(pick.playerId) || (events.get(pick.eventId) ?? 0) >= maxPerEvent) continue;
        // Keep the last slot for a second game when every chosen leg shares one event.
        if (minEvents > 1 && legs.length === entry.size - 1 && events.size === 1 && events.has(pick.eventId)) continue;
        legs.push(pick); players.add(pick.playerId); events.set(pick.eventId, (events.get(pick.eventId) ?? 0) + 1);
      }
      if (legs.length < entry.size) break;
      const slip = evaluateSlip(entry, legs, { minEvents });
      if (slip.expectedProfit <= 0) break;
      slips.push(slip);
      // The next variant swaps out this slip's strongest leg so alternatives differ.
      used.add(legs[0].key);
    }
  }
  return slips.sort((a, b) => b.expectedProfit - a.expectedProfit);
}

export interface GenerateOptions {
  readonly count?: number;
  readonly maxPerEvent?: number;
  readonly sport?: string;
  /** Only legs starting within [from, to). */
  readonly from?: number;
  readonly to?: number;
  readonly minEdge?: number;
  /** How many generated entries one leg may appear in (1 = every entry uses different legs). */
  readonly maxLegUses?: number;
  readonly nowMs?: number;
  readonly minEvents?: number;
}

/** Edge Gen: several entries of one type and size from Edge's positive-edge standard lines. Each entry takes the
 * highest-probability eligible legs (EV rises with every leg's probability), one per player, at most `maxPerEvent`
 * per game and at least two games, and a leg is reused across entries at most `maxLegUses` times. */
export function generateEntries(picks: readonly EdgePick[], entry: EdgeEntry, options: GenerateOptions = {}): EdgeSlip[] {
  const count = options.count ?? 3, maxPerEvent = options.maxPerEvent ?? 2, maxUses = options.maxLegUses ?? 1;
  const now = options.nowMs ?? Date.now(), minEvents = options.minEvents ?? 2;
  const pool = picks.filter((pick) => pick.edge !== null && pick.edge > (options.minEdge ?? 0) && pick.rating !== 'NONE' &&
    Date.parse(pick.eventStartTime) > now && (!options.sport || pick.sport === options.sport) &&
    (options.from === undefined || Date.parse(pick.eventStartTime) >= options.from) &&
    (options.to === undefined || Date.parse(pick.eventStartTime) < options.to))
    .sort((a, b) => legValue(b) - legValue(a));
  const uses = new Map<string, number>(), slips: EdgeSlip[] = [];
  for (let index = 0; index < count; index++) {
    const legs: EdgePick[] = [], players = new Set<string>(), events = new Map<string, number>();
    for (const pick of pool) {
      if (legs.length === entry.size) break;
      if ((uses.get(pick.key) ?? 0) >= maxUses || players.has(pick.playerId) ||
        (events.get(pick.eventId) ?? 0) >= maxPerEvent) continue;
      if (minEvents > 1 && legs.length === entry.size - 1 && events.size === 1 && events.has(pick.eventId)) continue;
      legs.push(pick); players.add(pick.playerId); events.set(pick.eventId, (events.get(pick.eventId) ?? 0) + 1);
    }
    if (legs.length < entry.size) break;
    const slip = evaluateSlip(entry, legs, { minEvents });
    if (slip.expectedProfit <= 0) break;
    slips.push(slip);
    for (const leg of legs) uses.set(leg.key, (uses.get(leg.key) ?? 0) + 1);
  }
  return slips;
}
