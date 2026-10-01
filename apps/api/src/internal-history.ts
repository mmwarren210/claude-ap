import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Evidence } from '@crowniq/contracts';
import { marketDefinitions } from '@crowniq/engine';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from '@crowniq/engine';
import type { TrackedDecision } from './product-ledger.js';
import type { StatApiOwnerResearch, StatApiPlayer, StatApiSport } from './stat-api-owner-research.js';

export type InternalHistorySport='NFL'|'NBA'|'MLB';
export type InternalHistorySourceKind='SEED_BACKFILL'|'RESEARCH_ARCHIVE'|'LIVE_GRADED';

export interface InternalHistoryRow {
  id:string;sport:InternalHistorySport;playerId:string;playerName:string;
  sourcePlayerId:string|null;eventId:string;occurredAt:string;
  metrics:Record<string,number>;marketValues:Record<string,number>;
  sourceKind:InternalHistorySourceKind;sourceName:string;sourceUrl:string;
  sourceType:'LICENSED_FEED'|'PUBLIC'|'OFFICIAL';importedAt:string;
  modelVersion:string|null;line:number|null;direction:'MORE'|'LESS'|null;
  lineScore:number|null;dataConfidence:number|null;
}
interface HistoryData {version:1;rows:InternalHistoryRow[]}
const blank=():HistoryData=>({version:1,rows:[]});
const norm=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()
  .replace(/\s+(jr|sr|ii|iii|iv)$/,'');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,32);
const mean=(values:readonly number[])=>values.reduce((a,b)=>a+b,0)/values.length;
const sd=(values:readonly number[])=>{
  if(values.length<2)return 0;const m=mean(values);
  return Math.sqrt(values.reduce((sum,v)=>sum+(v-m)**2,0)/(values.length-1));
};
const n=(row:InternalHistoryRow,key:string)=>Number.isFinite(row.metrics[key])?row.metrics[key]:null;
const ratio=(a:number|null,b:number|null)=>a!==null&&b!==null&&b!==0?a/b:null;
const sum=(...values:(number|null)[])=>values.every((v)=>v!==null)
  ? values.reduce((total,v)=>total+(v??0),0):null;

interface MarketSpec {
  table:'game_player_stats'|'game_player_batter_stats'|'game_player_pitching_stats';
  value:(row:InternalHistoryRow)=>number|null;unit:string;
  factors:Readonly<Record<string,(row:InternalHistoryRow)=>number|null>>;
}
export const internalHistorySpecs:Readonly<Record<InternalHistorySport,Readonly<Record<string,MarketSpec>>>>={
  NFL:{
    passing_yards:{table:'game_player_stats',value:(r)=>r.marketValues.passing_yards??n(r,'passing_yds'),
      unit:'yards',factors:{expected_attempts:(r)=>n(r,'pass_attempts'),
        efficiency_environment:(r)=>ratio(n(r,'passing_yds'),n(r,'pass_attempts')),
        historical_current_form:(r)=>n(r,'passing_yds')}},
    player_pass_attempts:{table:'game_player_stats',
      value:(r)=>r.marketValues.player_pass_attempts??n(r,'pass_attempts'),unit:'attempts',
      factors:{expected_offensive_plays:(r)=>sum(n(r,'pass_attempts'),n(r,'rushing_attempts')),
        pass_rate:(r)=>ratio(n(r,'pass_attempts'),sum(n(r,'pass_attempts'),n(r,'rushing_attempts'))),
        qb_role_security:(r)=>ratio(n(r,'pass_attempts'),n(r,'offensive_snaps')),
        historical_volume:(r)=>n(r,'pass_attempts')}},
    player_pass_completions:{table:'game_player_stats',
      value:(r)=>r.marketValues.player_pass_completions??n(r,'completions'),unit:'completions',
      factors:{attempts:(r)=>n(r,'pass_attempts'),
        completion_rate:(r)=>ratio(n(r,'completions'),n(r,'pass_attempts')),
        passing_style:(r)=>ratio(n(r,'passing_yds'),n(r,'pass_attempts'))}},
    player_rush_yds:{table:'game_player_stats',
      value:(r)=>r.marketValues.player_rush_yds??n(r,'rushing_yds'),unit:'yards',
      factors:{expected_carries:(r)=>n(r,'rushing_attempts'),
        rush_attempt_rate:(r)=>ratio(n(r,'rushing_attempts'),n(r,'offensive_snaps')),
        rb_efficiency_skill:(r)=>ratio(n(r,'rushing_yds'),n(r,'rushing_attempts')),
        historical_rush_volume:(r)=>n(r,'rushing_yds')}},
    player_rush_attempts:{table:'game_player_stats',
      value:(r)=>r.marketValues.player_rush_attempts??n(r,'rushing_attempts'),unit:'attempts',
      factors:{rush_attempt_rate:(r)=>ratio(n(r,'rushing_attempts'),n(r,'offensive_snaps')),
        historical_volume:(r)=>n(r,'rushing_attempts'),offensive_snap_volume:(r)=>n(r,'offensive_snaps')}},
    player_reception_yds:{table:'game_player_stats',
      value:(r)=>r.marketValues.player_reception_yds??n(r,'receiving_yds'),unit:'yards',
      factors:{target_opportunity_rate:(r)=>ratio(n(r,'targets'),n(r,'offensive_snaps')),
        receiving_efficiency:(r)=>ratio(n(r,'receiving_yds'),n(r,'targets')),
        offensive_snap_volume:(r)=>n(r,'offensive_snaps'),
        historical_receiving_volume:(r)=>n(r,'receiving_yds')}},
    player_receptions:{table:'game_player_stats',
      value:(r)=>r.marketValues.player_receptions??n(r,'receptions'),unit:'receptions',
      factors:{target_floor:(r)=>n(r,'targets'),catch_rate:(r)=>ratio(n(r,'receptions'),n(r,'targets')),
        offensive_snap_volume:(r)=>n(r,'offensive_snaps'),
        historical_reception_volume:(r)=>n(r,'receptions')}},
    player_receiving_targets:{table:'game_player_stats',
      value:(r)=>r.marketValues.player_receiving_targets??n(r,'targets'),unit:'targets',
      factors:{target_opportunity_rate:(r)=>ratio(n(r,'targets'),n(r,'offensive_snaps')),
        offensive_snap_volume:(r)=>n(r,'offensive_snaps'),historical_target_volume:(r)=>n(r,'targets')}},
  },
  NBA:{
    player_points:{table:'game_player_stats',value:(r)=>r.marketValues.player_points??n(r,'pts'),
      unit:'points',factors:{expected_minutes:(r)=>n(r,'minutes'),shot_volume:(r)=>n(r,'field_goals_attempted'),
        usage_proxy:(r)=>ratio(sum(n(r,'field_goals_attempted'),n(r,'turnovers')),n(r,'minutes')),
        scoring_rate:(r)=>ratio(n(r,'pts'),n(r,'minutes'))}},
    player_rebounds:{table:'game_player_stats',value:(r)=>r.marketValues.player_rebounds??n(r,'rebounds'),
      unit:'rebounds',factors:{minutes:(r)=>n(r,'minutes'),
        rebound_rate:(r)=>ratio(n(r,'rebounds'),n(r,'minutes')),
        historical_rebound_volume:(r)=>n(r,'rebounds')}},
    player_assists:{table:'game_player_stats',value:(r)=>r.marketValues.player_assists??n(r,'assists'),
      unit:'assists',factors:{minutes:(r)=>n(r,'minutes'),potential_assists:(r)=>n(r,'potential_assists'),
        ball_handling_rate:(r)=>ratio(sum(n(r,'assists'),n(r,'turnovers')),n(r,'minutes')),
        historical_assist_volume:(r)=>n(r,'assists')}},
    player_points_rebounds_assists:{table:'game_player_stats',
      value:(r)=>r.marketValues.player_points_rebounds_assists??sum(n(r,'pts'),n(r,'rebounds'),n(r,'assists')),
      unit:'PRA',factors:{minutes:(r)=>n(r,'minutes'),scoring_opportunity:(r)=>n(r,'pts'),
        rebounding_opportunity:(r)=>n(r,'rebounds'),assist_opportunity:(r)=>n(r,'assists')}},
    player_points_rebounds:{table:'game_player_stats',
      value:(r)=>r.marketValues.player_points_rebounds??sum(n(r,'pts'),n(r,'rebounds')),
      unit:'points+rebounds',factors:{points_opportunity:(r)=>n(r,'pts'),
        rebounding_opportunity:(r)=>n(r,'rebounds'),minutes:(r)=>n(r,'minutes')}},
    player_points_assists:{table:'game_player_stats',
      value:(r)=>r.marketValues.player_points_assists??sum(n(r,'pts'),n(r,'assists')),
      unit:'points+assists',factors:{points_opportunity:(r)=>n(r,'pts'),
        assist_opportunity:(r)=>n(r,'assists'),minutes:(r)=>n(r,'minutes')}},
    player_rebounds_assists:{table:'game_player_stats',
      value:(r)=>r.marketValues.player_rebounds_assists??sum(n(r,'rebounds'),n(r,'assists')),
      unit:'rebounds+assists',factors:{rebounding_opportunity:(r)=>n(r,'rebounds'),
        assist_opportunity:(r)=>n(r,'assists'),minutes:(r)=>n(r,'minutes')}},
  },
  MLB:{
    batter_hits_runs_rbis:{table:'game_player_batter_stats',
      value:(r)=>r.marketValues.batter_hits_runs_rbis??sum(n(r,'hits'),n(r,'runs'),n(r,'runs_batted_in')),
      unit:'H+R+RBI',factors:{expected_pa:(r)=>n(r,'plate_appearances'),
        contact_obp_skill:(r)=>ratio(sum(n(r,'hits'),n(r,'walks')),n(r,'plate_appearances')),
        home_run_rate:(r)=>ratio(n(r,'home_runs'),n(r,'plate_appearances')),
        historical_hrrbi_volume:(r)=>sum(n(r,'hits'),n(r,'runs'),n(r,'runs_batted_in')),
        run_creation_rate:(r)=>ratio(sum(n(r,'hits'),n(r,'runs'),n(r,'runs_batted_in')),
          n(r,'plate_appearances'))}},
    batter_hits:{table:'game_player_batter_stats',
      value:(r)=>r.marketValues.batter_hits??n(r,'hits'),unit:'hits',
      factors:{expected_pa:(r)=>n(r,'plate_appearances'),
        contact_ability:(r)=>ratio(n(r,'hits'),n(r,'at_bats')),
        historical_hit_volume:(r)=>n(r,'hits'),hit_rate:(r)=>ratio(n(r,'hits'),n(r,'plate_appearances'))}},
    batter_walks:{table:'game_player_batter_stats',
      value:(r)=>r.marketValues.batter_walks??n(r,'walks'),unit:'walks',
      factors:{hitter_walk_rate:(r)=>ratio(n(r,'walks'),n(r,'plate_appearances')),
        expected_pa:(r)=>n(r,'plate_appearances'),historical_walk_volume:(r)=>n(r,'walks')}},
    batter_home_runs:{table:'game_player_batter_stats',
      value:(r)=>r.marketValues.batter_home_runs??n(r,'home_runs'),unit:'home runs',
      factors:{extra_base_power_rate:(r)=>ratio(sum(n(r,'doubles'),n(r,'triples'),n(r,'home_runs')),
          n(r,'plate_appearances')),
        expected_pa:(r)=>n(r,'plate_appearances'),historical_hr_volume:(r)=>n(r,'home_runs'),
        hr_frequency:(r)=>ratio(n(r,'home_runs'),n(r,'plate_appearances'))}},
    pitcher_strikeouts:{table:'game_player_pitching_stats',
      value:(r)=>r.marketValues.pitcher_strikeouts??n(r,'strikeouts_pitched'),unit:'strikeouts',
      factors:{expected_batters_faced:(r)=>n(r,'batters_faced'),
        pitch_count_innings:(r)=>n(r,'innings_pitched'),
        pitcher_k_rate:(r)=>ratio(n(r,'strikeouts_pitched'),n(r,'batters_faced'))}},
  },
};

export class InternalHistoryStore {
  private chain:Promise<unknown>=Promise.resolve();
  constructor(private readonly path:string,private readonly clock:()=>Date=()=>new Date()){}
  private exclusive<T>(task:()=>Promise<T>):Promise<T>{
    const result=this.chain.then(task);this.chain=result.catch(()=>undefined);return result;
  }
  private async read():Promise<HistoryData>{
    try{
      const value=JSON.parse(await readFile(this.path,'utf8')) as HistoryData;
      if(value.version!==1||!Array.isArray(value.rows))throw new Error('INVALID_INTERNAL_HISTORY');
      return value;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return blank();throw error;}
  }
  private async write(data:HistoryData){
    await mkdir(dirname(this.path),{recursive:true});
    const tmp=this.path+'.'+randomUUID()+'.tmp';
    try{await writeFile(tmp,JSON.stringify(data),{mode:0o600});await rename(tmp,this.path);}
    finally{await rm(tmp,{force:true});}
  }
  async add(rows:readonly InternalHistoryRow[]):Promise<number>{return this.exclusive(async()=>{
    if(!rows.length)return 0;
    const data=await this.read(),known=new Set(data.rows.map((row)=>row.id));let added=0;
    for(const row of rows)if(!known.has(row.id)){data.rows.push(structuredClone(row));known.add(row.id);added++;}
    if(added)await this.write(data);return added;
  });}
  async rowsFor(target:ResearchTarget,limit=40):Promise<InternalHistoryRow[]>{return this.exclusive(async()=>{
    const before=Date.parse(target.eventStartTime),wanted=norm(target.playerName);
    return (await this.read()).rows.filter((row)=>row.sport===target.sport &&
      (row.playerId===target.playerId||norm(row.playerName)===wanted) &&
      Date.parse(row.occurredAt)<before).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)).slice(0,limit);
  });}
  /** One consistent file read per research run, shared across player-market targets. */
  async rowsForTargets(targets:readonly ResearchTarget[],limit=40):Promise<Map<ResearchTarget,InternalHistoryRow[]>>{
    return this.exclusive(async()=>{
      const rows=(await this.read()).rows.sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt));
      const groups=new Map<string,InternalHistoryRow[]>(),result=new Map<ResearchTarget,InternalHistoryRow[]>();
      for(const target of targets){
        const wanted=norm(target.playerName),before=Date.parse(target.eventStartTime);
        const key=JSON.stringify([target.sport,target.playerId,wanted,target.eventStartTime]);
        let selected=groups.get(key);
        if(!selected){
          selected=rows.filter((row)=>row.sport===target.sport &&
            (row.playerId===target.playerId||norm(row.playerName)===wanted) &&
            Date.parse(row.occurredAt)<before).slice(0,limit);
          groups.set(key,selected);
        }
        result.set(target,selected);
      }
      return result;
    });
  }
  /** Up to 15 most recent pre-`before` values for one player and market, newest first. */
  async gameLog(sport:string,playerId:string,playerName:string|null,market:string,before:Date){
    const spec=internalHistorySpecs[sport as InternalHistorySport]?.[market];
    if(!spec)return null;
    const rows=await this.rowsFor({sport:sport as InternalHistorySport,playerId,playerName:playerName??'',
      eventStartTime:before.toISOString(),eventId:'game-log',eventName:'game-log',league:sport,
      team:null,opponent:null,market},40);
    // One value per game day: a graded result and a stat row for the same game count once.
    const seen=new Set<string>();
    const games=rows.flatMap((row)=>{const value=spec.value(row),date=row.occurredAt.slice(0,10);
      if(value===null||!Number.isFinite(value)||seen.has(date))return [];
      seen.add(date);return [{date,opponent:null,value}];}).slice(0,15);
    return {sport,playerId,playerName:playerName??rows[0]?.playerName??playerId,market,
      source:'CROWNIQ_INTERNAL_HISTORY' as const,unit:spec.unit,games};
  }
  async hasMinimumSamples(target:ResearchTarget,minSamples=5,recentSamples=10):Promise<boolean>{
    const spec=internalHistorySpecs[target.sport as InternalHistorySport]?.[target.market];
    if(!spec)return false;
    const rows=await this.rowsFor(target,recentSamples);
    return validSeries(rows,spec.value).length>=minSamples;
  }
  async hasModelReadyEvidence(target:ResearchTarget,minSamples=5,recentSamples=10,
    minimumCoverage=.6):Promise<boolean>{
    const rows=await this.rowsFor(target,recentSamples);
    return modelCoverageFromRows(target,rows,minSamples,recentSamples)>=minimumCoverage;
  }
  async status(){return this.exclusive(async()=>{
    const rows=(await this.read()).rows,bySport:Record<string,number>={},bySource:Record<string,number>={};
    for(const row of rows){bySport[row.sport]=(bySport[row.sport]??0)+1;
      bySource[row.sourceKind]=(bySource[row.sourceKind]??0)+1;}
    const times=rows.map((row)=>row.occurredAt).sort();
    return {rows:rows.length,bySport,bySource,oldest:times[0]??null,newest:times.at(-1)??null};
  });}
  async recordStatDetail(target:ResearchTarget,player:StatApiPlayer,
    detail:Awaited<ReturnType<StatApiOwnerResearch['inspect']>>):Promise<number>{
    if(!['NFL','NBA','MLB'].includes(target.sport))return 0;
    const sport=target.sport as InternalHistorySport,rows:InternalHistoryRow[]=[];
    for(const row of detail.rows){
      if(!row.occurredAt)continue;
      const eventId=row.gameId?'stat-game:'+row.gameId:
        'stat-date:'+row.occurredAt.slice(0,10)+':'+player.id;
      rows.push({id:'seed:'+hash(JSON.stringify([sport,player.id,eventId,detail.table])),
        sport,playerId:target.playerId,playerName:target.playerName,sourcePlayerId:String(player.id),
        eventId,occurredAt:row.occurredAt,metrics:{...row.metrics},marketValues:{},
        sourceKind:'RESEARCH_ARCHIVE',sourceName:'stat-api.com',sourceUrl:detail.sourceUrl,
        sourceType:'LICENSED_FEED',importedAt:this.clock().toISOString(),modelVersion:null,
        line:null,direction:null,lineScore:null,dataConfidence:null});
    }
    return this.add(rows);
  }
  async recordGradedDecision(decision:TrackedDecision):Promise<void>{
    if(decision.actualResult===null||!['WIN','LOSS','PUSH'].includes(decision.grade)||
      !['NFL','NBA','MLB'].includes(decision.sport))return;
    const row:InternalHistoryRow={
      id:'live:'+hash(JSON.stringify([decision.sport,decision.playerId,decision.eventId,
        decision.market,decision.actualResult])),
      sport:decision.sport as InternalHistorySport,playerId:decision.playerId,
      playerName:decision.playerName,sourcePlayerId:null,eventId:decision.eventId,
      occurredAt:decision.eventStartTime,metrics:{},marketValues:{[decision.market]:decision.actualResult},
      sourceKind:'LIVE_GRADED',sourceName:decision.resultSourceName??'CrownIQ graded result',
      sourceUrl:decision.resultSourceUrl??'https://github.com/mmwarren210/crowniq-ai',
      sourceType:'PUBLIC',importedAt:this.clock().toISOString(),modelVersion:decision.modelVersion,
      line:decision.exactLine,direction:decision.direction,lineScore:decision.lineScore,
      dataConfidence:decision.analysisSnapshot.dataConfidence??null,
    };
    await this.add([row]);
  }
}

function validSeries(rows:readonly InternalHistoryRow[],pick:(row:InternalHistoryRow)=>number|null){
  return rows.map(pick).filter((v):v is number=>v!==null&&Number.isFinite(v));
}

function modelCoverageFromRows(target:ResearchTarget,rows:readonly InternalHistoryRow[],
  minSamples:number,recentSamples:number):number{
  const spec=internalHistorySpecs[target.sport as InternalHistorySport]?.[target.market];
  const definition=marketDefinitions.find((item)=>item.sport===target.sport&&item.market===target.market);
  if(!spec||!definition)return 0;
  const baseline=rows.slice(0,recentSamples),recent=baseline.slice(0,Math.min(5,recentSamples));
  const values=validSeries(baseline,spec.value);
  if(values.length<minSamples||sd(values)<=0)return 0;
  const available=new Set<string>();
  for(const [factor,pick] of Object.entries(spec.factors)){
    const recentValues=validSeries(recent,pick),baseValues=validSeries(baseline,pick);
    if(recentValues.length>=Math.min(3,minSamples)&&baseValues.length>=minSamples)available.add(factor);
  }
  const recentTarget=validSeries(recent,spec.value),baseTarget=validSeries(baseline,spec.value);
  if(recentTarget.length>=Math.min(3,minSamples)&&baseTarget.length>=minSamples)available.add('stability');
  const factors=definition.factors.filter(([key])=>key!=='evidence_quality');
  const total=factors.reduce((sum,[,weight])=>sum+weight,0);
  if(!total)return 1;
  const covered=factors.reduce((sum,[key,weight])=>sum+(available.has(key)?weight:0),0);
  return covered/total;
}
export class InternalHistoryResearch implements ResearchAdapter {
  readonly id='crowniq-internal-history-v1';
  private health:ResearchHealth={status:'OK',targets:0,searches:0,cacheHits:0,skipped:0,
    failures:0,noSources:0,lastRunAt:null};
  constructor(private readonly store:InternalHistoryStore,private readonly minSamples=5,
    private readonly recentSamples=10,private readonly clock:()=>Date=()=>new Date()){}
  getHealth(){return this.health;}
  async research(targets:readonly ResearchTarget[]):Promise<readonly Evidence[]>{
    const now=this.clock(),evidence:Evidence[]=[];let searches=0,skipped=0,noSources=0,failures=0;
    const eligible=targets.filter((target)=>
      !!internalHistorySpecs[target.sport as InternalHistorySport]?.[target.market] &&
      Date.parse(target.eventStartTime)>now.getTime());
    const rowsByTarget=eligible.length?await this.store.rowsForTargets(eligible,this.recentSamples):new Map();
    for(const target of targets){
      const spec=internalHistorySpecs[target.sport as InternalHistorySport]?.[target.market];
      if(!spec||Date.parse(target.eventStartTime)<=now.getTime()){skipped++;continue;}
      try{
        searches++;const rows=rowsByTarget.get(target)??[];
        const values=validSeries(rows,spec.value);
        if(values.length<this.minSamples){noSources++;continue;}
        const midpoint=mean(values),spread=sd(values);
        if(!Number.isFinite(midpoint)||spread<=0){noSources++;continue;}
        const latest=rows[0],expiresAt=new Date(Math.min(Date.parse(target.eventStartTime),
          now.getTime()+6*3600_000)).toISOString();
        const base={entityType:'PLAYER' as const,entityId:target.playerId,eventId:target.eventId,
          market:target.market,sourceName:'CrownIQ Internal History / '+latest.sourceName,
          sourceUrl:latest.sourceUrl,sourceType:latest.sourceType,retrievedAt:now.toISOString(),expiresAt,
          quality:(values.length>=10?'HIGH':'MEDIUM') as 'HIGH'|'MEDIUM',
          confidence:Math.min(.97,.65+values.length*.025)};
        const add=(kind:string,finding:string,value:number,baseline?:number,unit?:string)=>{
          evidence.push({id:'internal:'+hash(JSON.stringify([target.eventId,target.playerId,target.market,
            kind,now.toISOString()])),...base,kind,finding,numeric:{value,
              ...(baseline===undefined?{}:{baseline}),...(unit?{unit}:{})}});
        };
        add('projection:'+target.market,
          'CrownIQ internal rolling history from '+values.length+' pre-event observations.',
          midpoint,spread,spec.unit);
        const recent=rows.slice(0,Math.min(5,this.recentSamples)),baseline=rows.slice(0,this.recentSamples);
        for(const [factor,pick] of Object.entries(spec.factors)){
          const a=validSeries(recent,pick),b=validSeries(baseline,pick);
          if(a.length<3||b.length<this.minSamples)continue;
          add('metric:'+factor,'CrownIQ internal recent average versus longer rolling history.',mean(a),mean(b));
        }
        const a=validSeries(recent,spec.value),b=validSeries(baseline,spec.value);
        if(a.length>=3&&b.length>=this.minSamples){
          const acv=sd(a)/Math.max(Math.abs(mean(a)),1),bcv=sd(b)/Math.max(Math.abs(mean(b)),1);
          add('metric:stability','CrownIQ internal inverse coefficient-of-variation stability.',
            1/(1+acv),1/(1+bcv));
        }
        if(target.sport==='MLB'&&target.market==='batter_walks'){
          add('metric:walk_probability','CrownIQ internal empirical probability of at least one walk.',
            values.filter((v)=>v>=1).length/values.length,undefined,'probability');
        }
      }catch{failures++;}
    }
    this.health={status:failures?(evidence.length?'PARTIAL':'FAILED'):'OK',targets:targets.length,
      searches,cacheHits:0,skipped,failures,noSources,lastRunAt:now.toISOString()};
    return evidence;
  }
}

export class HistoryBackfillService {
  private job:{running:boolean;startedAt:string|null;finishedAt:string|null;sports:string[];
    players:number;rowsAdded:number;failures:number;message:string|null}={
      running:false,startedAt:null,finishedAt:null,sports:[],players:0,rowsAdded:0,failures:0,message:null};
  constructor(private readonly source:StatApiOwnerResearch,private readonly store:InternalHistoryStore,
    private readonly clock:()=>Date=()=>new Date()){}
  status(){return structuredClone(this.job);}
  start(targets:readonly ResearchTarget[],sports:readonly InternalHistorySport[],maxPlayersPerSport=25){
    if(this.job.running)return false;
    this.job={running:true,startedAt:this.clock().toISOString(),finishedAt:null,sports:[...sports],
      players:0,rowsAdded:0,failures:0,message:null};
    void this.run(targets,sports,maxPlayersPerSport).catch((error)=>{
      this.job.running=false;this.job.finishedAt=this.clock().toISOString();this.job.message=(error as Error).message;
    });
    return true;
  }
  private async run(targets:readonly ResearchTarget[],sports:readonly InternalHistorySport[],
    maxPlayersPerSport:number){
    try{
      for(const sport of sports){
        const groups=new Map<string,ResearchTarget[]>();
        for(const target of targets.filter((t)=>t.sport===sport&&internalHistorySpecs[sport]?.[t.market])){
          const key=norm(target.playerName);groups.set(key,[...(groups.get(key)??[]),target]);
        }
        const selected=[...groups.values()].sort((a,b)=>b.length-a.length).slice(0,maxPlayersPerSport);
        for(const playerTargets of selected){
          const first=playerTargets[0];
          try{
            const found=await this.source.search(sport as StatApiSport,first.playerName),wanted=norm(first.playerName);
            const exact=found.players.filter((p)=>norm(p.name)===wanted);
            if(exact.length!==1){this.job.failures++;continue;}
            const person=exact[0],tables=[...new Set(playerTargets.map((t)=>internalHistorySpecs[sport][t.market].table))];
            const imported:InternalHistoryRow[]=[];
            for(const table of tables){
              const detail=await this.source.inspect(sport as StatApiSport,person.id,table);
              for(const row of detail.rows){
                if(!row.occurredAt)continue;
                const eventId=row.gameId?'stat-game:'+row.gameId:
                  'stat-date:'+row.occurredAt.slice(0,10)+':'+person.id;
                imported.push({id:'seed:'+hash(JSON.stringify([sport,person.id,eventId,table])),
                  sport,playerId:first.playerId,playerName:first.playerName,sourcePlayerId:String(person.id),
                  eventId,occurredAt:row.occurredAt,metrics:{...row.metrics},marketValues:{},
                  sourceKind:'SEED_BACKFILL',sourceName:'stat-api.com',sourceUrl:detail.sourceUrl,
                  sourceType:'LICENSED_FEED',importedAt:this.clock().toISOString(),modelVersion:null,
                  line:null,direction:null,lineScore:null,dataConfidence:null});
              }
            }
            this.job.rowsAdded+=await this.store.add(imported);this.job.players++;
          }catch{this.job.failures++;}
        }
      }
      this.job.message='COMPLETE';
    }finally{this.job.running=false;this.job.finishedAt=this.clock().toISOString();}
  }
}
