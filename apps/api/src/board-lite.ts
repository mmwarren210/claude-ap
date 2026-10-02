import type { Analysis, BoardResponse } from '@crowniq/contracts';

/**
 * The Board list without the weight: only games that have not started, full analyses for scored
 * lines (the ones a person can open, pick or add to a Crown), and slim analyses for PASS lines that
 * keep what the list shows (reason, band, quality, expiry) and drop audit trails. Same schema as
 * the full board, so clients read it the same way.
 */
export function liteBoard(snapshot: BoardResponse, now: Date): BoardResponse {
  const time = now.getTime();
  const lines = snapshot.board.lines.filter((line) => Date.parse(line.eventStartTime) > time);
  const kept = new Set(lines.map((line) => line.id));
  const slim = (analysis: Analysis): Analysis => ({ lineId: analysis.lineId, direction: analysis.direction,
    score: analysis.score, scoreBreakdown: [], assessments: [], evidenceIds: [],
    evidenceExpiresAt: analysis.evidenceExpiresAt ?? null, evidenceQuality: analysis.evidenceQuality,
    dangerZone: analysis.dangerZone, ruleChecks: [], supportingFactors: [], opposingFactors: [],
    rationale: analysis.rationale.slice(0, 160), reasonCode: analysis.reasonCode, modelVersion: analysis.modelVersion,
    contextScore: analysis.contextScore ?? null, dataConfidence: analysis.dataConfidence ?? null,
    scoreBand: analysis.scoreBand ?? null, ...(analysis.reviewStatus ? { reviewStatus: analysis.reviewStatus } : {}) });
  const analyses = snapshot.analyses.filter((analysis) => kept.has(analysis.lineId))
    .map((analysis) => analysis.direction === 'PASS' ? slim(analysis) : analysis);
  const players = new Set(lines.map((line) => line.playerId));
  const media = snapshot.playerMedia ? Object.fromEntries(Object.entries(snapshot.playerMedia)
    .filter(([playerId]) => players.has(playerId))) : undefined;
  return { board: { ...snapshot.board, lines }, analyses,
    rankedLineIds: snapshot.rankedLineIds.filter((id) => kept.has(id)), builtAt: snapshot.builtAt,
    ...(media && Object.keys(media).length ? { playerMedia: media } : {}) };
}
