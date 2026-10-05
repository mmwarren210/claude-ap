import type { BoardResponse, RankingsResponse, ScoreBand } from '@crowniq/contracts';

// GKR Beta: GKR with Scout's research folded in (server: scout-beta.ts). Lifetime members choose GKR or Beta; the choice
// changes every screen that reads the board. Pure helpers here, so tests can load them without React.

export type Model = 'GKR' | 'BETA';
export type BetaRead = {
  direction: 'MORE' | 'LESS' | 'PASS'; score: number | null; gkr: { direction: 'MORE' | 'LESS'; score: number };
  change: 'SAME' | 'UP' | 'DOWN' | 'LATE_NEWS_PASS'; scouted: boolean; shift: number; why: string; modelVersion: string;
};

export function bandOf(score: number | null): ScoreBand {
  if (score === null) return 'PASS';
  return score >= 92 ? 'CROWN_ELITE' : score >= 86 ? 'CROWN_STRONG' : score >= 80 ? 'PLAYABLE' :
    score >= 74 ? 'LEAN' : score >= 68 ? 'WEAK' : 'PASS';
}

/** The board as GKR Beta sees it: Beta's score and side on each GKR play, ranked by Beta's score. */
export function applyBeta(board: BoardResponse, beta: ReadonlyMap<string, BetaRead>): BoardResponse {
  const analyses = board.analyses.map((analysis) => {
    const read = beta.get(analysis.lineId);
    if (!read) return analysis;
    if (read.direction === 'PASS') return { ...analysis, direction: 'PASS' as const, score: null, scoreBand: 'PASS' as const,
      reasonCode: 'SCOUT_LATE_NEWS', rationale: read.why, modelVersion: read.modelVersion };
    return { ...analysis, direction: read.direction, score: read.score, scoreBand: bandOf(read.score),
      modelVersion: read.modelVersion };
  });
  const scores = new Map(analyses.map((analysis) => [analysis.lineId, analysis.score]));
  const ranked = board.rankedLineIds.filter((lineId) => scores.get(lineId) !== null && scores.get(lineId) !== undefined)
    .map((lineId, index) => ({ lineId, index, score: scores.get(lineId)! }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.lineId);
  return { ...board, analyses, rankedLineIds: ranked };
}

/** Top Picks as GKR Beta sees them: Beta's scores, late-news passes and anything under 80 left out, re-ranked. */
export function applyBetaRankings(rankings: RankingsResponse, beta: ReadonlyMap<string, BetaRead>): RankingsResponse {
  const cards = rankings.rankings.flatMap((card) => {
    const read = beta.get(card.lineId);
    if (!read) return [card];
    if (read.direction === 'PASS' || read.score === null || read.score < 80) return [];
    return [{ ...card, score: read.score, scoreBand: bandOf(read.score) as typeof card.scoreBand, modelVersion: read.modelVersion }];
  }).sort((a, b) => b.score - a.score).map((card, index) => ({ ...card, rank: index + 1 }));
  return { ...rankings, rankings: cards };
}

/** "GKR 86 → Beta 94" for a card, or null when Beta and GKR agree. */
export function betaNote(read: BetaRead | undefined): string | null {
  if (!read || read.change === 'SAME') return null;
  if (read.change === 'LATE_NEWS_PASS') return `Beta passes: ${read.why.replace(/^Late news: /, '')}`;
  return `GKR ${Math.round(read.gkr.score)} → Beta ${Math.round(read.score!)}`;
}
