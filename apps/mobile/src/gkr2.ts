import type { Analysis, BoardResponse, RankingCard } from '@crowniq/contracts';
import { bandOf } from './beta';

// GKR 2 on the Board and Top Picks (owner, 2026-10-13): members choose the model, GKR, GKR 2 or both. GKR 2 is labeled Beta
// everywhere: it is still calibrating, so its picks are used at the member's own risk. Pure helpers here, so tests load them.

export type ModelChoice = 'GKR' | 'GKR2' | 'BOTH';
export type Gkr2Read = { direction: 'MORE' | 'LESS' | 'PASS'; score: number | null; why: string | null };
export const MODEL_OPTIONS: readonly { value: ModelChoice; label: string }[] = [
  { value: 'GKR', label: 'GKR' }, { value: 'GKR2', label: 'GKR 2 β' }, { value: 'BOTH', label: 'Both' }];
export const GKR2_WARNING = 'GKR 2 is in Beta: still calibrating against graded results. Use its picks at your own risk.';

const played = (read: Gkr2Read | undefined): read is Gkr2Read & { direction: 'MORE' | 'LESS'; score: number } =>
  !!read && read.direction !== 'PASS' && read.score !== null;

/** GKR 2's read written into a line's analysis (side, score, band), or a PASS when GKR 2 doesn't play it. */
export function asGkr2(analysis: Analysis, read: Gkr2Read | undefined): Analysis {
  return played(read) ? { ...analysis, direction: read.direction, score: read.score, scoreBand: bandOf(read.score), modelVersion: 'GKR-2-BETA' }
    : { ...analysis, direction: 'PASS', score: null, scoreBand: 'PASS', reasonCode: analysis.reasonCode ?? 'GKR2_PASS' };
}

/**
 * The board as the chosen model sees it. GKR: unchanged. GKR 2: every line's side and score are GKR 2's, ranked by GKR 2.
 * Both: GKR's plays, plus GKR 2's plays on lines GKR passes (those cards say they are GKR 2's).
 */
export function boardForModel(data: BoardResponse, choice: ModelChoice, reads: ReadonlyMap<string, Gkr2Read> | null): BoardResponse {
  if (choice === 'GKR' || !reads) return data;
  const analyses = data.analyses.map((analysis) => {
    const read = reads.get(analysis.lineId);
    if (choice === 'GKR2') return asGkr2(analysis, read);
    return analysis.direction === 'PASS' && played(read) ? asGkr2(analysis, read) : analysis;
  });
  if (choice === 'BOTH') return { ...data, analyses };
  const ranked = analyses.filter((item) => item.direction !== 'PASS' && item.score !== null && item.score >= 80)
    .sort((a, b) => b.score! - a.score!).map((item) => item.lineId);
  return { ...data, analyses, rankedLineIds: ranked };
}

/** Which model a card's main score is from: GKR's when GKR plays, else GKR 2's (Both shows GKR 2 where GKR passes). */
export function cardModel(choice: ModelChoice, gkrAnalysis: Analysis | undefined, read: Gkr2Read | undefined): 'GKR' | 'GKR2' {
  if (choice === 'GKR2') return 'GKR2';
  if (choice === 'BOTH' && (!gkrAnalysis || gkrAnalysis.direction === 'PASS') && played(read)) return 'GKR2';
  return 'GKR';
}

/** Top Picks from GKR 2: its plays scoring 80+, best first, in the same card shape as GKR's rankings. */
export function gkr2Rankings(data: BoardResponse, reads: ReadonlyMap<string, Gkr2Read>, nowMs: number): RankingCard[] {
  const analyses = new Map(data.analyses.map((item) => [item.lineId, item]));
  const rows = data.board.lines.flatMap((line) => {
    const read = reads.get(line.id), base = analyses.get(line.id);
    if (!played(read) || read.score < 80 || Date.parse(line.eventStartTime) <= nowMs || line.lineType === 'UNKNOWN_ALTERNATE') return [];
    return [{ line, read, base }];
  }).sort((a, b) => b.read.score - a.read.score);
  return rows.map(({ line, read, base }, index) => ({ rank: index + 1, lineId: line.id, playerId: line.playerId, playerName: line.playerName,
    sport: line.sport, league: line.league, eventId: line.eventId, eventName: line.eventName, eventStartTime: line.eventStartTime,
    team: line.team ?? null, opponent: line.opponent ?? null, market: line.market, threshold: line.threshold, direction: read.direction,
    lineType: line.lineType as RankingCard['lineType'], score: read.score,
    scoreBand: (read.score >= 92 ? 'CROWN_ELITE' : read.score >= 86 ? 'CROWN_STRONG' : 'PLAYABLE') as RankingCard['scoreBand'],
    modelVersion: 'GKR-2-BETA', evidenceQuality: base?.evidenceQuality ?? 'NONE', dangerZone: false, reviewStatus: 'STANDARD' as const,
    secondLook: null }));
}

/** The line under a card when both models show: GKR 2's read and why it differs, or null when they agree. */
export function gkr2Note(read: Gkr2Read | undefined, shownModel: 'GKR' | 'GKR2'): string | null {
  if (!read) return null;
  const side = read.direction === 'PASS' ? 'passes' : `${read.direction} ${Math.round(read.score ?? 0)}`;
  if (shownModel === 'GKR2') return read.why ? `GKR passes this line. ${read.why}` : null;
  return read.why ? `GKR 2 (Beta) ${side}. ${read.why}` : `GKR 2 (Beta) agrees: ${side}.`;
}

type Side = 'MORE' | 'LESS';
/** Every model reads the line and takes the pick's side: Edge (the pick itself), GKR, GKR 2 and GKR+ (owner, 2026-10-13). */
export const allAgree = (pick: { side: Side; reads?: { gkr: { side: Side } | null; gkr2?: { side: Side } | null; gkrPlus: { side: Side } | null } }) =>
  !!pick.reads?.gkr && !!pick.reads.gkr2 && !!pick.reads.gkrPlus &&
  pick.reads.gkr.side === pick.side && pick.reads.gkr2.side === pick.side && pick.reads.gkrPlus.side === pick.side;
