import type { EdgeEntry, EdgePick, EdgeSlip } from '@crowniq/contracts';
import { hitDistribution } from './payouts.js';

export interface SlipOptions {
  /** Legs allowed from one game; same-game legs are correlated and this model treats them as independent. */
  readonly maxPerEvent?: number;
  readonly slipsPerEntry?: number;
  readonly minEdge?: number;
}

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

export function evaluateSlip(entry: EdgeEntry, legs: readonly EdgePick[]): EdgeSlip {
  const probabilities = legs.map((leg) => leg.probability);
  const distribution = hitDistribution(probabilities);
  const expected = distribution.reduce((sum, mass, hits) => sum + mass * (entry.payouts[String(hits)] ?? 0), 0);
  const events = new Map<string, number>();
  for (const leg of legs) events.set(leg.eventId, (events.get(leg.eventId) ?? 0) + 1);
  const sameGameLegs = [...events.values()].filter((count) => count > 1).reduce((a, b) => a + b, 0);
  const warnings: string[] = [];
  if (legs.length !== entry.size) warnings.push(`Entry needs ${entry.size} legs; ${legs.length} supplied.`);
  if (new Set(legs.map((leg) => leg.playerId)).size !== legs.length) warnings.push('The same player appears twice.');
  if (events.size < 2) warnings.push('PrizePicks requires players from at least two teams; legs come from one game.');
  if (sameGameLegs) warnings.push(`${sameGameLegs} legs share a game; outcomes are correlated, so treat the EV as approximate.`);
  if (legs.some((leg) => leg.edge === null)) warnings.push('Includes a non-standard line whose payout factor is unknown; EV assumes standard payout.');
  return {
    entry,
    legs: legs.map((leg) => ({ lineId: leg.lineId, playerName: leg.playerName, market: leg.market,
      threshold: leg.threshold, side: leg.side, probability: leg.probability, eventId: leg.eventId, sport: leg.sport })),
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
  const pool = picks.filter((pick) => pick.edge !== null && pick.edge > (options.minEdge ?? 0))
    .sort((a, b) => b.probability - a.probability);
  const slips: EdgeSlip[] = [];
  for (const entry of entries) {
    const used = new Set<string>();
    for (let variant = 0; variant < perEntry; variant++) {
      const legs: EdgePick[] = [], players = new Set<string>(), events = new Map<string, number>();
      for (const pick of pool) {
        if (legs.length === entry.size) break;
        if (used.has(pick.key) || players.has(pick.playerId) || (events.get(pick.eventId) ?? 0) >= maxPerEvent) continue;
        // Keep the last slot for a second game when every chosen leg shares one event.
        if (legs.length === entry.size - 1 && events.size === 1 && events.has(pick.eventId)) continue;
        legs.push(pick); players.add(pick.playerId); events.set(pick.eventId, (events.get(pick.eventId) ?? 0) + 1);
      }
      if (legs.length < entry.size) break;
      const slip = evaluateSlip(entry, legs);
      if (slip.expectedProfit <= 0) break;
      slips.push(slip);
      // The next variant swaps out this slip's strongest leg so alternatives differ.
      used.add(legs[0].key);
    }
  }
  return slips.sort((a, b) => b.expectedProfit - a.expectedProfit);
}
