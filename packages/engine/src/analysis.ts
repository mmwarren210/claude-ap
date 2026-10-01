import { assessmentSchema, boardSchema } from '@crowniq/contracts';
import type { Analysis, Assessment, Board, Evidence, PropLine, ScoreBand } from '@crowniq/contracts';
import type { ModelModule } from './interfaces.js';
import { ModelRegistry } from './registry.js';
import { effectiveEvidenceExpiry, freshEvidenceFor } from './research.js';

function pass(line: PropLine, reasonCode: string, modelVersion: string | null,
  evidence: readonly Evidence[] = []): Analysis {
  return {
    lineId: line.id, direction: 'PASS', score: null, scoreBreakdown: [], assessments: [],
    evidenceIds: evidence.map((item) => item.id),
    evidenceExpiresAt: evidence.length ? new Date(Math.min(...evidence.map(effectiveEvidenceExpiry)))
      .toISOString() : null,
    evidenceQuality: evidenceQuality(evidence), dangerZone: false, ruleChecks: [],
    supportingFactors: [], opposingFactors: [], rationale: reasonCode.replaceAll('_', ' ').toLowerCase(),
    reasonCode, modelVersion, contextScore: null, dataConfidence: null, contextBreakdown: [],
    lineAdjustments: [], scoreBand: 'PASS', thresholdCushion: null,
  };
}

function evidenceQuality(evidence: readonly Evidence[]): Analysis['evidenceQuality'] {
  if (!evidence.length) return 'NONE';
  if (evidence.some((item) => item.quality === 'LOW')) return 'LOW';
  if (evidence.some((item) => item.quality === 'MEDIUM')) return 'MEDIUM';
  return 'HIGH';
}

export function scoreBand(score: number): ScoreBand {
  return score >= 92 ? 'CROWN_ELITE' : score >= 86 ? 'CROWN_STRONG' :
    score >= 80 ? 'PLAYABLE' : score >= 74 ? 'LEAN' :
      score >= 68 ? 'WEAK' : 'PASS';
}

function runAssessment(module: ModelModule, line: PropLine, evidence: readonly Evidence[],
  phase: Assessment['phase'], previous: Assessment | null): Assessment {
  const result = assessmentSchema.parse(module.assess({ line, evidence, phase, previous }));
  if (result.phase !== phase) throw new Error('Model returned the wrong phase');
  return result;
}

export function evaluateLine(line: PropLine, evidence: readonly Evidence[], registry: ModelRegistry,
  now: Date): Analysis {
  const module = registry.resolve(line);
  if (Date.parse(line.eventStartTime) <= now.getTime()) {
    return pass(line, 'EVENT_ALREADY_STARTED', module?.version ?? null);
  }
  const fresh = freshEvidenceFor(line, evidence, now);
  if (!module) return pass(line, 'MODEL_SUPPORT_INCOMPLETE', null, fresh);
  if (line.lineType === 'UNKNOWN_ALTERNATE')
    return pass(line, 'UNCLASSIFIED_ALTERNATE', module.version, fresh);
  const hardRequired = module.hardRequiredEvidenceKinds ?? module.requiredEvidenceKinds;
  if (hardRequired.some((kind) => !fresh.some((item) => item.kind === kind))) {
    return pass(line, 'STALE_OR_MISSING_EVIDENCE', module.version, fresh);
  }

  try {
    const initial = runAssessment(module, line, fresh, 'INITIAL', null);
    // A PASS on the first pass is not a serious candidate. Every playable candidate
    // must survive an adversarial review and a fresh final assessment.
    const assessments = [initial];
    if (initial.direction !== 'PASS') {
      const adversarial = runAssessment(module, line, fresh, 'ADVERSARIAL', initial);
      assessments.push(adversarial);
      const final = runAssessment(module, line, fresh, 'FINAL', adversarial);
      assessments.push(final);
    }
    const last = assessments[assessments.length - 1];
    const direction = last.direction;
    const breakdown = direction === 'PASS' ? [] : last.scoreComponents;
    const score = breakdown.reduce((sum, item) => sum + item.contribution, 0);
    if (direction !== 'PASS' && !line.availableDirections.includes(direction)) {
      return { ...pass(line, 'DIRECTION_UNAVAILABLE', module.version, fresh), assessments };
    }
    if (direction !== 'PASS' && (!breakdown.length || !Number.isFinite(score) || score < 0 || score > 100 ||
      (last.lineScore !== undefined && last.lineScore !== null && Math.abs(last.lineScore - score) > .03))) {
      return { ...pass(line, 'INVALID_SCORE_COMPONENTS', module.version, fresh), assessments };
    }
    const finalScore = direction === 'PASS' ? null : roundScore(score);
    return {
      lineId: line.id, direction, score: finalScore,
      scoreBreakdown: breakdown, assessments, evidenceIds: fresh.map((item) => item.id),
      evidenceExpiresAt: fresh.length ? new Date(Math.min(...fresh.map(effectiveEvidenceExpiry)))
        .toISOString() : null,
      evidenceQuality: evidenceQuality(fresh), dangerZone: last.dangerZone,
      ruleChecks: last.ruleChecks, supportingFactors: last.supportingFactors,
      opposingFactors: last.opposingFactors, rationale: last.rationale,
      reasonCode: direction === 'PASS' ? last.reasonCode ?? 'MODEL_PASS' : null,
      modelVersion: module.version, contextScore: last.contextScore ?? null,
      dataConfidence: last.dataConfidence ?? null, contextBreakdown: last.contextComponents ?? [], lineAdjustments: last.lineAdjustments ?? [],
      scoreBand: finalScore === null ? 'PASS' : scoreBand(finalScore),
      thresholdCushion: last.thresholdCushion ?? null,
    };
  } catch {
    return pass(line, 'MODEL_EVALUATION_FAILED', module.version, fresh);
  }
}

const roundScore = (value: number) => Math.round(value * 100) / 100;

function ladderKey(line: PropLine, direction: 'MORE' | 'LESS'): string {
  return JSON.stringify([line.eventId, line.playerId, line.market, direction]);
}

function qualityRank(quality: Analysis['evidenceQuality']) {
  return { HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 }[quality];
}

function component(analysis: Analysis, key: string): number {
  return analysis.contextBreakdown?.find((factor) => factor.name === key)?.contribution ?? 0;
}

function compare(a: Analysis, b: Analysis, byId: Map<string, PropLine>): number {
  if (a.score !== b.score) return b.score! - a.score!;
  if (a.evidenceQuality !== b.evidenceQuality) return qualityRank(b.evidenceQuality) - qualityRank(a.evidenceQuality);
  if ((a.thresholdCushion ?? null) !== (b.thresholdCushion ?? null)) {
    return (b.thresholdCushion ?? -1e9) - (a.thresholdCushion ?? -1e9);
  }
  for (const key of ['stability','stability_risk','role_opportunity']) {
    const diff = component(b, key) - component(a, key);
    if (diff) return diff;
  }
  const variance = (item: Analysis) => item.lineAdjustments?.find((c) => c.name === 'variance')?.contribution ?? 0;
  if (variance(a) !== variance(b)) return variance(b) - variance(a);
  for (const key of ['matchup','coverage_matchup','pitcher_matchup','opponent']) {
    const diff = component(b, key) - component(a, key);
    if (diff) return diff;
  }
  const left = byId.get(a.lineId)!;
  const right = byId.get(b.lineId)!;
  if (a.direction === b.direction && left.eventId === right.eventId &&
    left.playerId === right.playerId && left.market === right.market &&
    left.threshold !== right.threshold) {
    return a.direction === 'MORE' ? left.threshold - right.threshold : right.threshold - left.threshold;
  }
  return a.lineId.localeCompare(b.lineId);
}

function chooseWinners(lines: readonly PropLine[], analyses: readonly Analysis[],
  eligible: (analysis: Analysis) => boolean): string[] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const winners = new Map<string, Analysis>();
  for (const analysis of analyses) {
    if (!eligible(analysis) || analysis.direction === 'PASS' || analysis.score === null) continue;
    const line = byId.get(analysis.lineId);
    if (!line || !line.availableDirections.includes(analysis.direction)) continue;
    const key = ladderKey(line, analysis.direction);
    const current = winners.get(key);
    if (!current) { winners.set(key, analysis); continue; }
    if (compare(analysis, current, byId) < 0) winners.set(key, analysis);
  }
  const players = new Map<string, Analysis>();
  for (const candidate of winners.values()) {
    const playerId = byId.get(candidate.lineId)!.playerId;
    const current = players.get(playerId);
    if (!current || compare(candidate, current, byId) < 0) players.set(playerId, candidate);
  }
  return [...players.values()]
    .sort((a, b) => compare(a, b, byId))
    .map((item) => item.lineId);
}

export function chooseLadderWinners(lines: readonly PropLine[], analyses: readonly Analysis[]): string[] {
  // Primary CrownIQ rankings are actionable bands only. LEAN/WEAK remain
  // available for the Second Look watchlist and manual research.
  return chooseWinners(lines, analyses, (analysis) =>
    analysis.scoreBand === 'PLAYABLE' || analysis.scoreBand === 'CROWN_STRONG' ||
    analysis.scoreBand === 'CROWN_ELITE');
}

export function chooseSecondLookWatchlist(lines: readonly PropLine[],
  analyses: readonly Analysis[]): string[] {
  // The watchlist is not a second rankings board. It only surfaces re-researched
  // non-PASS LEAN/WEAK lines for additional user review.
  return chooseWinners(lines, analyses, (analysis) =>
    analysis.reviewStatus === 'SECOND_LOOK' && !!analysis.secondLook &&
    (analysis.scoreBand === 'LEAN' || analysis.scoreBand === 'WEAK'));
}

export function evaluateBoard(board: Board, evidence: readonly Evidence[], registry: ModelRegistry,
  now: Date): { analyses: Analysis[]; rankedLineIds: string[] } {
  const parsed = boardSchema.parse(board);
  if (new Set(parsed.lines.map((line) => line.id)).size !== parsed.lines.length) {
    throw new Error('Duplicate normalized line ID');
  }
  // All lines are assessed before any ladder winner or ranking is chosen.
  const analyses = parsed.lines.map((line) => evaluateLine(line, evidence, registry, now));
  return { analyses, rankedLineIds: chooseLadderWinners(parsed.lines, analyses) };
}
