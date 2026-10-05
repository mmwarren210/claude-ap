import type { CrownCandidate } from './interfaces.js';
import type { CorrelationPolicy, CrownBuildResult } from './interfaces.js';

export type CrownSize = 2 | 3 | 4 | 5 | 6;
export const crownMinimumLineScore: Readonly<Record<CrownSize, number>> = {
  2: 80, 3: 80, 4: 80, 5: 80, 6: 80,
};

export function auditCrown(picks: readonly CrownCandidate[], size: CrownSize,
  correlationPolicy?: CorrelationPolicy, now: Date = new Date()): string[] {
  const issues: string[] = [];
  if (picks.length !== size) issues.push('PICK_COUNT_MISMATCH');
  const players = new Set<string>();
  const apexTeams = new Set<string>();
  const teamCounts = new Map<string, number>();
  let apexPicks = 0;
  for (const { line, analysis } of picks) {
    if (players.has(line.playerId)) issues.push('DUPLICATE_PLAYER');
    players.add(line.playerId);
    if (analysis.lineId !== line.id || analysis.direction === 'PASS' || analysis.score === null ||
        !line.availableDirections.includes(analysis.direction) ||
        line.lineType === 'UNKNOWN_ALTERNATE' || !analysis.modelVersion) issues.push('INELIGIBLE_PICK');
    if (analysis.score !== null && analysis.score < crownMinimumLineScore[size]) {
      issues.push('BELOW_CROWN_MINIMUM');
    }
    // Snapshot age is disclosed to the user; the event start is the hard line cutoff.
    if (Date.parse(line.eventStartTime) <= now.getTime()) issues.push('STALE_OR_UNAVAILABLE_LINE');
    if (analysis.evidenceExpiresAt && Date.parse(analysis.evidenceExpiresAt) <= now.getTime()) {
      issues.push('STALE_MODEL_EVIDENCE');
    }
    if (analysis.contextScore != null && analysis.evidenceQuality === 'NONE') {
      issues.push('MISSING_MODEL_EVIDENCE');
    }
    if (line.team) teamCounts.set(line.team, (teamCounts.get(line.team) ?? 0) + 1);
    if (line.sport === 'APEX') {
      apexPicks++;
      if (line.team && apexTeams.has(line.team)) issues.push('APEX_SAME_TEAM');
      if (line.team) apexTeams.add(line.team);
    }
  }
  if (picks.length > 1 && picks.some((pick) => !pick.line.team)) {
    issues.push('TEAM_IDENTITY_UNAVAILABLE');
  }
  if ([...teamCounts.values()].some((count) => count >= 3)) issues.push('SAME_TEAM_CONCENTRATION');
  if (apexPicks > 1 && picks.some((pick) => pick.line.sport === 'APEX' && !pick.line.team)) {
    issues.push('APEX_TEAM_UNKNOWN');
  }
  if (!correlationPolicy) issues.push('CORRELATION_AUDIT_UNAVAILABLE');
  else {
    try { issues.push(...correlationPolicy(picks)); }
    catch { issues.push('CORRELATION_AUDIT_FAILED'); }
  }
  return [...new Set(issues)];
}

export function buildAutoCrown(ranked: readonly CrownCandidate[], size: CrownSize,
  correlationPolicy?: CorrelationPolicy, now: Date = new Date()): CrownBuildResult {
  if (!correlationPolicy) return { picks: null, issues: ['CORRELATION_AUDIT_UNAVAILABLE'],
    requestedSize: size, reserves: [] };
  const selected: CrownCandidate[] = [];
  const topTen = ranked.slice(0, 10);
  for (const candidate of topTen) {
    if (selected.length === size) break;
    // Audit against a provisional set of the requested size; only the count may be incomplete.
    const issues = auditCrown([...selected, candidate], size, correlationPolicy, now)
      .filter((issue) => issue !== 'PICK_COUNT_MISMATCH');
    if (issues.length === 0) selected.push(candidate);
  }
  const issues = auditCrown(selected, size, correlationPolicy, now);
  const reserves = topTen.filter((candidate) => !selected.includes(candidate) &&
    auditCrown([...selected, candidate], size, correlationPolicy, now)
      .filter((issue) => issue !== 'PICK_COUNT_MISMATCH').length === 0);
  return { picks: selected, issues: issues.map((issue) => issue === 'PICK_COUNT_MISMATCH'
    ? 'INSUFFICIENT_QUALIFIED_PICKS' : issue), reserves, requestedSize: size };
}

/** Keep manual legs untouched; surface what needs review before a user saves them. */
export function reviewManualCrown(picks: readonly CrownCandidate[], size: CrownSize,
  correlationPolicy?: CorrelationPolicy, now: Date = new Date()) {
  const sorted = [...picks].sort((a, b) => (b.analysis.score ?? -1) - (a.analysis.score ?? -1));
  return { picks, strongest: sorted[0] ?? null, weakest: sorted.at(-1) ?? null,
    issues: auditCrown(picks, size, correlationPolicy, now) };
}
