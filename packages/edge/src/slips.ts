import type { EdgeEntry, EdgePick, EdgeSlip } from '@crowniq/contracts';
import { entryGrowth, SIMULATION_DRAWS, slipDistribution } from './correlation.js';

export interface SlipOptions {
  /** Legs allowed from one game; same-game legs are priced with CrownIQ's prior correlations. */
  readonly maxPerEvent?: number;
  readonly slipsPerEntry?: number;
  readonly minEdge?: number;
  /** Games an entry needs (pick'em apps: 2; sportsbook parlays: 1). */
  readonly minEvents?: number;
}

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

/** A leg's value for building entries: its hit chance times its own payout multiplier (EV rises with both). */
export const legValue = (pick: EdgePick) => pick.probability * (pick.payoutMultiplier ?? 1);

export interface EvaluateOptions {
  readonly minEvents?: number;
  /** Copula draws when a pair is correlated (20k by default; the builder's search uses fewer). */
  readonly draws?: number;
}

const pct = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

export function evaluateSlip(entry: EdgeEntry, legs: readonly EdgePick[], options: EvaluateOptions = {}): EdgeSlip {
  const probabilities = legs.map((leg) => leg.probability);
  // Same-game pairs get CrownIQ's prior correlations (spec §7); without any, this is the exact independent closed form.
  const { independent, correlated: distribution, pairs } = slipDistribution(legs, options.draws ?? SIMULATION_DRAWS);
  // Underdog / DK Pick'em multiply the entry's payout by each pick's own multiplier; a parlay's legs carry their odds.
  // (Only the all-hit payout is boosted by a parlay's odds; pick'em multipliers apply to every paying outcome.)
  const boost = legs.reduce((product, leg) => product * (leg.payoutMultiplier ?? 1), 1);
  const returns = (hits: number) => (entry.payouts[String(hits)] ?? 0) * boost;
  const expectedOf = (dist: readonly number[]) => dist.reduce((sum, mass, hits) => sum + mass * returns(hits), 0);
  const expected = expectedOf(distribution), independentExpected = expectedOf(independent);
  const kelly = entryGrowth(distribution, returns);
  const events = new Map<string, number>();
  for (const leg of legs) events.set(leg.eventId, (events.get(leg.eventId) ?? 0) + 1);
  const sameGameLegs = [...events.values()].filter((count) => count > 1).reduce((a, b) => a + b, 0);
  const warnings: string[] = [];
  if (legs.length !== entry.size) warnings.push(`Entry needs ${entry.size} legs; ${legs.length} supplied.`);
  if (new Set(legs.map((leg) => leg.playerId)).size !== legs.length) warnings.push('The same player appears twice.');
  if (events.size < (options.minEvents ?? 2)) warnings.push('The app requires players from at least two teams; legs come from one game.');
  if (sameGameLegs) warnings.push(`${sameGameLegs} legs share a game with another leg; the EV uses CrownIQ's prior correlations for them, not measured ones.`);
  if (legs.some((leg) => leg.edge === null)) warnings.push('Includes a line whose payout is unknown; EV assumes a standard payout for it.');
  const strongest = [...pairs].sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))[0];
  const lift = independentExpected > 0 ? expected / independentExpected - 1 : 0;
  return {
    entry,
    legs: legs.map((leg) => ({ lineId: leg.lineId, playerName: leg.playerName, market: leg.market,
      threshold: leg.threshold, side: leg.side, probability: leg.probability, eventId: leg.eventId, sport: leg.sport,
      ...(leg.payoutMultiplier ? { payoutMultiplier: leg.payoutMultiplier } : {}) })),
    allHitProbability: round(pairs.length ? distribution[legs.length] ?? 0 : probabilities.reduce((a, b) => a * b, 1)),
    expectedReturn: round(expected), expectedProfit: round(expected - 1),
    hitDistribution: distribution.map((value) => round(value)), sameGameLegs, warnings,
    kellyFraction: round(kelly.fraction), growth: round(kelly.growth, 6),
    ...(pairs.length ? {
      correlatedPairs: pairs.map((pair) => ({ a: legs[pair.a]!.lineId, b: legs[pair.b]!.lineId, rho: pair.rho, label: pair.label })),
      independentExpectedReturn: round(independentExpected),
      correlationNote: `${strongest!.label}${pairs.length > 1 ? ` (+${pairs.length - 1} more pair${pairs.length > 2 ? 's' : ''})` : ''}: ` +
        `${pct(lift)} EV vs independent.`,
    } : {}),
  };
}

export type SlipObjective = 'ev' | 'growth';
const objectiveOf = (slip: EdgeSlip, objective: SlipObjective) => objective === 'growth' ? slip.growth ?? 0 : slip.expectedReturn;

interface Limits { readonly maxPerEvent: number; readonly minEvents: number }

/** Whether `legs` with `candidate` in slot `index` (or appended) keeps one leg per player, the per-game cap and 2+ games. */
function fits(legs: readonly EdgePick[], candidate: EdgePick, index: number, size: number, limits: Limits): boolean {
  const next = legs.map((leg, i) => (i === index ? candidate : leg));
  if (index >= legs.length) next.push(candidate);
  if (new Set(next.map((leg) => leg.playerId)).size !== next.length) return false;
  const events = new Map<string, number>();
  for (const leg of next) events.set(leg.eventId, (events.get(leg.eventId) ?? 0) + 1);
  if ([...events.values()].some((count) => count > limits.maxPerEvent)) return false;
  return next.length < size || events.size >= limits.minEvents;
}

/**
 * Local search after the greedy fill (spec §7.3): try swapping each leg for one of the strongest unused legs and keep the
 * swap that most improves the objective (EV or log growth), up to three rounds. Correlated candidates are scored with
 * 4,000 draws on fixed random numbers, so comparisons are fair. Entries over 8 legs keep the greedy fill.
 */
function improve(entry: EdgeEntry, legs: EdgePick[], pool: readonly EdgePick[], allowed: (pick: EdgePick) => boolean,
  limits: Limits, objective: SlipObjective): EdgePick[] {
  if (legs.length > 8) return legs;
  const candidates = pool.filter((pick) => allowed(pick)).slice(0, 30);
  let current = legs, score = objectiveOf(evaluateSlip(entry, current, { minEvents: limits.minEvents, draws: 4000 }), objective);
  for (let round = 0; round < 3; round++) {
    let best: { legs: EdgePick[]; score: number } | null = null;
    for (let index = 0; index < current.length; index++) for (const candidate of candidates) {
      if (current.some((leg) => leg.key === candidate.key) || !fits(current, candidate, index, entry.size, limits)) continue;
      const next = current.map((leg, i) => (i === index ? candidate : leg));
      const value = objectiveOf(evaluateSlip(entry, next, { minEvents: limits.minEvents, draws: 4000 }), objective);
      if (value > (best?.score ?? score) + 1e-6) best = { legs: next, score: value };
    }
    if (!best) break;
    current = best.legs; score = best.score;
  }
  return current;
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
  /** How many generated entries one player may appear in (1 = every entry uses different players). */
  readonly maxLegUses?: number;
  /** Rank and build by expected return (default) or by Kelly log growth. */
  readonly objective?: SlipObjective;
  readonly nowMs?: number;
  readonly minEvents?: number;
}

/** Edge Gen: several entries of one type and size from Edge's positive-edge standard lines. Each entry takes the
 * highest-probability eligible legs (EV rises with every leg's probability), one per player, at most `maxPerEvent`
 * per game and at least two games, and a leg is reused across entries at most `maxLegUses` times. */
export function generateEntries(picks: readonly EdgePick[], entry: EdgeEntry, options: GenerateOptions = {}): EdgeSlip[] {
  const count = options.count ?? 3, maxPerEvent = options.maxPerEvent ?? 2, maxUses = options.maxLegUses ?? 1;
  const now = options.nowMs ?? Date.now(), minEvents = options.minEvents ?? 2, objective = options.objective ?? 'ev';
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
      if ((uses.get(pick.playerId) ?? 0) >= maxUses || players.has(pick.playerId) ||
        (events.get(pick.eventId) ?? 0) >= maxPerEvent) continue;
      if (minEvents > 1 && legs.length === entry.size - 1 && events.size === 1 && events.has(pick.eventId)) continue;
      legs.push(pick); players.add(pick.playerId); events.set(pick.eventId, (events.get(pick.eventId) ?? 0) + 1);
    }
    if (legs.length < entry.size) break;
    const chosen = improve(entry, legs, pool, (pick) => (uses.get(pick.playerId) ?? 0) < maxUses, { maxPerEvent, minEvents }, objective);
    const slip = evaluateSlip(entry, chosen, { minEvents });
    if (slip.expectedProfit <= 0) break;
    slips.push(slip);
    for (const leg of chosen) uses.set(leg.playerId, (uses.get(leg.playerId) ?? 0) + 1);
  }
  return objective === 'growth' ? slips.sort((a, b) => (b.growth ?? 0) - (a.growth ?? 0)) : slips;
}

/**
 * The custom slip checker's suggestion (spec §7.4): the single leg swap, from the strongest eligible legs, that adds the most
 * EV while keeping the app's rules. Null when no swap beats the slip by at least 0.5% of the stake.
 */
export function suggestSwap(entry: EdgeEntry, legs: readonly EdgePick[], picks: readonly EdgePick[],
  options: { minEvents?: number; maxPerEvent?: number; nowMs?: number } = {}): EdgeSlip['suggestion'] | null {
  const limits = { maxPerEvent: options.maxPerEvent ?? entry.size, minEvents: options.minEvents ?? 2 }, now = options.nowMs ?? Date.now();
  const base = evaluateSlip(entry, legs, { minEvents: limits.minEvents, draws: 4000 }).expectedReturn;
  const pool = picks.filter((pick) => pick.edge !== null && pick.edge > 0 && pick.rating !== 'NONE' && Date.parse(pick.eventStartTime) > now)
    .sort((a, b) => legValue(b) - legValue(a)).slice(0, 40);
  let best: NonNullable<EdgeSlip['suggestion']> | null = null;
  for (let index = 0; index < legs.length; index++) for (const candidate of pool) {
    if (legs.some((leg) => leg.key === candidate.key) || !fits(legs, candidate, index, entry.size, limits)) continue;
    const next = legs.map((leg, i) => (i === index ? candidate : leg));
    const value = evaluateSlip(entry, next, { minEvents: limits.minEvents, draws: 4000 }).expectedReturn;
    if (value - base >= .005 && value - base > (best?.gain ?? 0)) best = { replaceLineId: legs[index]!.lineId,
      replacePlayerName: legs[index]!.playerName, lineId: candidate.lineId, playerName: candidate.playerName, market: candidate.market,
      threshold: candidate.threshold, side: candidate.side, expectedReturn: round(value), gain: round(value - base) };
  }
  return best;
}
