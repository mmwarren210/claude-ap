import { createHash } from 'node:crypto';
import { evidenceSchema } from '@crowniq/contracts';
import type { Evidence } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from '@crowniq/engine';
import type { StatApiOwnerResearch } from './stat-api-owner-research.js';

type JsonObject=Record<string,unknown>;
type CacheEntry={until:number;value:unknown};

const MLB_BASE='https://statsapi.mlb.com/api/v1';
const MLB_FEED_BASE='https://statsapi.mlb.com/api/v1.1';
const SLEEPER_NFL_PLAYERS='https://api.sleeper.app/v1/players/nfl';
/** Sleeper team codes to the full names the odds feed uses for NFL events. */
export const NFL_TEAMS:Readonly<Record<string,string>>={ARI:'Arizona Cardinals',ATL:'Atlanta Falcons',
  BAL:'Baltimore Ravens',BUF:'Buffalo Bills',CAR:'Carolina Panthers',CHI:'Chicago Bears',CIN:'Cincinnati Bengals',
  CLE:'Cleveland Browns',DAL:'Dallas Cowboys',DEN:'Denver Broncos',DET:'Detroit Lions',GB:'Green Bay Packers',
  HOU:'Houston Texans',IND:'Indianapolis Colts',JAX:'Jacksonville Jaguars',KC:'Kansas City Chiefs',
  LV:'Las Vegas Raiders',LAC:'Los Angeles Chargers',LAR:'Los Angeles Rams',MIA:'Miami Dolphins',
  MIN:'Minnesota Vikings',NE:'New England Patriots',NO:'New Orleans Saints',NYG:'New York Giants',
  NYJ:'New York Jets',PHI:'Philadelphia Eagles',PIT:'Pittsburgh Steelers',SF:'San Francisco 49ers',
  SEA:'Seattle Seahawks',TB:'Tampa Bay Buccaneers',TEN:'Tennessee Titans',WAS:'Washington Commanders'};
const sleeperPhoto=(id:string)=>`https://sleepercdn.com/content/nfl/players/${encodeURIComponent(id)}.jpg`;
const mlbPhoto=(id:number)=>`https://img.mlbstatic.com/mlb-photos/image/upload/w_213,q_auto:best/v1/people/${id}/headshot/67/current`;
const MLB_MARKETS=new Set(['batter_hits_runs_rbis','batter_hits','batter_walks',
  'batter_home_runs','pitcher_strikeouts']);
const NFL_MARKETS=new Set(['passing_yards','player_pass_attempts','player_pass_completions',
  'player_rush_yds','player_rush_attempts','player_reception_yds','player_receptions',
  'player_receiving_targets']);
const NBA_MARKETS=new Set(['player_points','player_rebounds','player_assists',
  'player_points_rebounds_assists','player_points_rebounds','player_points_assists',
  'player_rebounds_assists']);

const object=(value:unknown):JsonObject|null=>
  value&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:null;
const string=(value:unknown)=>typeof value==='string'?value.trim():'';
const number=(value:unknown)=>Number.isSafeInteger(Number(value))?Number(value):null;
const normalizeName=(value:string)=>{
  const normalized=value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()
    .replace(/\s+(jr|sr|ii|iii|iv)$/,'');
  const tokens=normalized.split(' ').filter(Boolean);
  let initialCount=0;
  while(initialCount<tokens.length&&tokens[initialCount].length===1)initialCount++;
  return initialCount>=2
    ? [tokens.slice(0,initialCount).join(''),...tokens.slice(initialCount)].join(' ')
    : normalized;
};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);
const dateOnly=(value:string)=>new Date(value).toISOString().slice(0,10);
const addDays=(day:string,delta:number)=>{
  const date=new Date(day+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+delta);
  return date.toISOString().slice(0,10);
};
const expires=(target:ResearchTarget,now:Date,ttlMs:number)=>new Date(Math.min(
  Date.parse(target.eventStartTime),now.getTime()+ttlMs)).toISOString();

export interface CurrentContextOptions{
  readonly fetchFn?:typeof fetch;
  readonly clock?:()=>Date;
  readonly allowedKeys?:readonly string[];
  readonly statSource?:Pick<StatApiOwnerResearch,'currentAvailability'>;
}

type SleeperPlayer={full_name?:string|null;first_name?:string|null;last_name?:string|null;
  position?:string|null;status?:string|null;injury_status?:string|null;team?:string|null};

type MlbGame={gamePk:number;awayNames:string[];homeNames:string[];startTime:string|null;raw:JsonObject};
type NbaDiagnostics={lookups:number;identityMatched:number;availabilityResolved:number;failures:number};

type MlbDiagnostics={
  groups:number;
  gameMatchedTargets:number;
  boxscoreMatchedTargets:number;
  playerMatchedTargets:number;
  batterTargets:number;
  lineupPostedTargets:number;
  starterContextTargets:number;
  evidenceTargets:number;
  sourceFailures:number;
  failedGroups:number;
  /** Where each game's lookup stopped, so a game that gets no context can be traced. */
  games:{event:string;targets:number;gamePk:number|null;stage:string;lineupSource:string|null}[];
};

function teamNames(value:unknown):string[]{
  const team=object(object(value)?.team);
  if(!team)return[];
  return [...new Set(['name','teamName','clubName','shortName','abbreviation','teamCode']
    .map((key)=>string(team[key])).filter(Boolean))];
}
function nameMatchScore(haystack:string,names:readonly string[]):number{
  let score=0;
  for(const raw of names){
    const name=normalizeName(raw);if(!name)continue;
    if(haystack.includes(name))score=Math.max(score,4);
    const last=name.split(' ').at(-1)??'';
    if(last.length>=3&&haystack.includes(last))score=Math.max(score,2);
  }
  return score;
}
function parseSchedule(raw:unknown):MlbGame[]{
  const root=object(raw),dateRows=root?.dates;
  const dates=Array.isArray(dateRows)?dateRows:[];
  const games:MlbGame[]=[];
  for(const date of dates){
    const day=object(date),gameRows=day?.games;
    const rows=Array.isArray(gameRows)?gameRows:[];
    for(const item of rows){
      const game=object(item),pk=number(game?.gamePk),teams=object(game?.teams);
      if(!game||!pk||!teams)continue;
      const gameDate=string(game.gameDate)||string(day?.date);
      games.push({gamePk:pk,awayNames:teamNames(teams.away),homeNames:teamNames(teams.home),
        startTime:gameDate||null,raw:game});
    }
  }
  return games;
}
function matchGame(target:ResearchTarget,games:readonly MlbGame[]):MlbGame|null{
  const hay=normalizeName([target.eventName,target.team??'',target.opponent??''].join(' '));
  const targetDay=dateOnly(target.eventStartTime);
  const scored=games.map((game)=>{
    const away=nameMatchScore(hay,game.awayNames),home=nameMatchScore(hay,game.homeNames);
    const gameDay=game.startTime?dateOnly(game.startTime):null;
    return {game,away,home,score:away+home,sameDay:gameDay===targetDay};
  });
  // Normal case: both official team names resolve directly.
  const exact=scored.filter((item)=>item.away>=2&&item.home>=2)
    .sort((a,b)=>Number(b.sameDay)-Number(a.sameDay)||b.score-a.score);
  if(exact.length && !(exact.length>1&&exact[0].sameDay===exact[1].sameDay&&
    exact[0].score===exact[1].score))return exact[0].game;
  // A tie (a doubleheader, or a postponed game listed again) resolves only to the one game starting within
  // 3 hours of the line's start.
  if(exact.length>1){
    const targetStart=Date.parse(target.eventStartTime);
    const near=exact.filter((item)=>item.game.startTime&&
      Math.abs(Date.parse(item.game.startTime)-targetStart)<=3*3600_000);
    if(near.length===1)return near[0].game;
  }

  // MLB postseason schedules can temporarily expose placeholders such as NLWC3
  // after the DFS/odds feed already knows the advancing club. On the exact event
  // day, accept one strongly matching side only when it identifies one unique game.
  const oneSide=scored.filter((item)=>item.sameDay&&Math.max(item.away,item.home)>=4);
  if(oneSide.length!==1)return null;
  return oneSide[0].game;
}
function playerName(value:unknown):string{
  const row=object(value);return string(row?.fullName)||string(row?.full_name)||
    string(row?.displayName)||string(row?.name);
}
function ids(value:unknown):number[]{
  return Array.isArray(value)?value.map(number).filter((item):item is number=>item!==null):[];
}
function uniqueEvidence(items:readonly Evidence[]):Evidence[]{
  const byId=new Map<string,Evidence>();
  for(const item of items)if(!byId.has(item.id))byId.set(item.id,item);
  return [...byId.values()];
}

function injuryStatuses(root:unknown):Map<string,string[]>{
  const found=new Map<string,string[]>();
  const seen=new Set<object>();
  const walk=(value:unknown)=>{
    if(!value||typeof value!=='object')return;
    if(seen.has(value as object))return;seen.add(value as object);
    if(Array.isArray(value)){for(const item of value)walk(item);return;}
    const row=value as JsonObject,nested=object(row.player);
    const name=playerName(nested) || playerName(row);
    const statuses:string[]=[];
    for(const key of ['status','game_status','gameStatus','injury_status','injuryStatus']){
      const v=string(row[key])||string(nested?.[key]);if(v)statuses.push(v);
    }
    for(const container of [row.injuries,nested?.injuries]){
      if(!Array.isArray(container))continue;
      for(const injury of container){
        const item=object(injury);if(!item)continue;
        for(const key of ['status','game_status','gameStatus','injury_status','injuryStatus']){
          const v=string(item[key]);if(v)statuses.push(v);
        }
      }
    }
    if(name&&statuses.length){
      const key=normalizeName(name);found.set(key,[...(found.get(key)??[]),...statuses]);
    }
    for(const child of Object.values(row))walk(child);
  };
  walk(root);return found;
}

export class CurrentContextResearch implements ResearchAdapter{
  readonly id='current-context-v1';
  private readonly fetchFn:typeof fetch;
  private readonly clock:()=>Date;
  private readonly allowedKeys:Set<string>|null;
  private readonly statSource:Pick<StatApiOwnerResearch,'currentAvailability'>|null;
  private cache=new Map<string,CacheEntry>();
  private health:ResearchHealth={status:'OK',targets:0,searches:0,cacheHits:0,skipped:0,
    failures:0,noSources:0,lastRunAt:null};

  constructor(options:CurrentContextOptions={}){
    this.fetchFn=options.fetchFn??fetch;this.clock=options.clock??(()=>new Date());
    this.allowedKeys=options.allowedKeys?new Set(options.allowedKeys):null;
    this.statSource=options.statSource??null;
  }
  getHealth(){return this.health;}
  supports(target:ResearchTarget):boolean{
    if(Date.parse(target.eventStartTime)<=this.clock().getTime())return false;
    const key=target.sport+':'+target.market;
    if(this.allowedKeys&&!this.allowedKeys.has(key))return false;
    if(target.sport==='MLB')return MLB_MARKETS.has(target.market);
    if(target.sport==='NFL')return NFL_MARKETS.has(target.market);
    if(target.sport==='NBA')return !!this.statSource&&NBA_MARKETS.has(target.market);
    return false;
  }

  private async json(url:string,ttlMs:number,headers:Record<string,string>|undefined,
    counters:{searches:number;cacheHits:number}):Promise<unknown>{
    const now=this.clock().getTime(),cached=this.cache.get(url);
    if(cached&&cached.until>now){counters.cacheHits++;return cached.value;}
    let response:Response|null=null;
    for(let attempt=0;attempt<2;attempt++){
      counters.searches++;
      try{response=await this.fetchFn(url,{headers,signal:AbortSignal.timeout(15_000)});}
      catch{response=null;}
      if(response?.ok)break;
      if(response && response.status<500)break;
    }
    if(!response?.ok)throw new Error('CURRENT_CONTEXT_SOURCE_UNAVAILABLE');
    const body=await response.text();
    if(body.length>30_000_000)throw new Error('CURRENT_CONTEXT_SOURCE_TOO_LARGE');
    const value=JSON.parse(body) as unknown;this.cache.set(url,{until:now+ttlMs,value});return value;
  }

  private evidence(target:ResearchTarget,kind:string,value:number,finding:string,sourceName:string,
    sourceUrl:string,sourceType:'OFFICIAL'|'PUBLIC'|'LICENSED_FEED',quality:'HIGH'|'MEDIUM',
    confidence:number,ttlMs:number):Evidence{
    const now=this.clock();
    return evidenceSchema.parse({id:'current:'+hash(JSON.stringify([
      target.eventId,target.playerId,kind,sourceName,Math.floor(now.getTime()/Math.max(ttlMs,60_000))])),
      entityType:'PLAYER',entityId:target.playerId,eventId:target.eventId,market:null,kind,finding,
      sourceName,sourceUrl,sourceType,retrievedAt:now.toISOString(),
      expiresAt:expires(target,now,ttlMs),quality,confidence,numeric:{value}});
  }

  private async nfl(targets:readonly ResearchTarget[],counters:{searches:number;cacheHits:number}){
    if(!targets.length)return[] as Evidence[];
    const raw=await this.json(SLEEPER_NFL_PLAYERS,15*60_000,undefined,counters);
    const root=object(raw);if(!root)throw new Error('CURRENT_NFL_STATUS_INVALID');
    const byName=new Map<string,{id:string;player:SleeperPlayer}[]>();
    for(const [id,value] of Object.entries(root)){
      const player=object(value) as SleeperPlayer|null;if(!player)continue;
      const full=(player.full_name??[player.first_name,player.last_name].filter(Boolean).join(' ')).trim();
      if(!full)continue;const key=normalizeName(full);
      byName.set(key,[...(byName.get(key)??[]),{id,player}]);
    }
    const out:Evidence[]=[];
    for(const target of targets){
      let matches=byName.get(normalizeName(target.playerName))??[];
      // Prefer players on one of this game's two teams; this separates players who share a name.
      const sides=[target.homeTeam,target.awayTeam].filter((side):side is string=>!!side);
      if(sides.length){
        const inGame=matches.filter((item)=>sides.includes(NFL_TEAMS[(item.player.team??'').toUpperCase()]??''));
        if(inGame.length)matches=inGame;
      }
      if(matches.length!==1)continue;
      const team=NFL_TEAMS[(matches[0].player.team??'').toUpperCase()];
      if(team&&sides.includes(team))out.push(this.evidence(target,'identity:team',1,team,
        'Sleeper public NFL player feed',SLEEPER_NFL_PLAYERS,'PUBLIC','MEDIUM',.8,30*60_000));
      out.push(this.evidence(target,'identity:photo',1,'Player headshot',
        'Sleeper player photos',sleeperPhoto(matches[0].id),'PUBLIC','MEDIUM',.8,30*60_000));
      const player=matches[0].player,status=(player.status??'').trim().toLowerCase(),
        injury=(player.injury_status??'').trim();
      const available=(status===''||status==='active')&&!injury;
      out.push(this.evidence(target,'status:player_available',available?1:0,
        available?'Exact-name player is currently listed active with no injury designation.'
          :`Exact-name player is not confirmed active and uninjured (status ${status||'unspecified'}; injury ${injury||'none'}).`,
        'Sleeper public NFL player feed',SLEEPER_NFL_PLAYERS,'PUBLIC','MEDIUM',.8,30*60_000));
      if((player.position??'').toUpperCase()==='QB'){
        out.push(this.evidence(target,'status:qb_available',available?1:0,
          available?'Exact-name quarterback is listed active with no injury designation.'
            :'Exact-name quarterback is not confirmed active and uninjured.',
          'Sleeper public NFL player feed',SLEEPER_NFL_PLAYERS,'PUBLIC','MEDIUM',.8,30*60_000));
      }
    }
    return out;
  }

  private async mlb(targets:readonly ResearchTarget[],counters:{searches:number;cacheHits:number}){
    const out:Evidence[]=[],identity:Evidence[]=[];const diagnostics:MlbDiagnostics={groups:0,gameMatchedTargets:0,
      boxscoreMatchedTargets:0,playerMatchedTargets:0,batterTargets:0,lineupPostedTargets:0,
      starterContextTargets:0,evidenceTargets:0,sourceFailures:0,failedGroups:0,games:[]};
    if(!targets.length)return {evidence:out,diagnostics};
    const groups=new Map<string,ResearchTarget[]>();
    for(const target of targets)groups.set(target.eventId,[...(groups.get(target.eventId)??[]),target]);
    diagnostics.groups=groups.size;
    diagnostics.batterTargets=targets.filter((target)=>target.market!=='pitcher_strikeouts').length;
    const schedules=new Map<string,MlbGame[]>();
    for(const group of groups.values()){
      const day=dateOnly(group[0].eventStartTime),range=addDays(day,-1)+'|'+addDays(day,1);
      if(schedules.has(range))continue;
      const [start,end]=range.split('|');
      const url=`${MLB_BASE}/schedule?sportId=1&startDate=${start}&endDate=${end}&hydrate=team,probablePitcher,lineups`;
      try{schedules.set(range,parseSchedule(await this.json(url,5*60_000,undefined,counters)));}
      catch{diagnostics.sourceFailures++;schedules.set(range,[]);}
    }
    for(const group of groups.values()){
      const first=group[0],day=dateOnly(first.eventStartTime),range=addDays(day,-1)+'|'+addDays(day,1);
      const record={event:`${first.eventName} ${first.eventStartTime}`,targets:group.length,gamePk:null as number|null,
        stage:'GAME_UNRESOLVED',lineupSource:null as string|null};
      diagnostics.games.push(record);
      // One event can carry differently worded lines (e.g. "Padres @ Brewers" and "Brewers vs Padres"), so every
      // distinct wording gets a try; the first that resolves to one official game wins.
      const wordings=[...new Map(group.map((target)=>[[target.eventName,target.team,target.opponent].join('|'),target]))
        .values()];
      let game:MlbGame|null=null;
      for(const target of wordings){game=matchGame(target,schedules.get(range)??[]);if(game)break;}
      if(!game)continue;
      record.gamePk=game.gamePk;
      diagnostics.gameMatchedTargets+=group.length;
      const sourceUrl=`${MLB_FEED_BASE}/game/${game.gamePk}/feed/live`;
      let feed:JsonObject|null=null;
      try{feed=object(await this.json(sourceUrl,2*60_000,undefined,counters));}
      catch{diagnostics.sourceFailures++;diagnostics.failedGroups++;record.stage='FEED_REQUEST_FAILED';continue;}
      if(!feed){record.stage='FEED_EMPTY';continue;}
      const gameData=object(feed.gameData),liveData=object(feed.liveData),
        box=object(object(liveData?.boxscore)?.teams),probable=object(gameData?.probablePitchers);
      if(!box){record.stage='BOXSCORE_UNAVAILABLE';continue;}
      record.stage='OK';
      diagnostics.boxscoreMatchedTargets+=group.length;
      // The posted batting order comes from the game feed's boxscore; the schedule's lineups (same official
      // source, already fetched) fill in only when the boxscore has none yet.
      const scheduled=object(game.raw.lineups);
      const sideData=(side:'away'|'home')=>{
        const team=object(box[side]),players=object(team?.players),boxOrder=ids(team?.battingOrder);
        const listed=boxOrder.length?[]:ids((Array.isArray(scheduled?.[side+'Players'])
          ?scheduled[side+'Players'] as unknown[]:[]).map((row)=>object(row)?.id));
        return {team,players,battingOrder:boxOrder.length?boxOrder:listed,
          lineupSource:boxOrder.length?'boxscore':listed.length?'schedule':null,pitchers:ids(team?.pitchers)};
      };
      const away=sideData('away'),home=sideData('home');
      record.lineupSource=[away.lineupSource&&'away:'+away.lineupSource,home.lineupSource&&'home:'+home.lineupSource]
        .filter(Boolean).join(',')||null;
      const personIndex=new Map<number,string>();
      for(const players of [away.players,home.players]){
        if(!players)continue;
        for(const value of Object.values(players)){
          const row=object(value),id=number(object(row?.person)?.id),name=playerName(object(row?.person));
          if(id&&name)personIndex.set(id,name);
        }
      }
      const probableId=(side:'away'|'home')=>number(object(probable?.[side])?.id);
      for(const target of group){
        const beforeCount=out.length;
        const wanted=normalizeName(target.playerName);
        const matches=[...personIndex].filter(([,name])=>normalizeName(name)===wanted);
        if(matches.length!==1)continue;
        diagnostics.playerMatchedTargets++;
        const playerId=matches[0][0],side=away.players&&Object.values(away.players).some((value)=>
          number(object(object(value)?.person)?.id)===playerId)?'away':
          home.players&&Object.values(home.players).some((value)=>
            number(object(object(value)?.person)?.id)===playerId)?'home':null;
        if(!side)continue;
        const mine=side==='away'?away:home,other=side==='away'?'home':'away';
        // The boxscore side is exact, so the team is the matching side of this event.
        const team=side==='away'?target.awayTeam:target.homeTeam;
        if(team)identity.push(this.evidence(target,'identity:team',1,team,'MLB Stats API',sourceUrl,'OFFICIAL','HIGH',.95,30*60_000));
        identity.push(this.evidence(target,'identity:photo',1,'Player headshot','MLB player photos',mlbPhoto(playerId),
          'OFFICIAL','HIGH',.95,30*60_000));
        if(target.market==='pitcher_strikeouts'){
          const starter=probableId(side);
          if(starter){
            diagnostics.starterContextTargets++;
            out.push(this.evidence(target,'status:starting_pitcher',starter===playerId?1:0,
              starter===playerId?'MLB official game feed lists this player as the probable starter.'
                :'MLB official game feed lists a different probable starter for this team.',
              'MLB Stats API',sourceUrl,'OFFICIAL','HIGH',.95,30*60_000));
          }
        }else{
          if(mine.battingOrder.length){
            diagnostics.lineupPostedTargets++;
            out.push(this.evidence(target,'status:starting_lineup',
              mine.battingOrder.includes(playerId)?1:0,
              mine.battingOrder.includes(playerId)?'MLB official game feed includes this player in the posted batting order.'
                :'MLB official game feed has a posted batting order and this player is not in it.',
              'MLB Stats API',sourceUrl,'OFFICIAL','HIGH',.98,30*60_000));
          }
          const opposingStarter=probableId(other);
          if(opposingStarter){
            diagnostics.starterContextTargets++;
            out.push(this.evidence(target,'status:starting_pitcher',1,
              `MLB official game feed lists opposing probable pitcher ${personIndex.get(opposingStarter)??opposingStarter}.`,
              'MLB Stats API',sourceUrl,'OFFICIAL','HIGH',.92,30*60_000));
          }
        }
        if(out.length>beforeCount)diagnostics.evidenceTargets++;
      }
    }
    // Identity is kept out of the context diagnostics, which count status findings only.
    return {evidence:[...out,...identity],diagnostics};
  }
  private async nba(targets:readonly ResearchTarget[]){
    const diagnostics:NbaDiagnostics={lookups:0,identityMatched:0,availabilityResolved:0,failures:0};
    if(!targets.length||!this.statSource)return {evidence:[] as Evidence[],failures:0,diagnostics};
    const out:Evidence[]=[];
    const unique=new Map<string,ResearchTarget>();
    for(const target of targets)unique.set(target.eventId+'|'+normalizeName(target.playerName),target);
    for(const target of unique.values()){
      diagnostics.lookups++;
      let context:Awaited<ReturnType<StatApiOwnerResearch['currentAvailability']>>;
      try{context=await this.statSource.currentAvailability('NBA',target.playerName);}
      catch{diagnostics.failures++;continue;}
      if(!context)continue;
      diagnostics.identityMatched++;
      const injury=(context.preGameInjuryStatus??context.injuryStatus??'').trim().toLowerCase();
      const roster=(context.rosterStatus??'').trim().toLowerCase();
      const status=(context.status??'').trim().toLowerCase();
      let available:number|null=null;
      // Do not infer availability from undocumented numeric pre_game_status values.
      if(/\b(out|inactive|doubtful|suspended|not expected)\b/.test(injury+' '+status))
        available=0;
      else if(/\b(probable|available|active)\b/.test(injury+' '+status) ||
        roster==='active'&&!injury)available=1;
      else if(roster&&roster!=='active')available=0;
      if(available===null)continue;
      diagnostics.availabilityResolved++;
      const finding=available===1
        ? 'Exact-name NBA player is currently confirmed available by the licensed player-status feed.'
        : 'Exact-name NBA player is not currently confirmed available by the licensed player-status feed.';
      out.push(this.evidence(target,'status:player_available',available,finding,
        'Stat API NBA player status',context.sourceUrl,'LICENSED_FEED','HIGH',.95,10*60_000));
    }
    return {evidence:out,failures:diagnostics.failures,diagnostics};
  }
  async research(targets:readonly ResearchTarget[]):Promise<readonly Evidence[]>{
    const eligible=targets.filter((target)=>this.supports(target));
    const nfl=eligible.filter((target)=>target.sport==='NFL');
    const mlb=eligible.filter((target)=>target.sport==='MLB');
    const nba=eligible.filter((target)=>target.sport==='NBA');
    const counters={searches:0,cacheHits:0};let failures=0,noSources=0;
    const evidence:Evidence[]=[];
    const sources:Record<string,{status:'OK'|'PARTIAL'|'FAILED'|'SKIPPED';targets:number;
      evidence:number;failures:number;errorCode?:string|null}>={};
    type SourceResult={evidence:Evidence[];failures:number;mlb?:MlbDiagnostics;nba?:NbaDiagnostics};
    const jobs:{id:string;targets:number;promise:Promise<SourceResult>}[]=[];
    if(nfl.length)jobs.push({id:'NFL_PUBLIC_STATUS',targets:nfl.length,
      promise:this.nfl(nfl,counters).then((evidence)=>({evidence,failures:0}))});
    if(mlb.length)jobs.push({id:'MLB_OFFICIAL_CONTEXT',targets:mlb.length,
      promise:this.mlb(mlb,counters).then((result)=>({evidence:result.evidence,
        failures:result.diagnostics.sourceFailures,mlb:result.diagnostics}))});
    if(nba.length)jobs.push({id:'NBA_STAT_STATUS',targets:nba.length,promise:this.nba(nba).then((result)=>({...result,nba:result.diagnostics}))});
    const settled=await Promise.allSettled(jobs.map((job)=>job.promise));
    for(let index=0;index<settled.length;index++){
      const result=settled[index],job=jobs[index];
      if(result.status==='fulfilled'){
        const sourceEvidence=uniqueEvidence(result.value.evidence);
        evidence.push(...sourceEvidence);
        failures+=result.value.failures;
        if(!sourceEvidence.length)noSources++;
        const sourceStatus=result.value.failures
          ? sourceEvidence.length?'PARTIAL' as const:'FAILED' as const:'OK' as const;
        sources[job.id]={status:sourceStatus,targets:job.targets,
          evidence:sourceEvidence.length,failures:result.value.failures,
          errorCode:result.value.failures?'TARGET_LOOKUP_FAILED':
            sourceEvidence.length?null:'NO_MATCHING_CONTEXT'};
        if(job.id==='MLB_OFFICIAL_CONTEXT'&&result.value.mlb){
          const mlb=result.value.mlb;
          const stage=(evidenceCount:number,targets:number,errorCode:string)=>{
            const ok=evidenceCount>=targets;
            return {status:(ok?'OK':'PARTIAL') as 'OK'|'PARTIAL',targets,evidence:evidenceCount,
              failures:0,errorCode:ok?null:errorCode};
          };
          sources.MLB_GAME_MATCH=stage(mlb.gameMatchedTargets,job.targets,'GAME_UNRESOLVED');
          sources.MLB_BOXSCORE=stage(mlb.boxscoreMatchedTargets,mlb.gameMatchedTargets,
            'BOXSCORE_UNAVAILABLE');
          sources.MLB_PLAYER_MATCH=stage(mlb.playerMatchedTargets,mlb.boxscoreMatchedTargets,
            'PLAYER_UNRESOLVED');
          sources.MLB_LINEUP_POSTED=stage(mlb.lineupPostedTargets,mlb.batterTargets,
            'LINEUP_NOT_POSTED');
          sources.MLB_STARTER_CONTEXT=stage(mlb.starterContextTargets,job.targets,
            'PROBABLE_STARTER_UNAVAILABLE');
          sources.MLB_EVIDENCE_TARGETS=stage(mlb.evidenceTargets,job.targets,
            'NO_CANONICAL_CONTEXT');
          for(const game of mlb.games)sources['MLB_GAME '+game.event]={status:game.stage==='OK'?'OK':'PARTIAL',
            targets:game.targets,evidence:0,failures:0,
            errorCode:(game.gamePk?`GAME_${game.gamePk} `:'')+(game.stage!=='OK'?game.stage:game.lineupSource
              ?'LINEUP '+game.lineupSource:'LINEUP_NOT_POSTED')};
          sources.MLB_SOURCE_HEALTH={status:mlb.sourceFailures?'PARTIAL':'OK',
            targets:mlb.groups,evidence:mlb.groups-mlb.failedGroups,failures:mlb.sourceFailures,
            errorCode:mlb.sourceFailures?'SOURCE_REQUEST_FAILED':null};
        }
        if(job.id==='NBA_STAT_STATUS'&&result.value.nba){
          const nba=result.value.nba;
          const stage=(evidenceCount:number,targets:number,errorCode:string)=>{
            const ok=evidenceCount>=targets;
            return {status:(ok?'OK':'PARTIAL') as 'OK'|'PARTIAL',targets,evidence:evidenceCount,
              failures:0,errorCode:ok?null:errorCode};
          };
          sources.NBA_IDENTITY_MATCH=stage(nba.identityMatched,nba.lookups,'IDENTITY_UNRESOLVED');
          sources.NBA_AVAILABILITY_RESOLVED=stage(nba.availabilityResolved,nba.lookups,
            'STATUS_UNCONFIRMED');
          sources.NBA_SOURCE_HEALTH={status:nba.failures?'PARTIAL':'OK',targets:nba.lookups,
            evidence:nba.lookups-nba.failures,failures:nba.failures,
            errorCode:nba.failures?'SOURCE_REQUEST_FAILED':null};
        }
      }else{
        failures++;
        const raw=result.reason instanceof Error?result.reason.message:'CURRENT_CONTEXT_FAILED';
        const errorCode=/^[A-Z0-9_]+$/.test(raw)?raw:'CURRENT_CONTEXT_FAILED';
        sources[job.id]={status:'FAILED',targets:job.targets,evidence:0,failures:1,errorCode};
      }
    }
    const unique=uniqueEvidence(evidence);
    this.health={status:failures?unique.length?'PARTIAL':'FAILED':'OK',targets:eligible.length,
      searches:counters.searches,cacheHits:counters.cacheHits,skipped:targets.length-eligible.length,
      failures,noSources,lastRunAt:this.clock().toISOString(),sources};
    return unique;
  }
}
