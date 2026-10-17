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

function isContextOnly(item: Evidence): boolean {
  return item.kind.startsWith('web:');
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

/** FNV-1a over a string, as 13 base-36 digits (a cache key, not a security hash). */
function fingerprint(text: string): string {
  let low = 0x811c9dc5, high = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ code, 0x0100019d) >>> 0;
  }
  return high.toString(36) + '.' + low.toString(36);
}

/**
 * Reuses a line's analysis while the line, its model and its current evidence are all unchanged. A model reads only the
 * line and the evidence (never the clock), so the reused analysis is exactly what scoring again would return; it only
 * saves the work. Re-scoring every line of a ~40,000-line board on each rebuild held the one server thread for seconds
 * (2026-10-17 freezes). Holds at most two generations of `maxEntries`.
 */
export class AnalysisCache {
  private current = new Map<string, Analysis>();
  private previous = new Map<string, Analysis>();
  private readonly evidenceKeys = new WeakMap<Evidence, string>();
  private readonly moduleKeys = new WeakMap<ModelModule, number>();
  private modules = 0;
  constructor(private readonly maxEntries = 60_000) {}

  key(line: PropLine, module: ModelModule | null, evidence: readonly Evidence[]): string {
    let moduleKey = 0;
    if (module) {
      moduleKey = this.moduleKeys.get(module) ?? ++this.modules;
      this.moduleKeys.set(module, moduleKey);
    }
    const items = evidence.map((item) => {
      let value = this.evidenceKeys.get(item);
      if (value === undefined) { value = fingerprint(JSON.stringify(item)); this.evidenceKeys.set(item, value); }
      return value;
    });
    return `${moduleKey}|${items.join(',')}|${JSON.stringify(line)}`;
  }

  get(key: string): Analysis | undefined {
    const kept = this.current.get(key);
    if (kept) return kept;
    const older = this.previous.get(key);
    if (older) this.set(key, older);
    return older;
  }

  set(key: string, analysis: Analysis): void {
    if (this.current.size >= this.maxEntries) { this.previous = this.current; this.current = new Map(); }
    this.current.set(key, analysis);
  }
}

/** Evidence grouped by event, so each line looks only at its own event's items (same items, same order). */
export function evidenceByEvent(evidence: readonly Evidence[]): Map<string, Evidence[]> {
  const out = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const list = out.get(item.eventId);
    if (list) list.push(item); else out.set(item.eventId, [item]);
  }
  return out;
}

export function evaluateLine(line: PropLine, evidence: readonly Evidence[], registry: ModelRegistry,
  now: Date, cache: AnalysisCache | null = null): Analysis {
  const module = registry.resolve(line);
  if (Date.parse(line.eventStartTime) <= now.getTime()) {
    return pass(line, 'EVENT_ALREADY_STARTED', module?.version ?? null);
  }
  const current = freshEvidenceFor(line, evidence, now);
  if (!cache) return scoreWithEvidence(line, current, module);
  const key = cache.key(line, module, current);
  const kept = cache.get(key);
  if (kept) return kept;
  const analysis = scoreWithEvidence(line, current, module);
  cache.set(key, analysis);
  return analysis;
}

function scoreWithEvidence(line: PropLine, current: readonly Evidence[], module: ModelModule | null): Analysis {
  // Web findings are AI-structured context for people to read. No model scores them, so
  // they must not lower evidence quality or shorten the analysis's evidence expiry.
  // Identity findings (team, photo) describe who the player is, not how they will perform.
  const fresh = current.filter((item) => !isContextOnly(item) && !item.kind.startsWith('identity:'));
  const contextIds = current.filter(isContextOnly).map((item) => item.id);
  const withContext = (analysis: Analysis): Analysis =>
    contextIds.length ? { ...analysis, contextEvidenceIds: contextIds } : analysis;
  return withContext(evaluateWithEvidence(line, fresh, module));
}

function evaluateWithEvidence(line: PropLine, fresh: readonly Evidence[],
  module: ModelModule | null): Analysis {
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
  now: Date, cache: AnalysisCache | null = null): { analyses: Analysis[]; rankedLineIds: string[] } {
  const parsed = boardSchema.parse(board);
  if (new Set(parsed.lines.map((line) => line.id)).size !== parsed.lines.length) {
    throw new Error('Duplicate normalized line ID');
  }
  // All lines are assessed before any ladder winner or ranking is chosen.
  const byEvent = evidenceByEvent(evidence);
  const analyses = parsed.lines.map((line) => evaluateLine(line, byEvent.get(line.eventId) ?? [], registry, now, cache));
  return { analyses, rankedLineIds: chooseLadderWinners(parsed.lines, analyses) };
}
