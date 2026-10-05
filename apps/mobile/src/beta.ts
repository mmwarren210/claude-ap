import type { ScoreBand } from '@crowniq/contracts';

// GKR Beta: GKR with Scout's research folded in (server: scout-beta.ts). Lifetime members see Beta's score beside GKR's
// wherever the two differ; the board, Top Picks and Crown stay on GKR. Pure helpers here, so tests can load them.

export type BetaRead = {
  direction: 'MORE' | 'LESS' | 'PASS'; score: number | null; gkr: { direction: 'MORE' | 'LESS'; score: number };
  change: 'SAME' | 'UP' | 'DOWN' | 'LATE_NEWS_PASS'; scouted: boolean; shift: number; why: string; modelVersion: string;
};

export function bandOf(score: number | null): ScoreBand {
  if (score === null) return 'PASS';
  return score >= 92 ? 'CROWN_ELITE' : score >= 86 ? 'CROWN_STRONG' : score >= 80 ? 'PLAYABLE' :
    score >= 74 ? 'LEAN' : score >= 68 ? 'WEAK' : 'PASS';
}

/** "GKR 82 · Beta 90" (or why Beta passes) for a card; null when Beta and GKR agree, so only GKR's score shows. */
export function betaNote(read: BetaRead | undefined): string | null {
  if (!read || read.change === 'SAME') return null;
  if (read.change === 'LATE_NEWS_PASS') return `Beta passes: ${read.why.replace(/^Late news: /, '')}`;
  return `GKR ${Math.round(read.gkr.score)} · Beta ${Math.round(read.score!)}`;
}
