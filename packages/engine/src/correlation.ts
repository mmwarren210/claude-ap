import type { CorrelationPolicy } from './interfaces.js';

const PASSING = new Set(['passing_yards', 'player_pass_completions', 'player_pass_attempts', 'player_pass_tds']);
const RECEIVING = new Set(['player_reception_yds', 'player_receptions', 'player_receiving_targets']);

/**
 * Conservative Crown correlation rules:
 * - at most two legs from one event, so one game cannot decide most of an entry;
 * - no same-direction pair of a quarterback's passing market with a teammate's receiving
 *   market, whose outcomes move together.
 * Same-player and same-team limits are already enforced by auditCrown.
 */
export const conservativeCorrelationPolicy: CorrelationPolicy = (picks) => {
  const issues: string[] = [];
  const perEvent = new Map<string, number>();
  for (const { line } of picks) perEvent.set(line.eventId, (perEvent.get(line.eventId) ?? 0) + 1);
  if ([...perEvent.values()].some((count) => count > 2)) issues.push('SAME_EVENT_CONCENTRATION');
  for (const passer of picks) {
    if (!PASSING.has(passer.line.market) || !passer.line.team) continue;
    const stacked = picks.some((other) => other !== passer && RECEIVING.has(other.line.market) &&
      other.line.team === passer.line.team && other.analysis.direction === passer.analysis.direction);
    if (stacked) { issues.push('QB_RECEIVER_STACK'); break; }
  }
  return issues;
};
