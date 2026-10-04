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

/** Stat-history set 2 (owner approved 2026-10-04): the remaining Stat API stats, read the same way. */
const pa=(r:Row)=>n(r,'plate_appearances');
const per=(key:string)=>(r:Row)=>ratio(n(r,key),pa(r));
const tb=(r:Row)=>n(r,'total_bases');
const batterSpec=(value:(r:Row)=>number|null,unit:string,factors:MarketSpec['factors']):MarketSpec=>
  ({table:'game_player_batter_stats',value,unit,factors:{expected_pa:pa,...factors}});
const bf=(r:Row)=>n(r,'batters_faced');
const pitcherSpec=(value:(r:Row)=>number|null,unit:string,factors:MarketSpec['factors']):MarketSpec=>
  ({table:'game_player_pitching_stats',value,unit,
    factors:{expected_batters_faced:bf,pitch_count_innings:(r)=>n(r,'innings_pitched'),...factors}});
const nfl=(value:(r:Row)=>number|null,unit:string,factors:MarketSpec['factors']):MarketSpec=>
  ({table:'game_player_stats',value,unit,factors});
const touches=(r:Row)=>sum(n(r,'rushing_attempts'),n(r,'targets'));
const scrimmage=(r:Row)=>sum(n(r,'rushing_yds'),n(r,'receiving_yds'));
const tackles=(r:Row)=>sum(n(r,'solo_tackles'),n(r,'assisted_tackles'));
const kicking=(r:Row)=>{const fg=n(r,'field_goals_made'),xp=n(r,'extra_pts_made');
  return fg===null||xp===null?null:fg*3+xp;};
const v2:Readonly<Partial<Record<StatApiSport,Readonly<Record<string,MarketSpec>>>>>={
  MLB:{
    batter_total_bases:batterSpec(tb,'total bases',{power_rate:(r)=>ratio(tb(r),pa(r)),historical_tb_volume:tb,
      contact_ability:(r)=>ratio(n(r,'hits'),n(r,'at_bats'))}),
    singles:batterSpec((r)=>n(r,'singles'),'singles',{single_rate:per('singles'),historical_single_volume:(r)=>n(r,'singles'),
      contact_ability:(r)=>ratio(n(r,'hits'),n(r,'at_bats'))}),
    doubles:batterSpec((r)=>n(r,'doubles'),'doubles',{double_rate:per('doubles'),historical_double_volume:(r)=>n(r,'doubles'),
      power_rate:(r)=>ratio(tb(r),pa(r))}),
    triples:batterSpec((r)=>n(r,'triples'),'triples',{triple_rate:per('triples'),historical_triple_volume:(r)=>n(r,'triples'),
      speed:(r)=>ratio(sum(n(r,'stolen_bases'),n(r,'caught_stealing')),pa(r))}),
    rbis:batterSpec((r)=>n(r,'runs_batted_in'),'RBIs',{rbi_rate:per('runs_batted_in'),
      historical_rbi_volume:(r)=>n(r,'runs_batted_in'),power_rate:(r)=>ratio(tb(r),pa(r))}),
    runs:batterSpec((r)=>n(r,'runs'),'runs',{on_base_rate:(r)=>ratio(sum(n(r,'hits'),n(r,'walks')),pa(r)),
      run_rate:per('runs'),historical_run_volume:(r)=>n(r,'runs')}),
    runs_rbis:batterSpec((r)=>sum(n(r,'runs'),n(r,'runs_batted_in')),'runs+RBIs',{
      run_creation_rate:(r)=>ratio(sum(n(r,'runs'),n(r,'runs_batted_in')),pa(r)),
      historical_volume:(r)=>sum(n(r,'runs'),n(r,'runs_batted_in')),power_rate:(r)=>ratio(tb(r),pa(r))}),
    extra_base_hits:batterSpec((r)=>sum(n(r,'doubles'),n(r,'triples'),n(r,'home_runs')),'extra-base hits',{
      extra_base_rate:(r)=>ratio(sum(n(r,'doubles'),n(r,'triples'),n(r,'home_runs')),pa(r)),
      historical_xbh_volume:(r)=>sum(n(r,'doubles'),n(r,'triples'),n(r,'home_runs')),power_rate:(r)=>ratio(tb(r),pa(r))}),
    sb:batterSpec((r)=>n(r,'stolen_bases'),'stolen bases',{
      steal_attempt_rate:(r)=>ratio(sum(n(r,'stolen_bases'),n(r,'caught_stealing')),pa(r)),
      steal_success_rate:(r)=>ratio(n(r,'stolen_bases'),sum(n(r,'stolen_bases'),n(r,'caught_stealing'))),
      on_base_rate:(r)=>ratio(sum(n(r,'hits'),n(r,'walks')),pa(r)),historical_sb_volume:(r)=>n(r,'stolen_bases')}),
    hitter_ks:batterSpec((r)=>n(r,'strikeouts'),'strikeouts',{hitter_k_rate:per('strikeouts'),
      historical_k_volume:(r)=>n(r,'strikeouts')}),
    plate_appearances:batterSpec(pa,'plate appearances',{on_base_rate:(r)=>ratio(sum(n(r,'hits'),n(r,'walks')),pa(r)),
      historical_pa_volume:pa}),
    hits_allowed:pitcherSpec((r)=>n(r,'hits_allowed'),'hits allowed',{hits_per_batter:(r)=>ratio(n(r,'hits_allowed'),bf(r)),
      historical_hits_allowed:(r)=>n(r,'hits_allowed')}),
    walks_allowed:pitcherSpec((r)=>n(r,'walks_allowed'),'walks allowed',{walk_rate:(r)=>ratio(n(r,'walks_allowed'),bf(r)),
      historical_walks_allowed:(r)=>n(r,'walks_allowed')}),
    pitcher_earned_runs:pitcherSpec((r)=>n(r,'earned_runs'),'earned runs',{runs_per_batter:(r)=>ratio(n(r,'earned_runs'),bf(r)),
      historical_earned_runs:(r)=>n(r,'earned_runs')}),
    pitching_outs:pitcherSpec((r)=>n(r,'outs'),'outs',{historical_outs:(r)=>n(r,'outs'),
      pitch_efficiency:(r)=>ratio(n(r,'outs'),n(r,'pitches_thrown'))}),
    pitches_thrown:pitcherSpec((r)=>n(r,'pitches_thrown'),'pitches',{historical_pitch_volume:(r)=>n(r,'pitches_thrown'),
      pitch_efficiency:(r)=>ratio(n(r,'pitches_thrown'),bf(r))}),
    batters_faced:pitcherSpec(bf,'batters faced',{historical_bf_volume:bf}),
  },
  NFL:{
    player_rush_reception_yds:nfl(scrimmage,'yards',{expected_touches:touches,yards_per_touch:(r)=>ratio(scrimmage(r),touches(r)),
      historical_scrimmage_volume:scrimmage,offensive_snap_volume:(r)=>n(r,'offensive_snaps')}),
    player_pass_rush_yds:nfl((r)=>sum(n(r,'passing_yds'),n(r,'rushing_yds')),'yards',{expected_attempts:(r)=>n(r,'pass_attempts'),
      efficiency_environment:(r)=>ratio(n(r,'passing_yds'),n(r,'pass_attempts')),rushing_role:(r)=>n(r,'rushing_attempts'),
      historical_total_yards:(r)=>sum(n(r,'passing_yds'),n(r,'rushing_yds'))}),
    player_pass_tds:nfl((r)=>n(r,'passing_tds'),'touchdowns',{expected_attempts:(r)=>n(r,'pass_attempts'),
      td_rate:(r)=>ratio(n(r,'passing_tds'),n(r,'pass_attempts')),historical_td_volume:(r)=>n(r,'passing_tds')}),
    player_pass_interceptions:nfl((r)=>n(r,'interceptions_thrown'),'interceptions',{expected_attempts:(r)=>n(r,'pass_attempts'),
      interception_rate:(r)=>ratio(n(r,'interceptions_thrown'),n(r,'pass_attempts')),
      historical_int_volume:(r)=>n(r,'interceptions_thrown')}),
    anytime_tds:nfl((r)=>sum(n(r,'rushing_tds'),n(r,'receiving_tds')),'touchdowns',{expected_touches:touches,
      td_rate:(r)=>ratio(sum(n(r,'rushing_tds'),n(r,'receiving_tds')),touches(r)),
      historical_td_volume:(r)=>sum(n(r,'rushing_tds'),n(r,'receiving_tds'))}),
    rush_tds:nfl((r)=>n(r,'rushing_tds'),'touchdowns',{expected_carries:(r)=>n(r,'rushing_attempts'),
      td_rate:(r)=>ratio(n(r,'rushing_tds'),n(r,'rushing_attempts')),historical_td_volume:(r)=>n(r,'rushing_tds')}),
    player_tackles_assists:nfl(tackles,'tackles',{historical_tackle_volume:tackles,
      solo_tackle_share:(r)=>ratio(n(r,'solo_tackles'),tackles(r))}),
    player_solo_tackles:nfl((r)=>n(r,'solo_tackles'),'solo tackles',{historical_solo_volume:(r)=>n(r,'solo_tackles'),
      solo_tackle_share:(r)=>ratio(n(r,'solo_tackles'),tackles(r))}),
    player_tackle_assists:nfl((r)=>n(r,'assisted_tackles'),'assisted tackles',{
      historical_assist_volume:(r)=>n(r,'assisted_tackles'),assist_share:(r)=>ratio(n(r,'assisted_tackles'),tackles(r))}),
    player_sacks:nfl((r)=>n(r,'defensive_sacks'),'sacks',{historical_sack_volume:(r)=>n(r,'defensive_sacks'),
      pressure_rate:(r)=>n(r,'quarterback_hits')}),
    player_defensive_interceptions:nfl((r)=>n(r,'defensive_interceptions'),'interceptions',{
      historical_int_volume:(r)=>n(r,'defensive_interceptions'),passes_defended_rate:(r)=>n(r,'passes_defended')}),
    player_kicking_points:nfl(kicking,'points',{historical_kicking_points:kicking,
      field_goal_volume:(r)=>n(r,'field_goals_made'),extra_point_volume:(r)=>n(r,'extra_pts_made')}),
    player_field_goals:nfl((r)=>n(r,'field_goals_made'),'field goals',{field_goal_volume:(r)=>n(r,'field_goals_made'),
      historical_fg_attempts:(r)=>n(r,'field_goals_attempted'),
      kicker_accuracy:(r)=>ratio(n(r,'field_goals_made'),n(r,'field_goals_attempted'))}),
    player_extra_points:nfl((r)=>n(r,'extra_pts_made'),'extra points',{extra_point_volume:(r)=>n(r,'extra_pts_made'),
      historical_xp:(r)=>n(r,'extra_pts_made')}),
    player_reception_longest:nfl((r)=>n(r,'receiving_long'),'yards',{historical_longest:(r)=>n(r,'receiving_long'),
      target_volume:(r)=>n(r,'targets'),yards_per_reception:(r)=>ratio(n(r,'receiving_yds'),n(r,'receptions')),
      offensive_snap_volume:(r)=>n(r,'offensive_snaps')}),
    player_rush_longest:nfl((r)=>n(r,'rushing_long'),'yards',{historical_longest:(r)=>n(r,'rushing_long'),
      carry_volume:(r)=>n(r,'rushing_attempts'),yards_per_carry:(r)=>ratio(n(r,'rushing_yds'),n(r,'rushing_attempts'))}),
    player_pass_longest_completion:nfl((r)=>n(r,'passing_long'),'yards',{historical_longest:(r)=>n(r,'passing_long'),
      expected_attempts:(r)=>n(r,'pass_attempts'),air_yards_style:(r)=>ratio(n(r,'passing_air_yds'),n(r,'completions'))}),
    player_punts:nfl((r)=>n(r,'punts'),'punts',{historical_punt_volume:(r)=>n(r,'punts')}),
    player_completion_percentage:nfl((r)=>{const rate=ratio(n(r,'completions'),n(r,'pass_attempts'));
      return rate===null?null:rate*100;},'percent',{completion_rate:(r)=>ratio(n(r,'completions'),n(r,'pass_attempts')),
      attempts:(r)=>n(r,'pass_attempts'),passing_style:(r)=>ratio(n(r,'passing_yds'),n(r,'pass_attempts'))}),
  },
};
/** Other keys the same stats go by on the apps' boards. */
const v2Aliases:Readonly<Record<string,readonly [StatApiSport,string]>>={
  batter_singles:['MLB','singles'],batter_runs_scored:['MLB','runs'],pitcher_hits_allowed:['MLB','hits_allowed'],
  earned_runs_allowed:['MLB','pitcher_earned_runs'],rush_plus_rec_yds:['NFL','player_rush_reception_yds'],
  pass_plus_rush_yds:['NFL','player_pass_rush_yds'],int:['NFL','player_pass_interceptions'],fg_made:['NFL','player_field_goals'],
  longest_rec:['NFL','player_reception_longest'],longest_rush:['NFL','player_rush_longest'],
};
const specFor=(sport:StatApiSport,market:string):MarketSpec|undefined=>{
  const alias=v2Aliases[market];
  return specs[sport][market]??v2[sport]?.[market]??(alias&&alias[0]===sport?v2[sport]?.[alias[1]]:undefined);
};

export function statHistoryFactorsFor(sport:string,market:string):readonly string[]{
  const spec=['NFL','NBA','MLB','PGA'].includes(sport)?specFor(sport as StatApiSport,market):undefined;
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
      !!specFor(target.sport as StatApiSport,target.market) &&
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
    // Two players can share a name (two Max Muncys). Such a name resolves only to the candidate on the line's team,
    // with the team's Stat API id learned from teammates whose names matched exactly one player.
    const teamVotes=new Map<string,Map<number,number>>();
    const teamKey=(target:ResearchTarget)=>target.team?[target.sport,normalizeName(target.team)].join('|'):null;
    const ambiguous:{playerTargets:ResearchTarget[];candidates:StatApiPlayer[]}[]=[];
    const resolve=async(playerTargets:ResearchTarget[],player:StatApiPlayer)=>{
      const first=playerTargets[0],sport=first.sport as StatApiSport;
      const tables=[...new Set(playerTargets.map((target)=>specFor(sport,target.market)!.table))];
      const details=new Map<Table,Detail>();
      for(const table of tables){
        searches++;
        const detail=await this.source.inspect(sport,player.id,table);
        details.set(table,detail);
        if(this.onDetail)await this.onDetail({sport,target:first,player,detail}).catch(()=>undefined);
      }
      for(const target of playerTargets){
        const spec=specFor(sport,target.market)!,detail=details.get(spec.table)!;
        const findings=this.forTarget(target,spec,detail,now);
        if(findings.length)producedTargets++;else sampleMisses++;
        evidence.push(...findings);
      }
    };
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
          if(exact.length>1){ambiguous.push({playerTargets,candidates:exact});continue;}
          if(exact.length!==1){skipped++;noSources++;identityMisses++;continue;}
          const player=exact[0];
          const team=teamKey(first);
          if(team&&player.teamId!==null){
            const votes=teamVotes.get(team)??new Map<number,number>();
            votes.set(player.teamId,(votes.get(player.teamId)??0)+1);teamVotes.set(team,votes);
          }
          await resolve(playerTargets,player);
          continue;
        }catch{failures++;}
      }
    });
    await Promise.all(workers);
    for(const {playerTargets,candidates} of ambiguous){
      const team=teamKey(playerTargets[0]),votes=team?[...teamVotes.get(team)?.entries()??[]]:[];
      // The team id needs a clear majority of at least two teammates.
      votes.sort((a,b)=>b[1]-a[1]);
      const teamId=votes[0]&&votes[0][1]>=2&&(votes[1]?.[1]??0)<votes[0][1]?votes[0][0]:null;
      const onTeam=teamId===null?[]:candidates.filter((player)=>player.teamId===teamId);
      if(onTeam.length!==1){skipped++;noSources++;identityMisses++;continue;}
      try{await resolve(playerTargets,onTeam[0]);}catch{failures++;}
    }
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
