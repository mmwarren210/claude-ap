import { createHash } from 'node:crypto';
import { evidenceSchema } from '@crowniq/contracts';
import type { Evidence } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from '@crowniq/engine';

type NflRow = Record<string,string>;
type SleeperPlayer = {
  full_name?:string|null; first_name?:string|null; last_name?:string|null;
  position?:string|null; status?:string|null; injury_status?:string|null; team?:string|null;
};

const NFLVERSE_BASE='https://github.com/nflverse/nflverse-data/releases/download/stats_player';
const SLEEPER_PLAYERS='https://api.sleeper.app/v1/players/nfl';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);
const normalizeName=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()
  .replace(/\s+(jr|sr|ii|iii|iv)$/,'');

function csvRows(input:string):string[][]{
  const rows:string[][]=[];let fields:string[]=[],field='',quoted=false;
  for(let i=0;i<input.length;i++){
    const char=input[i];
    if(char==='"'){
      if(quoted&&input[i+1]==='"'){field+='"';i++;}
      else if(quoted||field==='')quoted=!quoted;
      else throw new Error('INVALID_CSV_QUOTE');
    }else if(char===','&&!quoted){fields.push(field);field='';}
    else if((char==='\n'||char==='\r')&&!quoted){
      if(char==='\r'&&input[i+1]==='\n')i++;
      fields.push(field);field='';
      if(fields.some((part)=>part!==''))rows.push(fields);
      fields=[];
    }else field+=char;
  }
  if(quoted)throw new Error('UNCLOSED_CSV_QUOTE');
  if(field||fields.length){fields.push(field);rows.push(fields);}
  return rows;
}
export function parseNflverseHistory(csv:string):NflRow[]{
  const [columns,...rows]=csvRows(csv.replace(/^\uFEFF/,''));
  if(!columns)throw new Error('EMPTY_STATS_CSV');
  const nameColumns=['player_display_name','player_name','player_name_short'];
  if(!nameColumns.some((key)=>columns.includes(key))||
    !['attempts','passing_yards','completions'].every((key)=>columns.includes(key)))
    throw new Error('NFLVERSE_HISTORY_COLUMNS_MISSING');
  return rows.map((fields)=>{
    if(fields.length!==columns.length)throw new Error('NFLVERSE_HISTORY_ROW_INVALID');
    return Object.fromEntries(columns.map((key,index)=>[key,fields[index]]));
  });
}
const number=(row:NflRow,key:string)=>{
  const value=Number(row[key]); return Number.isFinite(value)?value:null;
};
const name=(row:NflRow)=>['player_display_name','player_name','player_name_short']
  .map((key)=>row[key]).find((value)=>value?.trim())??'';
const mean=(values:readonly number[])=>values.reduce((a,b)=>a+b,0)/values.length;
const sd=(values:readonly number[])=>{
  if(values.length<2)return 0;const m=mean(values);
  return Math.sqrt(values.reduce((sum,value)=>sum+(value-m)**2,0)/(values.length-1));
};
const series=(rows:readonly NflRow[],pick:(row:NflRow)=>number|null)=>rows.map(pick)
  .filter((value):value is number=>value!==null&&Number.isFinite(value));
const seasonFor=(iso:string)=>{const d=new Date(iso),year=d.getUTCFullYear(),month=d.getUTCMonth()+1;
  return month<=2?year-1:year;};

interface Cache<T>{value:T;until:number}
export interface PublicNflGkrEvidenceOptions{
  readonly fetchFn?:typeof fetch;readonly clock?:()=>Date;readonly minSamples?:number;
  readonly recentSamples?:number;
}

/**
 * Key-free NFL evidence from public nflverse history plus the public Sleeper player-status feed.
 * Historical rows never use the PrizePicks threshold; current status is conservative and only
 * confirms availability when the exact-name QB is active with no injury designation.
 */
export class PublicNflGkrEvidence implements ResearchAdapter{
  readonly id='public-nfl-gkr-evidence-v1';
  private health:ResearchHealth={status:'OK',targets:0,searches:0,cacheHits:0,skipped:0,
    failures:0,noSources:0,lastRunAt:null};
  private history=new Map<number,Cache<NflRow[]>>();
  private sleeper:Cache<Record<string,SleeperPlayer>>|null=null;
  private readonly fetchFn:typeof fetch;
  private readonly clock:()=>Date;
  private readonly minSamples:number;
  private readonly recentSamples:number;

  constructor(options:PublicNflGkrEvidenceOptions={}){
    this.fetchFn=options.fetchFn??fetch;this.clock=options.clock??(()=>new Date());
    this.minSamples=options.minSamples??5;this.recentSamples=options.recentSamples??10;
    if(!Number.isInteger(this.minSamples)||this.minSamples<3||this.minSamples>20||
      !Number.isInteger(this.recentSamples)||this.recentSamples<this.minSamples||this.recentSamples>20)
      throw new Error('INVALID_PUBLIC_NFL_EVIDENCE_CONFIGURATION');
  }
  getHealth(){return this.health;}

  private async fetchText(url:string,limit:number){
    const response=await this.fetchFn(url,{signal:AbortSignal.timeout(20_000)});
    if(!response.ok)throw new Error('PUBLIC_NFL_SOURCE_UNAVAILABLE');
    if(Number(response.headers.get('content-length')??0)>limit)
      throw new Error('PUBLIC_NFL_SOURCE_TOO_LARGE');
    const body=await response.text();
    if(body.length>limit)throw new Error('PUBLIC_NFL_SOURCE_TOO_LARGE');
    return body;
  }
  private async rows(season:number,counters:{searches:number;cacheHits:number}){
    const now=this.clock().getTime(),cached=this.history.get(season);
    if(cached&&cached.until>now){counters.cacheHits++;return cached.value;}
    counters.searches++;
    const url=`${NFLVERSE_BASE}/stats_player_week_${season}.csv`;
    const value=parseNflverseHistory(await this.fetchText(url,60_000_000))
      .map((row)=>({...row,__source_season:String(season)}));
    this.history.set(season,{value,until:now+30*60_000});return value;
  }
  private async players(counters:{searches:number;cacheHits:number}){
    const now=this.clock().getTime();
    if(this.sleeper&&this.sleeper.until>now){counters.cacheHits++;return this.sleeper.value;}
    counters.searches++;
    const raw=JSON.parse(await this.fetchText(SLEEPER_PLAYERS,30_000_000)) as unknown;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('PUBLIC_NFL_STATUS_INVALID');
    const value=raw as Record<string,SleeperPlayer>;
    this.sleeper={value,until:now+15*60_000};return value;
  }

  async research(targets:readonly ResearchTarget[]):Promise<readonly Evidence[]>{
    const now=this.clock(),eligible=targets.filter((target)=>target.sport==='NFL'&&
      ['passing_yards','player_pass_attempts','player_pass_completions'].includes(target.market)&&
      Date.parse(target.eventStartTime)>now.getTime());
    const counters={searches:0,cacheHits:0};let skipped=0,failures=0,noSources=0;
    const evidence:Evidence[]=[];
    try{
      const seasons=[...new Set(eligible.flatMap((target)=>{
        const season=seasonFor(target.eventStartTime);return [season,season-1];
      }))];
      const history=new Map<number,NflRow[]>();
      for(const season of seasons)history.set(season,await this.rows(season,counters));
      const players=await this.players(counters);
      const statusIndex=new Map<string,SleeperPlayer[]>();
      for(const player of Object.values(players)){
        const full=(player.full_name??[player.first_name,player.last_name].filter(Boolean).join(' ')).trim();
        if(!full)continue;const key=normalizeName(full);
        statusIndex.set(key,[...(statusIndex.get(key)??[]),player]);
      }

      const grouped=new Map<string,ResearchTarget[]>();
      for(const target of eligible){
        const key=[seasonFor(target.eventStartTime),normalizeName(target.playerName)].join('|');
        grouped.set(key,[...(grouped.get(key)??[]),target]);
      }
      for(const group of grouped.values()){
        const first=group[0],season=seasonFor(first.eventStartTime),wanted=normalizeName(first.playerName);
        const matches=[...(history.get(season)??[]),...(history.get(season-1)??[])]
          .filter((row)=>normalizeName(name(row))===wanted);
        const statuses=(statusIndex.get(wanted)??[]).filter((item)=>item.position==='QB');
        if(!matches.length){noSources++;skipped++;continue;}
        for(const target of group)evidence.push(...this.forTarget(target,matches,now));
        if(statuses.length===1){
          const player=statuses[0],status=(player.status??'').toLowerCase(),
            injury=(player.injury_status??'').trim();
          const available=(status==='active'||status==='')&&!injury;
          evidence.push(evidenceSchema.parse({id:'public-nfl:'+hash(JSON.stringify([
            first.eventId,first.playerId,'status:qb_available',now.toISOString().slice(0,13)])),
            entityType:'PLAYER',entityId:first.playerId,eventId:first.eventId,market:null,
            kind:'status:qb_available',
            finding:available
              ? 'Exact-name quarterback is listed active with no injury designation in the current public player-status feed.'
              : 'Exact-name quarterback is not currently confirmed active and uninjured in the public player-status feed.',
            sourceName:'Sleeper public NFL player feed',sourceUrl:SLEEPER_PLAYERS,sourceType:'PUBLIC',
            retrievedAt:now.toISOString(),expiresAt:new Date(Math.min(
              Date.parse(first.eventStartTime),now.getTime()+60*60_000)).toISOString(),
            quality:'MEDIUM',confidence:.8,numeric:{value:available?1:0}}));
        }
      }
    }catch{failures++;}
    this.health={status:failures?evidence.length?'PARTIAL':'FAILED':'OK',targets:targets.length,
      searches:counters.searches,cacheHits:counters.cacheHits,skipped,failures,noSources,
      lastRunAt:now.toISOString()};
    return evidence;
  }

  private forTarget(target:ResearchTarget,rows:readonly NflRow[],now:Date):Evidence[]{
    const sorted=[...rows].sort((a,b)=>{
      const aSeason=Number(a.season??a.__source_season)||0,bSeason=Number(b.season??b.__source_season)||0;
      return bSeason-aSeason||(Number(b.week)||0)-(Number(a.week)||0);
    }).slice(0,this.recentSamples);
    const stat=target.market==='passing_yards'?(r:NflRow)=>number(r,'passing_yards'):
      target.market==='player_pass_attempts'?(r:NflRow)=>number(r,'attempts'):
        (r:NflRow)=>number(r,'completions');
    const values=series(sorted,stat);
    if(values.length<this.minSamples)return[];
    const midpoint=mean(values),spread=sd(values);
    if(!Number.isFinite(midpoint)||!Number.isFinite(spread)||spread<=0)return[];
    const recent=sorted.slice(0,Math.min(5,sorted.length)),baseline=sorted;
    const expiresAt=new Date(Math.min(Date.parse(target.eventStartTime),now.getTime()+6*3600_000)).toISOString();
    const out:Evidence[]=[];
    const add=(kind:string,value:number,base:number|undefined,finding:string,unit?:string)=>{
      out.push(evidenceSchema.parse({id:'public-nfl:'+hash(JSON.stringify([
        target.eventId,target.playerId,target.market,kind,now.toISOString().slice(0,13)])),
        entityType:'PLAYER',entityId:target.playerId,eventId:target.eventId,market:target.market,
        kind,finding,sourceName:'nflverse weekly player stats',
        sourceUrl:`${NFLVERSE_BASE}/stats_player_week_${seasonFor(target.eventStartTime)}.csv`,
        sourceType:'PUBLIC',retrievedAt:now.toISOString(),expiresAt,quality:'HIGH',confidence:.9,
        numeric:{value,...(base===undefined?{}:{baseline:base}),...(unit?{unit}:{})}}));
    };
    add('projection:'+target.market,midpoint,spread,
      `Rolling mean and sample standard deviation from ${values.length} completed nflverse games; PrizePicks threshold not used.`);

    const metric=(kind:string,pick:(row:NflRow)=>number|null)=>{
      const a=series(recent,pick),b=series(baseline,pick);
      if(a.length<3||b.length<this.minSamples)return;
      add('metric:'+kind,mean(a),mean(b),
        `Recent completed-game average versus ${b.length}-game nflverse baseline for ${kind}.`);
    };
    const attempts=(r:NflRow)=>number(r,'attempts');
    const completions=(r:NflRow)=>number(r,'completions');
    const passYds=(r:NflRow)=>number(r,'passing_yards');
    const carries=(r:NflRow)=>number(r,'carries');
    if(target.market==='passing_yards'){
      metric('expected_attempts',attempts);
      metric('efficiency_environment',(r)=>{const a=attempts(r),y=passYds(r);return a&&y!==null?y/a:null;});
      metric('historical_current_form',passYds);
    }else if(target.market==='player_pass_attempts'){
      metric('expected_offensive_plays',(r)=>{const a=attempts(r),c=carries(r);return a!==null? a+(c??0):null;});
      metric('pass_rate',(r)=>{const a=attempts(r),c=carries(r);const total=a!==null?a+(c??0):null;return a!==null&&total? a/total:null;});
      metric('qb_role_security',(r)=>{const a=attempts(r);return a===null?null:a>=15?1:0;});
      metric('historical_volume',attempts);
    }else{
      metric('attempts',attempts);
      metric('completion_rate',(r)=>{const a=attempts(r),c=completions(r);return a&&c!==null?c/a:null;});
      metric('passing_style',(r)=>{const a=attempts(r),y=passYds(r);return a&&y!==null?y/a:null;});
    }
    const recentValues=series(recent,stat),baseValues=series(baseline,stat);
    if(recentValues.length>=3&&baseValues.length>=this.minSamples){
      const rsd=sd(recentValues)/Math.max(Math.abs(mean(recentValues)),1),
        bsd=sd(baseValues)/Math.max(Math.abs(mean(baseValues)),1);
      add('metric:stability',1/(1+rsd),1/(1+bsd),'Inverse coefficient-of-variation stability from completed nflverse games.');
    }
    return out;
  }
}
