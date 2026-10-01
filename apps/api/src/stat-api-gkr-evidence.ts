import { createHash } from 'node:crypto';
import { evidenceSchema } from '@crowniq/contracts';
import type { Evidence } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from '@crowniq/engine';
import type { StatApiOwnerResearch, StatApiPlayer, StatApiSport } from './stat-api-owner-research.js';

type Source = Pick<StatApiOwnerResearch,'search'|'inspect'>;
type Detail = Awaited<ReturnType<Source['inspect']>>;
type Row = Detail['rows'][number];

type Table = 'game_player_stats'|'game_player_batter_stats'|'game_player_pitching_stats';
interface MarketSpec {
  readonly table: Table;
  readonly value: (row: Row) => number | null;
  readonly unit: string;
  readonly factors: Readonly<Record<string,(row: Row) => number | null>>;
}

const n=(row:Row,key:string)=>Number.isFinite(row.metrics[key])?row.metrics[key]:null;
const ratio=(a:number|null,b:number|null)=>a!==null&&b!==null&&b!==0?a/b:null;
const sum=(...values:(number|null)[])=>values.every((v)=>v!==null)
  ? values.reduce((total,value)=>total+(value??0),0):null;

const specs:Readonly<Record<StatApiSport,Readonly<Record<string,MarketSpec>>>>={
  NFL:{
    passing_yards:{table:'game_player_stats',value:(r)=>n(r,'passing_yds'),unit:'yards',
      factors:{
        expected_attempts:(r)=>n(r,'pass_attempts'),
        efficiency_environment:(r)=>ratio(n(r,'passing_yds'),n(r,'pass_attempts')),
        historical_current_form:(r)=>n(r,'passing_yds'),
      }},
    player_pass_attempts:{table:'game_player_stats',value:(r)=>n(r,'pass_attempts'),unit:'attempts',
      factors:{
        expected_offensive_plays:(r)=>sum(n(r,'pass_attempts'),n(r,'rushing_attempts')),
        pass_rate:(r)=>ratio(n(r,'pass_attempts'),sum(n(r,'pass_attempts'),n(r,'rushing_attempts'))),
        qb_role_security:(r)=>ratio(n(r,'pass_attempts'),n(r,'offensive_snaps')),
        historical_volume:(r)=>n(r,'pass_attempts'),
      }},
    player_pass_completions:{table:'game_player_stats',value:(r)=>n(r,'completions'),unit:'completions',
      factors:{
        attempts:(r)=>n(r,'pass_attempts'),
        completion_rate:(r)=>ratio(n(r,'completions'),n(r,'pass_attempts')),
        passing_style:(r)=>ratio(n(r,'passing_yds'),n(r,'pass_attempts')),
      }},
    player_rush_yds:{table:'game_player_stats',value:(r)=>n(r,'rushing_yds'),unit:'yards',
      factors:{
        expected_carries:(r)=>n(r,'rushing_attempts'),
        rush_attempt_rate:(r)=>ratio(n(r,'rushing_attempts'),n(r,'offensive_snaps')),
        rb_efficiency_skill:(r)=>ratio(n(r,'rushing_yds'),n(r,'rushing_attempts')),
        historical_rush_volume:(r)=>n(r,'rushing_yds'),
      }},
    player_rush_attempts:{table:'game_player_stats',value:(r)=>n(r,'rushing_attempts'),unit:'attempts',
      factors:{
        rush_attempt_rate:(r)=>ratio(n(r,'rushing_attempts'),n(r,'offensive_snaps')),
        historical_volume:(r)=>n(r,'rushing_attempts'),
        offensive_snap_volume:(r)=>n(r,'offensive_snaps'),
      }},
    player_reception_yds:{table:'game_player_stats',value:(r)=>n(r,'receiving_yds'),unit:'yards',
      factors:{
        target_opportunity_rate:(r)=>ratio(n(r,'targets'),n(r,'offensive_snaps')),
        receiving_efficiency:(r)=>ratio(n(r,'receiving_yds'),n(r,'targets')),
        offensive_snap_volume:(r)=>n(r,'offensive_snaps'),
        historical_receiving_volume:(r)=>n(r,'receiving_yds'),
      }},
    player_receptions:{table:'game_player_stats',value:(r)=>n(r,'receptions'),unit:'receptions',
      factors:{
        target_floor:(r)=>n(r,'targets'),
        catch_rate:(r)=>ratio(n(r,'receptions'),n(r,'targets')),
        offensive_snap_volume:(r)=>n(r,'offensive_snaps'),
        historical_reception_volume:(r)=>n(r,'receptions'),
      }},
    player_receiving_targets:{table:'game_player_stats',value:(r)=>n(r,'targets'),unit:'targets',
      factors:{
        target_opportunity_rate:(r)=>ratio(n(r,'targets'),n(r,'offensive_snaps')),
        offensive_snap_volume:(r)=>n(r,'offensive_snaps'),
        historical_target_volume:(r)=>n(r,'targets'),
      }},
  },
  NBA:{
    player_points:{table:'game_player_stats',value:(r)=>n(r,'pts'),unit:'points',
      factors:{expected_minutes:(r)=>n(r,'minutes'),shot_volume:(r)=>n(r,'field_goals_attempted'),
        usage_proxy:(r)=>ratio(sum(n(r,'field_goals_attempted'),n(r,'turnovers')),n(r,'minutes')),
        scoring_rate:(r)=>ratio(n(r,'pts'),n(r,'minutes'))}},
    player_rebounds:{table:'game_player_stats',value:(r)=>n(r,'rebounds'),unit:'rebounds',
      factors:{minutes:(r)=>n(r,'minutes'),rebound_rate:(r)=>ratio(n(r,'rebounds'),n(r,'minutes')),
        historical_rebound_volume:(r)=>n(r,'rebounds')}},
    player_assists:{table:'game_player_stats',value:(r)=>n(r,'assists'),unit:'assists',
      factors:{minutes:(r)=>n(r,'minutes'),potential_assists:(r)=>n(r,'potential_assists'),
        ball_handling_rate:(r)=>ratio(sum(n(r,'assists'),n(r,'turnovers')),n(r,'minutes')),
        historical_assist_volume:(r)=>n(r,'assists')}},
    player_points_rebounds_assists:{table:'game_player_stats',
      value:(r)=>sum(n(r,'pts'),n(r,'rebounds'),n(r,'assists')),unit:'PRA',
      factors:{minutes:(r)=>n(r,'minutes'),scoring_opportunity:(r)=>n(r,'pts'),
        rebounding_opportunity:(r)=>n(r,'rebounds'),assist_opportunity:(r)=>n(r,'assists')}},
    player_points_rebounds:{table:'game_player_stats',
      value:(r)=>sum(n(r,'pts'),n(r,'rebounds')),unit:'points+rebounds',
      factors:{points_opportunity:(r)=>n(r,'pts'),rebounding_opportunity:(r)=>n(r,'rebounds'),
        minutes:(r)=>n(r,'minutes')}},
    player_points_assists:{table:'game_player_stats',
      value:(r)=>sum(n(r,'pts'),n(r,'assists')),unit:'points+assists',
      factors:{points_opportunity:(r)=>n(r,'pts'),assist_opportunity:(r)=>n(r,'assists'),
        minutes:(r)=>n(r,'minutes')}},
    player_rebounds_assists:{table:'game_player_stats',
      value:(r)=>sum(n(r,'rebounds'),n(r,'assists')),unit:'rebounds+assists',
      factors:{rebounding_opportunity:(r)=>n(r,'rebounds'),assist_opportunity:(r)=>n(r,'assists'),
        minutes:(r)=>n(r,'minutes')}},
  },
  MLB:{
    batter_hits_runs_rbis:{table:'game_player_batter_stats',
      value:(r)=>sum(n(r,'hits'),n(r,'runs'),n(r,'runs_batted_in')),unit:'H+R+RBI',
      factors:{expected_pa:(r)=>n(r,'plate_appearances'),
        contact_obp_skill:(r)=>ratio(sum(n(r,'hits'),n(r,'walks')),n(r,'plate_appearances')),
        home_run_rate:(r)=>ratio(n(r,'home_runs'),n(r,'plate_appearances')),
        historical_hrrbi_volume:(r)=>sum(n(r,'hits'),n(r,'runs'),n(r,'runs_batted_in')),
        run_creation_rate:(r)=>ratio(sum(n(r,'hits'),n(r,'runs'),n(r,'runs_batted_in')),
          n(r,'plate_appearances'))}},
    batter_hits:{table:'game_player_batter_stats',value:(r)=>n(r,'hits'),unit:'hits',
      factors:{expected_pa:(r)=>n(r,'plate_appearances'),
        contact_ability:(r)=>ratio(n(r,'hits'),n(r,'at_bats')),
        historical_hit_volume:(r)=>n(r,'hits'),
        hit_rate:(r)=>ratio(n(r,'hits'),n(r,'plate_appearances'))}},
    batter_walks:{table:'game_player_batter_stats',value:(r)=>n(r,'walks'),unit:'walks',
      factors:{hitter_walk_rate:(r)=>ratio(n(r,'walks'),n(r,'plate_appearances')),
        expected_pa:(r)=>n(r,'plate_appearances'),historical_walk_volume:(r)=>n(r,'walks')}},
    batter_home_runs:{table:'game_player_batter_stats',value:(r)=>n(r,'home_runs'),unit:'home runs',
      factors:{extra_base_power_rate:(r)=>ratio(sum(n(r,'doubles'),n(r,'triples'),n(r,'home_runs')),
          n(r,'plate_appearances')),
        expected_pa:(r)=>n(r,'plate_appearances'),historical_hr_volume:(r)=>n(r,'home_runs'),
        hr_frequency:(r)=>ratio(n(r,'home_runs'),n(r,'plate_appearances'))}},
    pitcher_strikeouts:{table:'game_player_pitching_stats',value:(r)=>n(r,'strikeouts_pitched'),
      unit:'strikeouts',factors:{expected_batters_faced:(r)=>n(r,'batters_faced'),
        pitch_count_innings:(r)=>n(r,'innings_pitched'),
        pitcher_k_rate:(r)=>ratio(n(r,'strikeouts_pitched'),n(r,'batters_faced'))}},
  },
  PGA:{},
};

export function statHistoryFactorsFor(sport:string,market:string):readonly string[]{
  const spec=specs[sport as StatApiSport]?.[market];
  return spec?[...Object.keys(spec.factors),'stability']:[];
}

const normalizeName=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()
  .replace(/\s+(jr|sr|ii|iii|iv)$/,'');

const mean=(values:readonly number[])=>values.reduce((a,b)=>a+b,0)/values.length;
const sd=(values:readonly number[])=>{
  if(values.length<2)return 0;
  const m=mean(values);
  return Math.sqrt(values.reduce((sum,value)=>sum+(value-m)**2,0)/(values.length-1));
};
const validSeries=(rows:readonly Row[],pick:(row:Row)=>number|null)=>
  rows.map(pick).filter((value):value is number=>value!==null&&Number.isFinite(value));
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);

export interface StatApiGkrEvidenceOptions {
  readonly maxPlayers?:number;
  readonly minSamples?:number;
  readonly recentSamples?:number;
  readonly concurrency?:number;
  readonly allowedKeys?:readonly string[];
  readonly onDetail?:(input:{sport:StatApiSport;target:ResearchTarget;player:StatApiPlayer;
    detail:Detail})=>Promise<void>;
  readonly skipTarget?:(target:ResearchTarget)=>Promise<boolean>;
  readonly clock?:()=>Date;
}

/**
 * Deterministic historical evidence builder. It never uses the PrizePicks threshold
 * to create a projection and never fabricates lineup, injury, weather or role status.
 */
export class StatApiGkrEvidence implements ResearchAdapter {
  readonly id='stat-api-gkr-history-v1';
  private health:ResearchHealth={status:'OK',targets:0,searches:0,cacheHits:0,skipped:0,
    failures:0,noSources:0,lastRunAt:null};
  private readonly maxPlayers:number;
  private readonly minSamples:number;
  private readonly recentSamples:number;
  private readonly concurrency:number;
  private readonly allowedKeys:Set<string>|null;
  private readonly onDetail:StatApiGkrEvidenceOptions['onDetail'];
  private readonly skipTarget:StatApiGkrEvidenceOptions['skipTarget'];
  private readonly clock:()=>Date;

  constructor(private readonly source:Source,options:StatApiGkrEvidenceOptions={}){
    this.maxPlayers=options.maxPlayers??1500;
    this.minSamples=options.minSamples??5;
    this.recentSamples=options.recentSamples??10;
    this.concurrency=options.concurrency??6;
    this.allowedKeys=options.allowedKeys?.length?new Set(options.allowedKeys):null;
    this.onDetail=options.onDetail;
    this.skipTarget=options.skipTarget;
    this.clock=options.clock??(()=>new Date());
    if(!Number.isInteger(this.maxPlayers)||this.maxPlayers<1||this.maxPlayers>5000||
      !Number.isInteger(this.minSamples)||this.minSamples<3||this.minSamples>40||
      !Number.isInteger(this.recentSamples)||this.recentSamples<this.minSamples||this.recentSamples>40||
      !Number.isInteger(this.concurrency)||this.concurrency<1||this.concurrency>12)
      throw new Error('INVALID_GKR_STAT_EVIDENCE_CONFIGURATION');
  }

  getHealth():ResearchHealth{return this.health;}

  supports(target:ResearchTarget):boolean{
    const key=`${target.sport}:${target.market.trim().toLowerCase()}`;
    return ['NFL','NBA','MLB'].includes(target.sport) &&
      !!specs[target.sport as StatApiSport]?.[target.market] &&
      (!this.allowedKeys||this.allowedKeys.has(key));
  }

  async research(targets:readonly ResearchTarget[]):Promise<readonly Evidence[]>{
    const now=this.clock();
    const baseEligible=targets.filter((target)=>
      this.supports(target)&&Date.parse(target.eventStartTime)>now.getTime());
    let persistentHits=0;
    const eligible:ResearchTarget[]=[];
    for(const target of baseEligible){
      if(this.skipTarget && await this.skipTarget(target)){persistentHits++;continue;}
      eligible.push(target);
    }
    const grouped=new Map<string,ResearchTarget[]>();
    for(const target of eligible){
      const key=[target.sport,normalizeName(target.playerName)].join('|');
      grouped.set(key,[...(grouped.get(key)??[]),target]);
    }
    const selected=[...grouped.values()].slice(0,this.maxPlayers);
    let cursor=0,searches=0,skipped=Math.max(0,grouped.size-selected.length),failures=0,noSources=0;
    let identityMisses=0,sampleMisses=0,producedTargets=0;
    const evidence:Evidence[]=[];
    const workers=Array.from({length:Math.min(this.concurrency,selected.length)},async()=>{
      while(true){
        const index=cursor++; if(index>=selected.length)return;
        const playerTargets=selected[index];
        const first=playerTargets[0];
        const sport=first.sport as StatApiSport;
        try{
          searches++;
          const result=await this.source.search(sport,first.playerName);
          const wanted=normalizeName(first.playerName);
          const exact=result.players.filter((player:StatApiPlayer)=>normalizeName(player.name)===wanted);
          if(exact.length!==1){skipped++;noSources++;identityMisses++;continue;}
          const player=exact[0];
          const tables=[...new Set(playerTargets.map((target)=>specs[sport][target.market].table))];
          const details=new Map<Table,Detail>();
          for(const table of tables){
            searches++;
            const detail=await this.source.inspect(sport,player.id,table);
            details.set(table,detail);
            if(this.onDetail)await this.onDetail({sport,target:first,player,detail}).catch(()=>undefined);
          }
          for(const target of playerTargets){
            const spec=specs[sport][target.market],detail=details.get(spec.table)!;
            const findings=this.forTarget(target,spec,detail,now);
            if(findings.length)producedTargets++;else sampleMisses++;
            evidence.push(...findings);
          }
        }catch{failures++;}
      }
    });
    await Promise.all(workers);
    const status=failures?evidence.length?'PARTIAL':'FAILED':'OK';
    const sources:NonNullable<ResearchHealth['sources']>={
      CACHE_MODEL_READY:{status:'SKIPPED',targets:persistentHits,evidence:0,failures:0,
        errorCode:persistentHits?'MODEL_READY_CACHE':null},
      PROVIDER_IDENTITY:{status:identityMisses?'PARTIAL':'OK',targets:selected.length,
        evidence:selected.length-identityMisses,failures:0,
        errorCode:identityMisses?'IDENTITY_UNRESOLVED':null},
      PROVIDER_HISTORY:{status:failures?evidence.length?'PARTIAL':'FAILED':
          sampleMisses?'PARTIAL':'OK',
        targets:eligible.length,evidence:evidence.length,failures,
        errorCode:failures?'PROVIDER_LOOKUP_FAILED':
          sampleMisses?'INSUFFICIENT_HISTORY_OR_FIELDS':null},
    };
    this.health={status,targets:targets.length,searches,cacheHits:persistentHits,skipped,failures,noSources,
      lastRunAt:now.toISOString(),sources};
    return evidence;
  }

  private forTarget(target:ResearchTarget,spec:MarketSpec,detail:Detail,now:Date):Evidence[]{
    const before=detail.rows.filter((row)=>!row.occurredAt||
      Date.parse(row.occurredAt)<Date.parse(target.eventStartTime));
    const dated=before.filter((row)=>row.occurredAt)
      .sort((a,b)=>Date.parse(b.occurredAt!)-Date.parse(a.occurredAt!));
    const sample=(dated.length>=this.minSamples?dated:before).slice(0,this.recentSamples);
    const values=validSeries(sample,spec.value);
    if(values.length<this.minSamples)return[];
    const midpoint=mean(values),spread=sd(values);
    if(!Number.isFinite(midpoint)||!Number.isFinite(spread)||spread<=0)return[];
    const expiresAt=new Date(Math.min(Date.parse(target.eventStartTime),now.getTime()+6*3600_000))
      .toISOString();
    if(Date.parse(expiresAt)<=now.getTime())return[];
    const result:Evidence[]=[];
    const add=(kind:string,finding:string,value:number,baseline:number|undefined,unit?:string)=>{
      result.push(evidenceSchema.parse({id:'stat:'+hash(JSON.stringify([target.eventId,target.playerId,
        target.market,kind,detail.retrievedAt])),entityType:'PLAYER',entityId:target.playerId,
        eventId:target.eventId,market:target.market,kind,finding,sourceName:'stat-api.com',
        sourceUrl:detail.sourceUrl,sourceType:'LICENSED_FEED',retrievedAt:detail.retrievedAt,
        expiresAt,quality:values.length>=10?'HIGH':'MEDIUM',
        confidence:Math.min(.95,.6+values.length*.025),
        numeric:{value,...(baseline===undefined?{}:{baseline}),...(unit?{unit}:{})}}));
    };
    add('projection:'+target.market,
      `Historical rolling projection from ${values.length} attributed stat-api game rows; no PrizePicks threshold used.`,
      midpoint,spread,spec.unit);

    if(dated.length>=this.minSamples){
      const recent=dated.slice(0,Math.min(5,this.recentSamples));
      const baseline=dated.slice(0,this.recentSamples);
      for(const [factor,pick] of Object.entries(spec.factors)){
        const recentValues=validSeries(recent,pick),baseValues=validSeries(baseline,pick);
        if(recentValues.length<Math.min(3,this.minSamples)||baseValues.length<this.minSamples)continue;
        add('metric:'+factor,
          `Recent attributed stat-api average versus the larger rolling historical sample for ${factor}.`,
          mean(recentValues),mean(baseValues));
      }
      const recentTarget=validSeries(recent,spec.value),baseTarget=validSeries(baseline,spec.value);
      if(recentTarget.length>=3&&baseTarget.length>=this.minSamples){
        const recentCv=sd(recentTarget)/Math.max(Math.abs(mean(recentTarget)),1);
        const baseCv=sd(baseTarget)/Math.max(Math.abs(mean(baseTarget)),1);
        add('metric:stability','Inverse coefficient-of-variation stability from attributed game rows.',
          1/(1+recentCv),1/(1+baseCv));
      }
    }
    if(target.sport==='MLB'&&target.market==='batter_walks'){
      const walks=sample.map((row)=>n(row,'walks')).filter((v):v is number=>v!==null);
      if(walks.length>=this.minSamples)add('metric:walk_probability',
        'Empirical probability of at least one walk in the attributed rolling sample.',
        walks.filter((value)=>value>=1).length/walks.length,undefined,'probability');
    }
    return result;
  }
}
