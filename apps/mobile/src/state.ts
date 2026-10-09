import type { Analysis, BoardResponse, PlayableDirection, PropLine } from '@crowniq/contracts';
import { crownMinimumLineScore } from './insights';

/** The lowest leg score any Crown size accepts (the 6-leg minimum). */
export const CROWN_LEG_FLOOR=Math.min(...Object.values(crownMinimumLineScore));
/** True once a line's research evidence has expired and it needs reanalysis before it can be played. */
export const evidenceExpired=(analysis:Analysis|undefined,nowMs:number)=>
  !!analysis?.evidenceExpiresAt&&Date.parse(analysis.evidenceExpiresAt)<=nowMs;

export interface Filters { sport: string; market: string; direction: string; grade: string;
  lineType: string; evidence: string; date: string; game: string }
export type ViewMode='LITE'|'FULL';
/** A filter value is 'ALL' or a comma-separated list of picks (several sports, stats, dates at once). */
export const passes=(choice:string,value:string|null|undefined)=>choice==='ALL'||(value!==null&&value!==undefined&&choice.split(',').includes(value));
/** Adds or removes one option from a filter; removing the last one goes back to 'ALL'. */
export function toggleFilter(choice:string,option:string):string{
  if(option==='ALL')return 'ALL';
  const current=choice==='ALL'?[]:choice.split(',');
  const next=current.includes(option)?current.filter((item)=>item!==option):[...current,option];
  return next.length?next.join(','):'ALL';
}
export const LITE_LIMIT=20;
export const emptyFilters: Filters = { sport:'ALL',market:'ALL',direction:'ALL',grade:'ALL',
  lineType:'ALL',evidence:'ALL',date:'ALL',game:'ALL' };
/**
 * A Crown leg. `score` and `modelVersion` are GKR's for the chosen side, or null when GKR does not back that side.
 * `yourCall` lists the tips the user saw and overrode to add it.
 */
export interface CrownLeg { line: PropLine; direction: PlayableDirection; score: number | null;
  modelVersion: string | null; yourCall?: TipId[] }
/** Things CrownIQ advises against but lets an adult do anyway. */
export type TipId='NO_SCORE'|'AGAINST_MODEL'|'LOW_SCORE'|'STALE_EVIDENCE'|'TEAM_STACK'|'WEAKER_TICKET';
export interface LegTip { id: TipId; title: string; text: string }
/** True when every leg is one GKR backs as-is, so the Crown can join the tracked record and Social. */
export const gkrBacked=(legs:readonly CrownLeg[])=>legs.every((leg)=>leg.score!==null&&!leg.yourCall?.length);
export function visibleLines(data: BoardResponse, filters: Filters, nowMs=Date.now()): PropLine[] {
  const analyses = new Map(data.analyses.map((analysis) => [analysis.lineId,analysis]));
  return data.board.lines.filter((line) => {
    const analysis=analyses.get(line.id);
    return Date.parse(line.eventStartTime)>nowMs &&
      passes(filters.sport,line.sport) && passes(filters.market,line.market) && passes(filters.lineType,line.lineType) &&
      passes(filters.direction,analysis?.direction) && passes(filters.grade,analysis?.scoreBand) &&
      passes(filters.evidence,analysis?.evidenceQuality) && passes(filters.date,line.eventStartTime.slice(0,10)) &&
      passes(filters.game,line.eventId);
  });
}
/**
 * A line is a play when GKR scores a side on it, or (where GKR can't score) the Scout read picks one. A Scout second
 * opinion on a GKR pick never makes a line a play by itself.
 */
export function isPlay(analysis:Analysis|undefined,ai?:{pick:string;score:number|null;kind?:string}):boolean{
  if(analysis&&analysis.direction!=='PASS'&&analysis.score!==null)return true;
  return !!ai&&ai.kind!=='second'&&ai.pick!=='PASS'&&ai.score!==null&&ai.score>=55;
}
type PlayRead={pick:string;score:number|null;kind?:string};
/**
 * The plays the board ranks where GKR can't score: the Scout read, else the History Read, else the Books pick (its
 * no-vig chance as 0-100).
 * A line with a Scout read keeps it, even a PASS: Scout looked closer than the prices alone.
 */
export function withBooksPicks(ai:ReadonlyMap<string,PlayRead>|undefined,
  books:ReadonlyMap<string,{side:'MORE'|'LESS';fair:number}>|undefined,
  history?:ReadonlyMap<string,{direction:string;score:number|null}>):Map<string,PlayRead>{
  const merged=new Map<string,PlayRead>(ai??[]);
  // Then the free History Read, ahead of the Books pick.
  for(const [lineId,read] of history??[])if(read.direction!=='PASS'&&read.score!==null&&
    (!merged.has(lineId)||merged.get(lineId)!.kind==='second'))merged.set(lineId,{pick:read.direction,score:read.score,kind:'history'});
  for(const [lineId,pick] of books??[])if(!merged.has(lineId)||merged.get(lineId)!.kind==='second')
    merged.set(lineId,{pick:pick.side,score:Math.round(pick.fair*100),kind:'books'});
  return merged;
}
/**
 * One card per player per game: the player's strongest play (GKR first by score, then the AI read). Every other line,
 * PASS included, stays on the player's page.
 */
export function onePerPlayer(lines:readonly PropLine[],analyses:ReadonlyMap<string,Analysis>,
  ai:ReadonlyMap<string,{pick:string;score:number|null;kind?:string}>=new Map()):PropLine[]{
  const strength=(line:PropLine)=>{const analysis=analyses.get(line.id);
    return analysis&&analysis.direction!=='PASS'&&analysis.score!==null?1000+analysis.score:ai.get(line.id)?.score??0;};
  const best=new Map<string,PropLine>();
  for(const line of lines){
    const key=line.eventId+'|'+line.playerId,current=best.get(key);
    if(!current||strength(line)>strength(current))best.set(key,line);
  }
  // Keep the incoming order (ranked, or board order), placing each player where their best play falls.
  const keep=new Set(best.values());
  return lines.filter((line)=>keep.has(line));
}
/** How many plays each player has in a game, for the card's "more plays" note. */
export function playCounts(data:BoardResponse,ai:ReadonlyMap<string,{pick:string;score:number|null;kind?:string}>=new Map(),
  nowMs=Date.now()):Map<string,number>{
  const analyses=new Map(data.analyses.map((analysis)=>[analysis.lineId,analysis]));
  const counts=new Map<string,number>();
  for(const line of data.board.lines)if(Date.parse(line.eventStartTime)>nowMs&&isPlay(analyses.get(line.id),ai.get(line.id)))
    counts.set(line.eventId+'|'+line.playerId,(counts.get(line.eventId+'|'+line.playerId)??0)+1);
  return counts;
}
/**
 * Lite: the engine's ranked exact lines. Full: every play on the board (GKR or AI read), never a PASS. Both show one
 * card per player; the rest of a player's lines are on their page.
 */
export function boardLinesForMode(data:BoardResponse,filters:Filters,mode:ViewMode,
  nowMs=Date.now(),ai:ReadonlyMap<string,{pick:string;score:number|null;kind?:string}>=new Map()):PropLine[]{
  if(mode==='FULL'){
    const analyses=new Map(data.analyses.map((analysis)=>[analysis.lineId,analysis]));
    const strength=(line:PropLine)=>{const analysis=analyses.get(line.id);
      return analysis&&analysis.direction!=='PASS'&&analysis.score!==null?1000+analysis.score:ai.get(line.id)?.score??0;};
    return onePerPlayer(visibleLines(data,filters,nowMs).filter((line)=>isPlay(analyses.get(line.id),ai.get(line.id))),
      analyses,ai).sort((a,b)=>strength(b)-strength(a));
  }
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
      !passes(filters.sport,line.sport)||!passes(filters.market,line.market)||
      // The Board's line-style, evidence and date chips apply in both views; grade and
      // direction stay Full-only so a stale Full filter never hides ranked plays.
      !passes(filters.lineType,line.lineType)||!passes(filters.evidence,analysis.evidenceQuality)||
      !passes(filters.date,line.eventStartTime.slice(0,10))||!passes(filters.game,line.eventId))continue;
    if(ranked.some((item)=>item.eventId===line.eventId&&item.playerId===line.playerId))continue;
    ranked.push(line);
    if(ranked.length===LITE_LIMIT)break;
  }
  return ranked;
}
/**
 * What stands between a line and this Crown. `block` is a hard stop PrizePicks itself enforces (a started game, a side
 * it does not offer, the same player twice). `tips` are CrownIQ's own advice, which the user may override.
 */
export function checkLeg(legs: readonly CrownLeg[], line: PropLine, analysis: Analysis | undefined,
  direction: PlayableDirection, nowMs=Date.now()): { block: string | null; tips: LegTip[] } {
  if (Date.parse(line.eventStartTime)<=nowMs)
    return {block:'This game has started, so PrizePicks has closed the line.',tips:[]};
  if (line.lineType === 'UNKNOWN_ALTERNATE' || !line.availableDirections.includes(direction))
    return {block:`PrizePicks does not offer ${direction} on this line.`,tips:[]};
  if (legs.some((leg) => leg.line.playerId === line.playerId))
    return {block:`PrizePicks allows one pick per player in a lineup. ${line.playerName} is already in this Crown; ` +
      'remove or swap that leg first.',tips:[]};
  const tips:LegTip[]=[];
  const scored=!!analysis && analysis.direction!=='PASS' && analysis.score!==null && !!analysis.modelVersion;
  if (!scored) tips.push({id:'NO_SCORE',title:'GKR passes on this line',
    text:'There is not enough support for either side to score it. It goes in as your call, without a GKR score.'});
  else if (analysis!.direction!==direction) tips.push({id:'AGAINST_MODEL',title:`GKR leans ${analysis!.direction}`,
    text:`GKR scores ${analysis!.direction} at ${Math.round(analysis!.score!)}. Taking ${direction} goes against it, ` +
      'so this leg has no GKR score.'});
  else if (analysis!.score!<CROWN_LEG_FLOOR) tips.push({id:'LOW_SCORE',title:`GKR ${Math.round(analysis!.score!)} is a weaker pick`,
    text:`Every Crown CrownIQ builds starts at GKR ${CROWN_LEG_FLOOR}. This one sits under that.`});
  if (scored && evidenceExpired(analysis,nowMs)) tips.push({id:'STALE_EVIDENCE',title:'The research is out of date',
    text:'News may have changed since GKR last checked this player. Recheck the line before you play it.'});
  const sameTeam=line.team?legs.filter((leg)=>leg.line.team===line.team).length:0;
  if ((line.sport==='APEX' && sameTeam>=1) || sameTeam>=2) tips.push({id:'TEAM_STACK',
    title:`That is ${sameTeam+1} from ${line.team}`,
    text:'Legs from the same team tend to win or lose together, which makes the whole Crown swingier.'});
  return {block:null,tips};
}

/**
 * Adds a leg unless something blocks it. Tips not listed in `accept` come back unadded so the app can show them;
 * accepted tips are recorded on the leg as the user's call.
 */
export function addLeg(legs: readonly CrownLeg[], line: PropLine, analysis: Analysis | undefined,
  direction: PlayableDirection, nowMs=Date.now(), accept: readonly TipId[]=[]):
  { legs: CrownLeg[]; error: string | null; tips: LegTip[] } {
  const {block,tips}=checkLeg(legs,line,analysis,direction,nowMs);
  if (block) return {legs:[...legs],error:block,tips:[]};
  const pending=tips.filter((tip)=>!accept.includes(tip.id));
  if (pending.length) return {legs:[...legs],error:null,tips:pending};
  const backed=!tips.some((tip)=>tip.id==='NO_SCORE'||tip.id==='AGAINST_MODEL');
  // The server owns team/correlation audits; never call this draft an approved Crown.
  return {legs:[...legs,{line,direction,score:backed?analysis!.score:null,modelVersion:backed?analysis!.modelVersion:null,
    ...(tips.length?{yourCall:tips.map((tip)=>tip.id)}:{})}],error:null,tips:[]};
}

/**
 * The strongest qualified pick that would lift this Crown: it fits every rule in place of the weakest leg and beats
 * it by at least `margin` GKR points. Your-call legs count as the weakest.
 */
export function betterSwap(legs:readonly CrownLeg[],candidates:readonly {line:PropLine;analysis:Analysis}[],
  nowMs=Date.now(),margin=8):{weakest:CrownLeg;line:PropLine;analysis:Analysis}|null{
  if(!legs.length)return null;
  const weakest=[...legs].sort((a,b)=>(a.score??-1)-(b.score??-1))[0];
  const rest=legs.filter((leg)=>leg!==weakest);
  for(const {line,analysis} of candidates){
    if(analysis.direction==='PASS'||analysis.score===null||legs.some((leg)=>leg.line.id===line.id))continue;
    if(analysis.score<(weakest.score??0)+margin)continue;
    const check=checkLeg(rest,line,analysis,analysis.direction,nowMs);
    if(!check.block&&!check.tips.length)return {weakest,line,analysis};
  }
  return null;
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
    ...legs.map((leg,index) => `${index+1}. ${leg.line.playerName} · ${leg.line.market} ${leg.direction} ${leg.line.threshold} (${leg.line.lineType}) · ${leg.score===null?'your call':`GKR ${leg.score}`}`),
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
    if(!result.error&&!result.tips.length)legs=result.legs;
  }
  return legs;
}
