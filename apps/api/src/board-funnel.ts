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

/**
 * Lines held back for missing evidence, by how soon their game starts (owner, 2026-10-13: "is our evidence truly missing
 * 8k+ picks?"). Availability and lineups are published close to game time, so far-off games are expected to wait; many
 * lines inside the last few hours would point at a feed that isn't delivering.
 */
export function missingEvidenceTiming(board: BoardResponse, now: Date): { total: number;
  bySoon: Record<'under3h' | '3to6h' | '6to24h' | 'over24h', number>; soonBySport: Record<string, number>;
  soonByMarket: Record<string, { lines: number; players: number; samples: string[] }> } {
  const analyses = new Map(board.analyses.map((item) => [item.lineId, item]));
  const out = { total: 0, bySoon: { under3h: 0, '3to6h': 0, '6to24h': 0, over24h: 0 }, soonBySport: {} as Record<string, number>,
    soonByMarket: {} as Record<string, { lines: number; players: number; samples: string[] }> };
  const players = new Map<string, Set<string>>();
  for (const line of board.board.lines) {
    const analysis = analyses.get(line.id);
    if (!analysis || analysis.direction !== 'PASS' || !hardEvidenceReasons.has(analysis.reasonCode ?? '')) continue;
    const hours = (Date.parse(line.eventStartTime) - now.getTime()) / 3600_000;
    if (hours < 0) continue;
    out.total++;
    const bucket = hours < 3 ? 'under3h' : hours < 6 ? '3to6h' : hours < 24 ? '6to24h' : 'over24h';
    out.bySoon[bucket]++;
    if (hours >= 6) continue;
    increment(out.soonBySport, line.sport);
    // Which stats the soon gaps sit in, with a few line ids to trace (GET /v1/admin/research/route/:lineId).
    const key = `${line.sport}:${line.market}`, row = out.soonByMarket[key] ??= { lines: 0, players: 0, samples: [] };
    row.lines++;
    if (row.samples.length < 5) row.samples.push(line.id);
    const seen = players.get(key) ?? new Set<string>(); seen.add(line.playerId); players.set(key, seen); row.players = seen.size;
  }
  return out;
}
