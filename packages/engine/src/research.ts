import { evidenceSchema } from '@crowniq/contracts';
import type { Board, Evidence, PropLine } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from './interfaces.js';

export interface ResearchOutcome {
  readonly status: 'UNCONFIGURED' | ResearchHealth['status'];
  readonly evidence: readonly Evidence[];
  readonly health: ResearchHealth | null;
}

// These ceilings operate alongside the source's expiresAt, whichever is sooner.
// Short-lived status is never silently treated as current season context.
const maxEvidenceAgeMs: Readonly<Record<string, number>> = {
  'status:player_available': 60 * 60 * 1000,
  'status:starting_lineup': 2 * 60 * 60 * 1000,
  'status:starting_pitcher': 3 * 60 * 60 * 1000,
  'status:lineup_confirmed': 2 * 60 * 60 * 1000,
  'status:starting_goalie': 2 * 60 * 60 * 1000,
  'status:roster_confirmed': 6 * 60 * 60 * 1000,
  'status:qb_available': 6 * 60 * 60 * 1000,
  'status:weather_clear': 3 * 60 * 60 * 1000,
  'status:minutes_confirmed': 3 * 60 * 60 * 1000,
  'status:target_role_confirmed': 6 * 60 * 60 * 1000,
};

export function effectiveEvidenceExpiry(item: Evidence): number {
  const sourceExpiry = Date.parse(item.expiresAt);
  const maximumAge = maxEvidenceAgeMs[item.kind];
  return maximumAge === undefined ? sourceExpiry :
    Math.min(sourceExpiry, Date.parse(item.retrievedAt) + maximumAge + 1);
}

export function freshEvidenceFor(line: PropLine, evidence: readonly Evidence[], now: Date): Evidence[] {
  return evidence.filter((item) =>
    item.eventId === line.eventId &&
    (item.entityType === 'EVENT' || (item.entityType === 'PLAYER' && item.entityId === line.playerId) ||
      (item.entityType === 'TEAM' && item.entityId === line.team)) &&
    (item.market === null || item.market === line.market) &&
    Date.parse(item.retrievedAt) <= now.getTime() &&
    Date.parse(item.retrievedAt) < Date.parse(line.eventStartTime) &&
    effectiveEvidenceExpiry(item) > now.getTime()
  );
}

export function researchTargetsFor(board: Board): ResearchTarget[] {
  const targets: ResearchTarget[] = board.lines.map(({ eventId, eventName, eventStartTime, league,
    playerId, playerName, team, opponent, market, sport, homeTeam, awayTeam }) => ({
    eventId, eventName, eventStartTime, league, playerId, playerName,
    team, opponent, market, sport, homeTeam: homeTeam ?? null, awayTeam: awayTeam ?? null,
  }));
  return [...new Map(targets.map((target) => [
    [target.eventId, target.playerId, target.market].join('|'), target,
  ])).values()];
}

export async function collectResearch(board: Board, adapter: ResearchAdapter | null): Promise<ResearchOutcome> {
  if (!adapter) return { status: 'UNCONFIGURED', evidence: [], health: null };
  const uniqueTargets = researchTargetsFor(board);
  try {
    const raw = await adapter.research(uniqueTargets);
    const activeEvents = new Set(board.lines.map((line) => line.eventId));
    const evidence = raw.map((item) => evidenceSchema.parse(item)).filter((item) => activeEvents.has(item.eventId));
    const health = adapter.getHealth?.() ?? null;
    return { status: health?.status ?? 'OK', evidence, health };
  } catch {
    return { status: 'FAILED', evidence: [], health: adapter.getHealth?.() ?? null };
  }
}
