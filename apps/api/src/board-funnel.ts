import type { BoardResponse, Evidence, PropLine } from '@crowniq/contracts';

type Requirements = Readonly<Record<string, { readonly approved: boolean; readonly required: readonly string[];
  readonly hardRequired: readonly string[] }>>;

const increment = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const sorted = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

export interface BoardFunnel {
  /** Every line on the board. Each one lands in exactly one bucket below, in this order. */
  started: number;
  eventStarted: number;
  marketNotModeled: number;
  modeledButUnapproved: { total: number; reasons: Record<string, number> };
  unknownAlternate: number;
  missingHardEvidence: { total: number; byKind: Record<string, number> };
  coverageBelow60: number;
  offeredSideUnfavored: { total: number; oppositeTwin: number; alternateSide: number };
  otherPass: { total: number; reasons: Record<string, number> };
  scored: { total: number; byBand: Record<string, number> };
  /** Scored lines left after the one-line-per-player ranking rule. */
  rankedCount: number;
}

const hardEvidenceReasons = new Set(['STALE_OR_MISSING_EVIDENCE', 'CRITICAL_STATUS_UNCONFIRMED', 'MISSING_DISTRIBUTION']);

/**
 * Where every line on the board stops, counted once each. Read-only and free: it only reads the
 * published board, its analyses and the evidence they saw.
 */
export function boardFunnel(board: BoardResponse, requirements: Requirements, evidence: readonly Evidence[]): BoardFunnel {
  const kinds = new Map(evidence.map((item) => [item.id, item.kind]));
  // Lines offered on one side only, keyed by everything but the side, to find opposite twins.
  const sides = new Map<string, Set<string>>();
  const twinKey = (line: PropLine) => JSON.stringify([line.eventId, line.playerId, line.market, line.threshold]);
  for (const line of board.board.lines) {
    const key = twinKey(line), set = sides.get(key) ?? new Set<string>();
    for (const direction of line.availableDirections) set.add(direction);
    sides.set(key, set);
  }
  const funnel: BoardFunnel = { started: board.board.lines.length, eventStarted: 0, marketNotModeled: 0,
    modeledButUnapproved: { total: 0, reasons: {} }, unknownAlternate: 0,
    missingHardEvidence: { total: 0, byKind: {} }, coverageBelow60: 0,
    offeredSideUnfavored: { total: 0, oppositeTwin: 0, alternateSide: 0 },
    otherPass: { total: 0, reasons: {} }, scored: { total: 0, byBand: {} }, rankedCount: board.rankedLineIds.length };
  const analyses = new Map(board.analyses.map((item) => [item.lineId, item]));
  for (const line of board.board.lines) {
    const analysis = analyses.get(line.id), reason = analysis?.reasonCode ?? 'MISSING_ANALYSIS';
    const requirement = requirements[`${line.sport}:${line.market.trim().toLowerCase()}`];
    if (analysis && analysis.direction !== 'PASS') {
      funnel.scored.total++; increment(funnel.scored.byBand, analysis.scoreBand ?? 'UNKNOWN'); continue;
    }
    if (reason === 'EVENT_ALREADY_STARTED') { funnel.eventStarted++; continue; }
    if (!requirement || reason === 'MODEL_SUPPORT_INCOMPLETE') { funnel.marketNotModeled++; continue; }
    if (!requirement.approved) {
      funnel.modeledButUnapproved.total++; increment(funnel.modeledButUnapproved.reasons, reason); continue;
    }
    if (line.lineType === 'UNKNOWN_ALTERNATE' || reason === 'UNCLASSIFIED_ALTERNATE') { funnel.unknownAlternate++; continue; }
    if (hardEvidenceReasons.has(reason)) {
      funnel.missingHardEvidence.total++;
      const seen = new Set((analysis?.evidenceIds ?? []).map((id) => kinds.get(id)));
      const missing = reason === 'CRITICAL_STATUS_UNCONFIRMED' ? (analysis?.opposingFactors ?? []).slice(0, 1)
        : reason === 'MISSING_DISTRIBUTION' ? [`projection:${line.market}`]
          : requirement.hardRequired.filter((kind) => !seen.has(kind));
      for (const kind of missing.length ? missing : ['UNKNOWN']) increment(funnel.missingHardEvidence.byKind, kind);
      continue;
    }
    if (reason === 'INSUFFICIENT_MODEL_COVERAGE') { funnel.coverageBelow60++; continue; }
    if (reason === 'DIRECTION_UNAVAILABLE') {
      funnel.offeredSideUnfavored.total++;
      // The model favors the side this line does not offer. When another line at the same number
      // offers that side, the pick lives there; otherwise only an alternate offered it.
      const offered = sides.get(twinKey(line)) ?? new Set<string>();
      const wanted = line.availableDirections.includes('MORE') ? 'LESS' : 'MORE';
      if (offered.has(wanted)) funnel.offeredSideUnfavored.oppositeTwin++; else funnel.offeredSideUnfavored.alternateSide++;
      continue;
    }
    funnel.otherPass.total++; increment(funnel.otherPass.reasons, reason);
  }
  funnel.modeledButUnapproved.reasons = sorted(funnel.modeledButUnapproved.reasons);
  funnel.missingHardEvidence.byKind = sorted(funnel.missingHardEvidence.byKind);
  funnel.otherPass.reasons = sorted(funnel.otherPass.reasons);
  return funnel;
}

/** Each line's outcome, with scored lines named by their band rather than all called PLAYABLE. */
export function outcomeCounts(board: BoardResponse): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const analysis of board.analyses)
    increment(counts, analysis.direction === 'PASS' ? analysis.reasonCode ?? 'MODEL_PASS' : `SCORED_${analysis.scoreBand ?? 'UNKNOWN'}`);
  return sorted(counts);
}
