import type { Analysis, BoardResponse, PlayableDirection, PropLine } from '@crowniq/contracts';
import { crownMinimumLineScore } from './insights';

/** The lowest leg score any Crown size accepts (the 6-leg minimum). */
export const CROWN_LEG_FLOOR=Math.min(...Object.values(crownMinimumLineScore));
/** True once a line's research evidence has expired and it needs reanalysis before it can be played. */
export const evidenceExpired=(analysis:Analysis|undefined,nowMs:number)=>
  !!analysis?.evidenceExpiresAt&&Date.parse(analysis.evidenceExpiresAt)<=nowMs;

export interface Filters { sport: string; market: string; direction: string; grade: string;
  lineType: string; evidence: string; date: string }
export type ViewMode='LITE'|'FULL';
export const LITE_LIMIT=20;
export const emptyFilters: Filters = { sport:'ALL',market:'ALL',direction:'ALL',grade:'ALL',
  lineType:'ALL',evidence:'ALL',date:'ALL' };
export interface CrownLeg { line: PropLine; direction: PlayableDirection; score: number;
  modelVersion: string }
export function visibleLines(data: BoardResponse, filters: Filters, nowMs=Date.now()): PropLine[] {
  const analyses = new Map(data.analyses.map((analysis) => [analysis.lineId,analysis]));
  return data.board.lines.filter((line) => {
    const analysis=analyses.get(line.id);
    return Date.parse(line.eventStartTime)>nowMs &&
      (filters.sport === 'ALL' || line.sport === filters.sport) &&
      (filters.market === 'ALL' || line.market === filters.market) &&
      (filters.lineType === 'ALL' || line.lineType === filters.lineType) &&
      (filters.direction === 'ALL' || analysis?.direction === filters.direction) &&
      (filters.grade === 'ALL' || analysis?.scoreBand === filters.grade) &&
      (filters.evidence === 'ALL' || analysis?.evidenceQuality === filters.evidence) &&
      (filters.date === 'ALL' || line.eventStartTime.slice(0,10) === filters.date);
  });
}
/** Lite uses only the engine's ranked exact lines; Full retains the complete provider board. */
export function boardLinesForMode(data:BoardResponse,filters:Filters,mode:ViewMode,
  nowMs=Date.now()):PropLine[]{
  if(mode==='FULL')return visibleLines(data,filters,nowMs);
  const lines=new Map(data.board.lines.map((line)=>[line.id,line]));
  const analyses=new Map(data.analyses.map((analysis)=>[analysis.lineId,analysis]));
  const ranked:PropLine[]=[];
  for(const id of data.rankedLineIds){
    const line=lines.get(id),analysis=analyses.get(id);
    if(!line||!analysis||analysis.direction==='PASS'||analysis.score===null||
      !analysis.modelVersion||line.lineType==='UNKNOWN_ALTERNATE'||
      !['PLAYABLE','CROWN_STRONG','CROWN_ELITE'].includes(analysis.scoreBand??'')||
      !line.availableDirections.includes(analysis.direction)||
      Date.parse(line.eventStartTime)<=nowMs||evidenceExpired(analysis,nowMs)||
      (filters.sport!=='ALL'&&line.sport!==filters.sport)||
      (filters.market!=='ALL'&&line.market!==filters.market)||
      // The Board's line-style, evidence and date chips apply in both views; grade and
      // direction stay Full-only so a stale Full filter never hides ranked plays.
      (filters.lineType!=='ALL'&&line.lineType!==filters.lineType)||
      (filters.evidence!=='ALL'&&analysis.evidenceQuality!==filters.evidence)||
      (filters.date!=='ALL'&&line.eventStartTime.slice(0,10)!==filters.date))continue;
    ranked.push(line);
    if(ranked.length===LITE_LIMIT)break;
  }
  return ranked;
}
export function addLeg(legs: readonly CrownLeg[], line: PropLine, analysis: Analysis,
  direction: PlayableDirection, nowMs=Date.now()): { legs: CrownLeg[]; error: string | null } {
  if (analysis.direction !== direction || analysis.score === null || !analysis.modelVersion ||
    line.lineType === 'UNKNOWN_ALTERNATE' || !line.availableDirections.includes(direction))
    return {legs:[...legs],error:'This line is not currently playable.'};
  if (legs.some((leg) => leg.line.playerId === line.playerId))
    return {legs:[...legs],error:'That player is already in this Crown. Remove or swap the leg first.'};
  if (Date.parse(line.eventStartTime)<=nowMs ||
    (analysis.evidenceExpiresAt && Date.parse(analysis.evidenceExpiresAt)<=nowMs))
    return {legs:[...legs],error:'The event has started or its research evidence expired. Recheck before adding it.'};
  if (analysis.score < CROWN_LEG_FLOOR)
    return {legs:[...legs],error:`GKR ${Math.round(analysis.score)} is below ${CROWN_LEG_FLOOR}, the lowest score any Crown accepts.`};
  if (line.sport === 'APEX' && line.team && legs.some((leg) => leg.line.sport === 'APEX' &&
    leg.line.team === line.team))
    return {legs:[...legs],error:'Only one Apex player per team is allowed.'};
  if (line.team && legs.filter((leg)=>leg.line.team===line.team).length>=2)
    return {legs:[...legs],error:'A Crown cannot contain three players from the same team.'};
  // The server owns team/correlation audits; never call this draft an approved Crown.
  return {legs:[...legs,{line,direction,score:analysis.score,modelVersion:analysis.modelVersion}],error:null};
}
export function freshness(data: BoardResponse | null, reachable: boolean, nowMs: number,
  verifiedOffline=false):'LIVE'|'FRESH'|'CACHED'|'SNAPSHOT'|'STALE'|'OFFLINE'|'UNREACHABLE'|'UNAVAILABLE' {
  if (verifiedOffline) return 'OFFLINE';
  if (!reachable) return 'UNREACHABLE';
  if (!data) return 'UNAVAILABLE';
  const age=nowMs-Date.parse(data.board.fetchedAt);
  if(age<0 || !data.board.lines.some((line)=>Date.parse(line.eventStartTime)>nowMs))return 'STALE';
  return age > 30*60_000 ? 'SNAPSHOT' : age > 5*60_000 ? 'CACHED' :
    age > 60_000 ? 'FRESH' : 'LIVE';
}
export function shareCrown(legs: readonly CrownLeg[]): string {
  return ['CrownIQ Crown draft — not a guaranteed or submitted pick',
    ...legs.map((leg,index) => `${index+1}. ${leg.line.playerName} · ${leg.line.market} ${leg.direction} ${leg.line.threshold} (${leg.line.lineType}) · GKR ${leg.score}`),
    'Check current lines before playing. Play responsibly.'].join('\n');
}

/**
 * Builds a Crown of `size` legs from ranked candidates, starting at `offset` so repeated
 * calls produce different Crowns. Every leg passes addLeg and the Crown minimum score.
 */
export function autoCrown(candidates:readonly {line:PropLine;analysis:Analysis}[],size:number,
  minimumScore:number,offset=0,nowMs=Date.now()):CrownLeg[]{
  let legs:CrownLeg[]=[];
  const ordered=[...candidates.slice(offset),...candidates.slice(0,offset)];
  for(const {line,analysis} of ordered){
    if(legs.length===size)break;
    if(analysis.direction==='PASS'||(analysis.score??0)<minimumScore)continue;
    const result=addLeg(legs,line,analysis,analysis.direction,nowMs);
    if(!result.error)legs=result.legs;
  }
  return legs;
}
