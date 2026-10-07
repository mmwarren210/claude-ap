import type { Sport } from '@crowniq/contracts';

export type WeightedFactor = readonly [key: string, maximum: number];
export interface MarketDefinition {
  readonly sport: Sport;
  readonly market: string;
  readonly version: string;
  readonly factors: readonly WeightedFactor[];
  readonly criticalKinds: readonly string[];
  /** Subset of critical kinds that must be positively confirmed before scoring.
   * Other critical context may still be recommended/diagnostic without blocking a score. */
  readonly hardCriticalKinds?: readonly string[];
  /**
   * When true, score only from observed factor weights and normalize those
   * observed factors back to the 100-point context scale. Missing factors remain
   * zero in the audit trail and are represented separately by data confidence.
   */
  readonly partialCoverageNormalization?: boolean;
  readonly dangerUnits?: number;
  readonly highVariance?: boolean;
  readonly blowoutMode?: 'VOLUME_LOSS' | 'RUSH_GAIN' | 'ROTATION';
  /** Opt-in LESS-aware version: output factors count in favor of LESS when they run below reference. */
  readonly lessAware?: boolean;
}

const defaults: readonly WeightedFactor[] = [
  ['role_opportunity', 25], ['matchup', 20], ['expected_volume_environment', 20],
  ['form_history', 15], ['evidence_quality', 10], ['stability_risk', 10],
];

function define(sport: Sport, market: string, factors: readonly WeightedFactor[],
  options: Partial<Pick<MarketDefinition,
    'version' | 'criticalKinds' | 'hardCriticalKinds' | 'partialCoverageNormalization' |
    'dangerUnits' | 'highVariance' | 'blowoutMode'>> = {}): MarketDefinition {
  if (factors.reduce((sum, [, weight]) => sum + weight, 0) !== 100 ||
    new Set(factors.map(([key]) => key)).size !== factors.length) {
    throw new Error('INVALID_MODEL_WEIGHTS:' + sport + ':' + market);
  }
  return { sport, market, factors, version: `GKR-${sport}-${market.toUpperCase().replace(/_/g, '-')}-1.0`,
    criticalKinds: options.criticalKinds ?? [], ...options };
}

const batter = { criticalKinds: ['status:starting_lineup', 'status:starting_pitcher'],
  hardCriticalKinds: ['status:starting_lineup', 'status:starting_pitcher'], partialCoverageNormalization: true } as const;
const pitcher = { criticalKinds: ['status:starting_pitcher'], hardCriticalKinds: ['status:starting_pitcher'],
  partialCoverageNormalization: true } as const;
const nflPlayer = { criticalKinds: ['status:player_available'], hardCriticalKinds: ['status:player_available'],
  partialCoverageNormalization: true } as const;
const nflQb = { criticalKinds: ['status:qb_available'], hardCriticalKinds: ['status:qb_available'],
  partialCoverageNormalization: true } as const;
const espnPlayer = { criticalKinds: ['status:player_available'], hardCriticalKinds: ['status:player_available'],
  partialCoverageNormalization: true } as const;
/** One model under each market key a stat goes by (e.g. Underdog's "Rush + Rec Yards" and PrizePicks' key). */
const v2 = (sport: Sport, markets: readonly string[], factors: readonly WeightedFactor[],
  options: Partial<Pick<MarketDefinition, 'criticalKinds' | 'hardCriticalKinds' | 'partialCoverageNormalization' |
    'highVariance' | 'blowoutMode'>>, revision = '1.0') => markets.map((market) => define(sport, market, factors,
  { ...options, version: `GKR-${sport}-${market.toUpperCase().replace(/_/g, '-')}-SH2-${revision}` }));

const statHistoryV2: readonly MarketDefinition[] = [
  ...v2('MLB', ['batter_total_bases'], [['expected_pa',20],['power_rate',25],['historical_tb_volume',25],['contact_ability',15],['pitcher_matchup',10],['stability',5]], batter),
  ...v2('MLB', ['singles','batter_singles'], [['expected_pa',20],['single_rate',30],['historical_single_volume',25],['contact_ability',15],['pitcher_matchup',5],['stability',5]], batter),
  ...v2('MLB', ['doubles'], [['expected_pa',20],['double_rate',30],['historical_double_volume',25],['power_rate',15],['pitcher_matchup',5],['stability',5]], { ...batter, highVariance: true }),
  ...v2('MLB', ['triples'], [['expected_pa',20],['triple_rate',35],['historical_triple_volume',25],['speed',10],['pitcher_matchup',5],['stability',5]], { ...batter, highVariance: true }),
  ...v2('MLB', ['rbis'], [['expected_pa',20],['rbi_rate',25],['historical_rbi_volume',25],['power_rate',20],['pitcher_matchup',5],['stability',5]], { ...batter, highVariance: true }),
  ...v2('MLB', ['runs','batter_runs_scored'], [['expected_pa',20],['on_base_rate',25],['run_rate',25],['historical_run_volume',20],['pitcher_matchup',5],['stability',5]], batter),
  ...v2('MLB', ['runs_rbis'], [['expected_pa',20],['run_creation_rate',30],['historical_volume',25],['power_rate',15],['pitcher_matchup',5],['stability',5]], batter),
  ...v2('MLB', ['extra_base_hits'], [['expected_pa',20],['extra_base_rate',30],['historical_xbh_volume',25],['power_rate',15],['pitcher_matchup',5],['stability',5]], { ...batter, highVariance: true }),
  ...v2('MLB', ['sb'], [['expected_pa',15],['steal_attempt_rate',35],['steal_success_rate',15],['on_base_rate',15],['historical_sb_volume',15],['stability',5]], { ...batter, highVariance: true }),
  ...v2('MLB', ['hitter_ks'], [['expected_pa',20],['hitter_k_rate',35],['historical_k_volume',25],['pitcher_matchup',15],['stability',5]], batter),
  ...v2('MLB', ['plate_appearances'], [['expected_pa',45],['on_base_rate',30],['historical_pa_volume',20],['stability',5]], batter),
  ...v2('MLB', ['hits_allowed','pitcher_hits_allowed'], [['expected_batters_faced',25],['hits_per_batter',30],['historical_hits_allowed',25],['pitch_count_innings',10],['opponent_contact',5],['stability',5]], pitcher),
  ...v2('MLB', ['walks_allowed'], [['expected_batters_faced',25],['walk_rate',35],['historical_walks_allowed',25],['pitch_count_innings',10],['stability',5]], pitcher),
  ...v2('MLB', ['pitcher_earned_runs','earned_runs_allowed'], [['expected_batters_faced',20],['runs_per_batter',30],['historical_earned_runs',25],['pitch_count_innings',10],['opponent_offense',10],['stability',5]], { ...pitcher, highVariance: true }),
  ...v2('MLB', ['pitching_outs'], [['pitch_count_innings',35],['historical_outs',30],['expected_batters_faced',20],['pitch_efficiency',10],['stability',5]], pitcher),
  ...v2('MLB', ['pitches_thrown'], [['pitch_count_innings',30],['historical_pitch_volume',35],['expected_batters_faced',20],['pitch_efficiency',10],['stability',5]], pitcher),
  ...v2('MLB', ['batters_faced'], [['expected_batters_faced',45],['historical_bf_volume',30],['pitch_count_innings',20],['stability',5]], pitcher),

  ...v2('NFL', ['player_rush_reception_yds','rush_plus_rec_yds'], [['expected_touches',30],['yards_per_touch',20],['historical_scrimmage_volume',25],['offensive_snap_volume',15],['game_script',5],['stability',5]], { ...nflPlayer, blowoutMode: 'VOLUME_LOSS' }),
  ...v2('NFL', ['player_pass_rush_yds','pass_plus_rush_yds'], [['expected_attempts',25],['efficiency_environment',20],['rushing_role',15],['historical_total_yards',25],['game_script',10],['stability',5]], { ...nflQb, blowoutMode: 'VOLUME_LOSS' }),
  ...v2('NFL', ['player_pass_tds'], [['expected_attempts',25],['td_rate',25],['historical_td_volume',25],['team_scoring_environment',15],['game_script',5],['stability',5]], { ...nflQb, highVariance: true }, '1.1'),
  ...v2('NFL', ['player_pass_interceptions','int'], [['expected_attempts',30],['interception_rate',35],['historical_int_volume',20],['pressure',10],['stability',5]], { ...nflQb, highVariance: true }),
  ...v2('NFL', ['anytime_tds'], [['expected_touches',25],['td_rate',30],['historical_td_volume',25],['team_scoring_environment',15],['stability',5]], { ...nflPlayer, highVariance: true }),
  ...v2('NFL', ['rush_tds'], [['expected_carries',25],['td_rate',30],['historical_td_volume',25],['team_scoring_environment',15],['stability',5]], { ...nflPlayer, highVariance: true }),
  ...v2('NFL', ['player_tackles_assists'], [['historical_tackle_volume',45],['solo_tackle_share',20],['opponent_play_style',15],['position_role',15],['stability',5]], nflPlayer, '1.1'),
  ...v2('NFL', ['player_solo_tackles'], [['historical_solo_volume',45],['solo_tackle_share',20],['opponent_play_style',15],['position_role',15],['stability',5]], nflPlayer),
  ...v2('NFL', ['player_tackle_assists'], [['historical_assist_volume',45],['assist_share',20],['opponent_play_style',15],['position_role',15],['stability',5]], nflPlayer),
  ...v2('NFL', ['player_sacks'], [['historical_sack_volume',40],['pressure_rate',25],['opponent_pressure_rate',15],['game_script',15],['stability',5]], { ...nflPlayer, highVariance: true }, '1.1'),
  ...v2('NFL', ['player_defensive_interceptions'], [['historical_int_volume',45],['passes_defended_rate',30],['opponent_pass_volume',20],['stability',5]], { ...nflPlayer, highVariance: true }),
  ...v2('NFL', ['player_kicking_points'], [['historical_kicking_points',35],['field_goal_volume',25],['extra_point_volume',20],['team_scoring_environment',10],['weather',5],['stability',5]], nflPlayer, '1.1'),
  ...v2('NFL', ['player_field_goals','fg_made'], [['field_goal_volume',40],['historical_fg_attempts',25],['kicker_accuracy',20],['team_scoring_environment',10],['stability',5]], nflPlayer),
  ...v2('NFL', ['player_extra_points'], [['extra_point_volume',45],['team_scoring_environment',30],['historical_xp',20],['stability',5]], nflPlayer),
  ...v2('NFL', ['player_reception_longest','longest_rec'], [['historical_longest',35],['target_volume',25],['yards_per_reception',25],['offensive_snap_volume',10],['stability',5]], { ...nflPlayer, highVariance: true }),
  ...v2('NFL', ['player_rush_longest','longest_rush'], [['historical_longest',35],['carry_volume',30],['yards_per_carry',25],['stability',10]], { ...nflPlayer, highVariance: true }),
  ...v2('NFL', ['player_pass_longest_completion'], [['historical_longest',40],['expected_attempts',30],['air_yards_style',25],['stability',5]], { ...nflQb, highVariance: true }),
  ...v2('NFL', ['player_punts'], [['historical_punt_volume',50],['offensive_efficiency',25],['opponent_defense',20],['stability',5]], nflPlayer, '1.1'),
  // NHL, soccer and college football from ESPN game logs, gated on the roster's active/uninjured status.
  ...v2('NHL', ['shots_on_goal','sog'], [['shot_volume',35],['ice_time',20],['power_play_role',15],['recent_involvement',10],['opponent_shot_suppression',10],['game_environment',5],['stability',5]], espnPlayer, '1.1'),
  ...v2('NHL', ['goals'], [['shot_volume',30],['shooting_rate',25],['ice_time',15],['power_play_role',15],['recent_involvement',5],['opponent_goalie',5],['stability',5]], { ...espnPlayer, highVariance: true }),
  ...v2('NHL', ['assists','player_assists'], [['recent_involvement',30],['ice_time',25],['power_play_role',20],['shot_volume',10],['team_scoring_environment',10],['stability',5]], { ...espnPlayer, highVariance: true }),
  ...v2('NHL', ['points'], [['recent_involvement',30],['ice_time',20],['power_play_role',20],['shot_volume',15],['team_scoring_environment',10],['stability',5]], { ...espnPlayer, highVariance: true }, '1.1'),
  ...v2('NHL', ['plus_minus'], [['recent_involvement',25],['ice_time',25],['team_scoring_environment',25],['shot_volume',15],['stability',10]], { ...espnPlayer, highVariance: true }),
  // A goalie scores only once he is confirmed as the starter (no source for that yet, so saves wait).
  ...v2('NHL', ['saves'], [['expected_shots_against',40],['save_rate',20],['historical_volume',25],['opponent_shot_rate',10],['stability',5]],
    { criticalKinds: ['status:starting_goalie', 'status:player_available'], hardCriticalKinds: ['status:starting_goalie', 'status:player_available'],
      partialCoverageNormalization: true }, '1.1'),
  ...v2('SOCCER', ['shots'], [['shot_volume',35],['historical_volume',25],['goal_involvement',15],['on_target_rate',10],['opponent',10],['stability',5]], espnPlayer),
  ...v2('SOCCER', ['sot'], [['shot_volume',30],['on_target_rate',25],['historical_volume',25],['goal_involvement',10],['opponent',5],['stability',5]], espnPlayer),
  ...v2('SOCCER', ['goals'], [['shot_volume',30],['on_target_rate',20],['historical_volume',25],['goal_involvement',10],['opponent',10],['stability',5]], { ...espnPlayer, highVariance: true }),
  ...v2('SOCCER', ['assists'], [['goal_involvement',35],['historical_volume',30],['shot_volume',10],['opponent',15],['stability',10]], { ...espnPlayer, highVariance: true }),
  ...v2('SOCCER', ['goal_plus_assist'], [['goal_involvement',30],['historical_volume',25],['shot_volume',20],['on_target_rate',10],['opponent',10],['stability',5]], { ...espnPlayer, highVariance: true }),
  ...v2('SOCCER', ['fouls'], [['historical_volume',50],['fouls_drawn',15],['opponent',25],['stability',10]], espnPlayer),
  // A keeper scores only from the posted lineup.
  ...v2('SOCCER', ['goalie_saves'], [['expected_shots_against',40],['historical_volume',35],['opponent',20],['stability',5]],
    { criticalKinds: ['status:starting_lineup', 'status:player_available'], hardCriticalKinds: ['status:starting_lineup', 'status:player_available'],
      partialCoverageNormalization: true }),
  ...v2('NCAAFB', ['passing_yards'], [['expected_attempts',30],['efficiency',25],['historical_volume',25],['game_script',10],['opponent',5],['stability',5]], { ...espnPlayer, blowoutMode: 'ROTATION' }, '1.1'),
  ...v2('NCAAFB', ['player_pass_attempts'], [['expected_attempts',40],['historical_volume',30],['game_script',20],['stability',10]], { ...espnPlayer, blowoutMode: 'ROTATION' }),
  ...v2('NCAAFB', ['player_pass_completions'], [['expected_attempts',35],['efficiency',20],['historical_volume',30],['game_script',10],['stability',5]], { ...espnPlayer, blowoutMode: 'ROTATION' }),
  ...v2('NCAAFB', ['player_pass_tds'], [['expected_attempts',25],['efficiency',25],['historical_volume',30],['opponent',15],['stability',5]], { ...espnPlayer, highVariance: true, blowoutMode: 'ROTATION' }),
  ...v2('NCAAFB', ['player_rush_yds'], [['expected_carries',35],['yards_per_carry',25],['historical_volume',25],['game_script',10],['stability',5]], { ...espnPlayer, blowoutMode: 'ROTATION' }, '1.1'),
  ...v2('NCAAFB', ['player_rush_attempts'], [['expected_carries',45],['historical_volume',30],['game_script',20],['stability',5]], { ...espnPlayer, blowoutMode: 'ROTATION' }),
  ...v2('NCAAFB', ['player_reception_yds'], [['target_share',35],['receiving_efficiency',25],['historical_volume',25],['game_script',10],['stability',5]], { ...espnPlayer, blowoutMode: 'ROTATION' }, '1.1'),
  ...v2('NCAAFB', ['player_receptions'], [['target_share',40],['historical_volume',35],['receiving_efficiency',10],['game_script',10],['stability',5]], { ...espnPlayer, blowoutMode: 'ROTATION' }),
  ...v2('NFL', ['player_completion_percentage'], [['completion_rate',40],['attempts',20],['passing_style',20],['pressure',15],['stability',5]], nflQb, '1.1'),
];
/** The stat-history set 2 versions, approved together by GKR_MODEL_PRESET=stat_history_v2. */
export const statHistoryV2Versions = statHistoryV2.map((definition) => definition.version);

/**
 * Stat-history set 3 (owner approved 2026-10-05: "if Sleeper is giving all that, use it for scoring"): CS2 and tennis
 * scored from each player's recent results for the exact stat (Sleeper's recent performance; ESPN set scores for tennis
 * games). Projection plus recent form against the larger sample and stability; no availability source exists for these
 * sports, so nothing gates them beyond the history itself. One model under each market key the apps use.
 */
const sh3 = (sport: Sport, markets: readonly string[], factors: readonly WeightedFactor[], highVariance = false) =>
  markets.map((market) => define(sport, market, factors, { partialCoverageNormalization: true, highVariance,
    version: `GKR-${sport}-${market.toUpperCase().replace(/_/g, '-')}-SH3-1.0` }));
const statHistoryV3: readonly MarketDefinition[] = [
  ...sh3('CS2', ['maps_1_2_kills', 'kills_maps_1_2', 'kills_on_maps_1_plus_2', 'maps_1_2_kills_plus'], [['historical_volume',65],['stability',35]], true),
  ...sh3('CS2', ['maps_1_2_headshots', 'headshots_maps_1_2', 'headshots_on_maps_1_plus_2'], [['historical_volume',65],['stability',35]], true),
  ...sh3('TENNIS', ['total_games_won', 'games_won'], [['historical_volume',60],['stability',40]]),
  ...sh3('TENNIS', ['total_games'], [['historical_volume',60],['stability',40]]),
  ...sh3('TENNIS', ['aces'], [['historical_volume',60],['stability',40]], true),
  ...sh3('TENNIS', ['double_faults'], [['historical_volume',60],['stability',40]], true),
  ...sh3('TENNIS', ['break_points_won', 'breakpoints_won'], [['historical_volume',60],['stability',40]], true),
];
/** The stat-history set 3 versions (CS2 and tennis). */
export const statHistoryV3Versions = statHistoryV3.map((definition) => definition.version);

/**
 * Stat-history set 4 (owner approved 2026-10-07: "expand GKR history to other sports"): WNBA from ESPN box scores
 * (minutes and the stat itself, gated on the ESPN roster's availability), college football touchdowns, receptions,
 * interceptions, scrimmage and longest-play lines from ESPN game logs, and the tennis lines the other sets missed.
 * New versions only: every model already approved keeps its version and score.
 */
const sh4 = (sport: Sport, markets: readonly string[], factors: readonly WeightedFactor[],
  options: Partial<Pick<MarketDefinition, 'criticalKinds' | 'hardCriticalKinds' | 'highVariance' | 'blowoutMode'>> = {}) =>
  markets.map((market) => define(sport, market, factors, { partialCoverageNormalization: true, ...options,
    version: `GKR-${sport}-${market.toUpperCase().replace(/_/g, '-')}-SH4-1.0` }));
const hoops: readonly WeightedFactor[] = [['historical_volume',50],['minutes',30],['stability',20]];
const wnba = { ...espnPlayer, blowoutMode: 'ROTATION' as const };
const statHistoryV4: readonly MarketDefinition[] = [
  ...sh4('WNBA', ['player_points', 'points'], hoops, wnba),
  ...sh4('WNBA', ['player_rebounds', 'rebounds'], hoops, wnba),
  ...sh4('WNBA', ['player_assists', 'assists'], hoops, wnba),
  ...sh4('WNBA', ['player_points_rebounds_assists', 'pts_plus_rebs_plus_asts', 'pra', 'player_points_plus_rebounds_plus_assists',
    'points_plus_rebounds_plus_assists'], hoops, wnba),
  ...sh4('WNBA', ['player_points_rebounds', 'pts_plus_rebs', 'player_points_plus_rebounds', 'points_plus_rebounds'], hoops, wnba),
  ...sh4('WNBA', ['player_points_assists', 'pts_plus_asts', 'player_points_plus_assists', 'points_plus_assists'], hoops, wnba),
  ...sh4('WNBA', ['player_rebounds_assists', 'rebs_plus_asts', 'player_rebounds_plus_assists', 'rebounds_plus_assists',
    'assists_plus_rebounds'], hoops, wnba),
  ...sh4('WNBA', ['player_threes', '3_pointers_made', '3_pt_made', 'threes', '3ptm', 'player_made_threes'], hoops, { ...wnba, highVariance: true }),
  ...sh4('WNBA', ['steals', 'player_steals'], hoops, { ...wnba, highVariance: true }),
  ...sh4('WNBA', ['blocked_shots', 'blocks', 'player_blocks'], hoops, { ...wnba, highVariance: true }),
  ...sh4('WNBA', ['blks_plus_stls', 'blocks_plus_steals', 'player_blocks_steals', 'stocks'], hoops, { ...wnba, highVariance: true }),
  ...sh4('WNBA', ['turnovers', 'player_turnovers'], hoops, { ...wnba, highVariance: true }),
  ...sh4('NCAAFB', ['anytime_tds', 'rush_plus_rec_td_scorer'], [['expected_touches',40],['historical_volume',45],['stability',15]], { ...espnPlayer, highVariance: true }),
  ...sh4('NCAAFB', ['recs'], [['target_share',45],['historical_volume',40],['receiving_efficiency',10],['stability',5]], espnPlayer),
  ...sh4('NCAAFB', ['rec_tds'], [['target_share',35],['historical_volume',50],['stability',15]], { ...espnPlayer, highVariance: true }),
  ...sh4('NCAAFB', ['rush_tds'], [['expected_carries',35],['historical_volume',50],['stability',15]], { ...espnPlayer, highVariance: true }),
  ...sh4('NCAAFB', ['pass_tds'], [['expected_attempts',30],['efficiency',20],['historical_volume',40],['stability',10]], { ...espnPlayer, highVariance: true }),
  ...sh4('NCAAFB', ['int', 'player_pass_interceptions'], [['expected_attempts',35],['historical_volume',50],['stability',15]], { ...espnPlayer, highVariance: true }),
  ...sh4('NCAAFB', ['rush_plus_rec_yds', 'player_rush_reception_yds'], [['expected_touches',40],['historical_volume',45],['stability',15]], espnPlayer),
  ...sh4('NCAAFB', ['longest_rec'], [['target_share',30],['historical_volume',50],['stability',20]], { ...espnPlayer, highVariance: true }),
  ...sh4('NCAAFB', ['longest_rush'], [['expected_carries',30],['historical_volume',50],['stability',20]], { ...espnPlayer, highVariance: true }),
  ...sh4('TENNIS', ['player_double_faults'], [['historical_volume',60],['stability',40]], { highVariance: true }),
  ...sh4('TENNIS', ['total_sets'], [['historical_volume',60],['stability',40]]),
];
/** The stat-history set 4 versions (WNBA, more college football, the rest of tennis). */
export const statHistoryV4Versions = statHistoryV4.map((definition) => definition.version);

export const marketDefinitions: readonly MarketDefinition[] = [
  define('NFL','passing_yards', [['expected_attempts',25],['efficiency_environment',20],['protection_pressure',15],['game_script',15],['personnel',10],['historical_current_form',10],['stability',5]], {version:'GKR-NFL-PASSING-YARDS-1.2',criticalKinds:['status:qb_available','status:weather_clear','status:protection_confirmed'],hardCriticalKinds:['status:qb_available'],partialCoverageNormalization:true,blowoutMode:'VOLUME_LOSS'}),
  define('NFL','player_pass_attempts', [['game_script',30],['expected_offensive_plays',20],['pass_rate',20],['qb_role_security',10],['opponent_run_pass_funnel',10],['historical_volume',5],['stability',5]], {version:'GKR-NFL-PLAYER-PASS-ATTEMPTS-1.2',criticalKinds:['status:qb_available'],partialCoverageNormalization:true,blowoutMode:'VOLUME_LOSS'}),
  define('NFL','player_pass_completions', [['attempts',30],['completion_rate',20],['passing_style',15],['opponent_coverage',15],['game_script',10],['pressure',5],['stability',5]], {version:'GKR-NFL-PLAYER-PASS-COMPLETIONS-1.2',criticalKinds:['status:qb_available'],partialCoverageNormalization:true,blowoutMode:'VOLUME_LOSS'}),
  define('NFL','player_rush_yds', [['expected_carries',30],['rush_attempt_rate',25],['rb_efficiency_skill',20],['historical_rush_volume',10],['game_script',5],['opponent_rush_defense',5],['stability',5]], {version:'GKR-NFL-PLAYER-RUSH-YDS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'RUSH_GAIN'}),
  define('NFL','player_rush_attempts', [['rush_attempt_rate',35],['historical_volume',25],['offensive_snap_volume',15],['game_script',10],['team_rush_environment',10],['stability',5]], {version:'GKR-NFL-PLAYER-RUSH-ATTEMPTS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'RUSH_GAIN'}),
  define('NFL','player_reception_yds', [['target_opportunity_rate',25],['receiving_efficiency',20],['offensive_snap_volume',20],['historical_receiving_volume',15],['coverage_matchup',10],['qb_environment',5],['stability',5]], {version:'GKR-NFL-PLAYER-RECEPTION-YDS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'VOLUME_LOSS'}),
  define('NFL','player_receptions', [['target_floor',25],['catch_rate',20],['offensive_snap_volume',20],['historical_reception_volume',15],['matchup_coverage',10],['qb_completion_environment',5],['stability',5]], {version:'GKR-NFL-PLAYER-RECEPTIONS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'VOLUME_LOSS'}),
  define('NFL','player_receiving_targets', [['target_opportunity_rate',30],['offensive_snap_volume',25],['historical_target_volume',20],['personnel_changes',10],['coverage_influence',10],['stability',5]], {version:'GKR-NFL-PLAYER-RECEIVING-TARGETS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true}),

  define('MLB','batter_hits_runs_rbis', [['expected_pa',20],['historical_hrrbi_volume',20],['run_creation_rate',15],['contact_obp_skill',15],['home_run_rate',15],['pitcher_matchup',10],['stability',5]], {version:'GKR-MLB-BATTER-HITS-RUNS-RBIS-1.3',criticalKinds:['status:starting_lineup','status:starting_pitcher'],partialCoverageNormalization:true}),
  define('MLB','batter_hits', [['expected_pa',20],['contact_ability',25],['historical_hit_volume',25],['hit_rate',20],['pitcher_matchup',5],['stability',5]], {version:'GKR-MLB-BATTER-HITS-1.3',criticalKinds:['status:starting_lineup','status:starting_pitcher'],partialCoverageNormalization:true}),
  define('MLB','batter_walks', [['hitter_walk_rate',35],['expected_pa',25],['historical_walk_volume',25],['pitcher_walk_rate',5],['lineup_protection',5],['stability',5]], {version:'GKR-MLB-BATTER-WALKS-1.3',criticalKinds:['status:starting_lineup','status:starting_pitcher'],partialCoverageNormalization:true}),
  define('MLB','batter_home_runs', [['extra_base_power_rate',30],['expected_pa',20],['historical_hr_volume',25],['hr_frequency',15],['pitcher_hr_susceptibility',5],['park',5]], {version:'GKR-MLB-BATTER-HOME-RUNS-1.3',criticalKinds:['status:starting_lineup','status:starting_pitcher'],partialCoverageNormalization:true,highVariance:true}),
  define('MLB','pitcher_strikeouts', [['expected_batters_faced',20],['pitch_count_innings',15],['pitcher_k_rate',20],['opponent_k_rate',20],['pitch_mix_matchup',10],['environment',5],['hook_risk',5],['stability',5]], {version:'GKR-MLB-PITCHER-STRIKEOUTS-1.2',criticalKinds:['status:starting_pitcher'],hardCriticalKinds:['status:starting_pitcher'],partialCoverageNormalization:true}),

  ...(['NBA','WNBA'] as const).flatMap((sport) => [
    define(sport,'player_points', sport==='NBA'?[['expected_minutes',25],['shot_volume',20],['usage_proxy',20],['scoring_rate',15],['matchup',10],['pace',5],['stability',5]]:[['expected_minutes',25],['usage',20],['shot_volume',15],['matchup',15],['pace',10],['ft_opportunity',5],['role_injuries',5],['stability',5]], sport==='NBA'?{version:'GKR-NBA-PLAYER-POINTS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'ROTATION'}:{criticalKinds:['status:minutes_confirmed','status:lineup_confirmed'],blowoutMode:'ROTATION'}),
    define(sport,'player_rebounds', sport==='NBA'?[['minutes',25],['rebound_rate',25],['historical_rebound_volume',20],['opponent_shot_profile',10],['team_rebounding_environment',10],['pace',5],['stability',5]]:[['minutes',25],['rebound_chance_share',20],['position_role',15],['opponent_shot_profile',15],['team_rebounding_environment',10],['pace',10],['stability',5]], sport==='NBA'?{version:'GKR-NBA-PLAYER-REBOUNDS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'ROTATION'}:{criticalKinds:['status:minutes_confirmed'],blowoutMode:'ROTATION'}),
    define(sport,'player_assists', sport==='NBA'?[['minutes',20],['potential_assists',25],['ball_handling_rate',20],['historical_assist_volume',15],['opponent_defense',10],['pace',5],['stability',5]]:[['minutes',20],['potential_assists',25],['ball_handling_role',20],['teammate_shooting',10],['opponent_defense',10],['pace',10],['stability',5]], sport==='NBA'?{version:'GKR-NBA-PLAYER-ASSISTS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'ROTATION'}:{criticalKinds:['status:minutes_confirmed'],blowoutMode:'ROTATION'}),
    define(sport,'player_points_rebounds_assists', [['minutes',20],['overall_usage',20],['scoring_opportunity',20],['rebounding_opportunity',15],['assist_opportunity',15],['game_environment',5],['stability',5]], sport==='NBA'?{version:'GKR-NBA-PLAYER-POINTS-REBOUNDS-ASSISTS-1.2',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'ROTATION'}:{criticalKinds:['status:minutes_confirmed'],blowoutMode:'ROTATION'}),
    define(sport,'player_points_rebounds', [['points_opportunity',35],['rebounding_opportunity',25],['minutes',20],['environment',10],['stability',10]], sport==='NBA'?{version:'GKR-NBA-PLAYER-POINTS-REBOUNDS-1.2',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'ROTATION'}:{criticalKinds:['status:minutes_confirmed'],blowoutMode:'ROTATION'}),
    define(sport,'player_points_assists', [['points_opportunity',35],['assist_opportunity',25],['minutes',20],['environment',10],['stability',10]], sport==='NBA'?{version:'GKR-NBA-PLAYER-POINTS-ASSISTS-1.2',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'ROTATION'}:{criticalKinds:['status:minutes_confirmed'],blowoutMode:'ROTATION'}),
    define(sport,'player_rebounds_assists', [['rebounding_opportunity',35],['assist_opportunity',30],['minutes',20],['environment',10],['stability',5]], sport==='NBA'?{version:'GKR-NBA-PLAYER-REBOUNDS-ASSISTS-1.2',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'ROTATION'}:{criticalKinds:['status:minutes_confirmed'],blowoutMode:'ROTATION'}),
  ]),

  define('TENNIS','match_winner', [['surface_adjusted_strength',25],['current_form',15],['opponent_strength',15],['serve_return_differential',20],['tournament_context',10],['fatigue',5],['h2h_matchup',5],['stability',5]], {criticalKinds:['status:surface_confirmed','status:tournament_round']}),
  define('TENNIS','total_games', [['expected_competitiveness',30],['serve_hold_environment',20],['three_set_probability',20],['surface',10],['style_matchup',10],['fatigue',5],['tournament_context',5]], {criticalKinds:['status:surface_confirmed','status:tournament_round'],dangerUnits:1}),
  define('TENNIS','total_sets', [['player_strength_gap',25],['serve_return_balance',20],['recent_competitiveness',15],['surface',15],['style_matchup',10],['fatigue',5],['tournament_context',5],['stability',5]]),
  define('TENNIS','player_aces', [['ace_rate',30],['expected_service_games',25],['opponent_return_profile',15],['surface',15],['match_length',10],['stability',5]]),
  define('TENNIS','player_double_faults', [['df_rate',30],['expected_service_games',25],['return_pressure',15],['match_pressure',10],['surface',10],['recent_serve_stability',5],['stability',5]]),
  define('TENNIS','player_break_points', [['return_quality',25],['opponent_serve_weakness',25],['expected_return_games',20],['match_length',10],['surface',10],['form',5],['stability',5]]),
  define('TENNIS','first_set_total_games', [['opening_serve_strength',20],['opening_return_strength',20],['expected_set_competitiveness',25],['tiebreak_probability',15],['surface',10],['early_match_tendencies',5],['stability',5]]),

  define('TABLE_TENNIS','full_match_total_points', [['player_strength_gap',25],['straight_set_probability',25],['set_competitiveness',20],['recent_form',10],['style_matchup',10],['ranking',5],['stability',5]]),
  define('TABLE_TENNIS','first_game_total_points', [['opening_game_competitiveness',30],['serve_return_style',20],['player_strength_gap',20],['recent_first_game_history',15],['matchup',10],['stability',5]]),
  define('BADMINTON','match_context', [['ranking_differential',20],['tournament_level',15],['tournament_round',15],['recent_form',15],['opponent_quality',15],['seeding',10],['fatigue',5],['stability',5]], {criticalKinds:['status:tournament_round']}),
  // Stat-history set 2 (owner approved 2026-10-04): every Stat API stat the board offers. Opt-in through
  // GKR_MODEL_PRESET=stat_history_v2; batters need the posted lineup, pitchers the probable start, NFL players active.
  ...statHistoryV2,
  define('BADMINTON','game_point_totals', [['expected_competitiveness',30],['straight_game_probability',20],['ranking_gap',15],['style_matchup',15],['recent_match_length',10],['tournament_context',5],['stability',5]], {criticalKinds:['status:tournament_round']}),

  define('CS2','maps_1_2_kills', [['expected_round_volume',25],['kill_share',20],['role',15],['form_rating',15],['opponent',10],['team_strength_series_script',10],['stability',5]], {criticalKinds:['status:roster_confirmed','status:series_format'],dangerUnits:1.5}),
  define('CS2','headshots', [['expected_kills',30],['historical_hs_pct',30],['role_weapon_profile',15],['round_volume',10],['opponent',5],['recent_hs_stability',5],['stability',5]], {criticalKinds:['status:roster_confirmed'],highVariance:true}),
  define('VALORANT','kills', [['role_agent',20],['round_volume',25],['kill_share',20],['team_strength',10],['opponent',10],['map_series_environment',10],['stability',5]], {criticalKinds:['status:roster_confirmed','status:series_format']}),
  define('LOL','kills', [['role',20],['team_kill_expectation',25],['kill_share',20],['match_duration',15],['opponent',10],['champion_meta',5],['stability',5]], {criticalKinds:['status:roster_confirmed']}),
  define('LOL','assists', [['role',25],['team_kills',25],['kill_participation',25],['duration',10],['team_strength',10],['stability',5]], {criticalKinds:['status:roster_confirmed']}),
  define('DOTA','kills', [['position',20],['team_kill_expectation',20],['hero',15],['farm_priority',15],['match_duration',15],['opponent',10],['stability',5]], {criticalKinds:['status:roster_confirmed']}),
  define('DOTA','assists', [['position',20],['team_fight_participation',25],['team_kills',20],['hero',15],['match_duration',10],['opponent',5],['stability',5]], {criticalKinds:['status:roster_confirmed']}),
  define('APEX','kills', [['player_role',20],['team_strength',20],['expected_placement',15],['fight_frequency',15],['tournament_format',10],['map_volume',10],['recent_form',5],['stability',5]], {criticalKinds:['status:roster_confirmed','status:tournament_format']}),

  define('NCAAFB','qb_rushing_yards', [['designed_rush_share',25],['scramble_rate',15],['game_script',15],['opponent',15],['expected_snaps',15],['sack_treatment_platform_rules',5],['blowout_rotation',5],['stability',5]], {criticalKinds:['status:qb_available','status:sack_rules_confirmed'],blowoutMode:'ROTATION'}),
  define('HANDBALL','goals', [['role',20],['shot_volume',25],['minutes',20],['opponent_defense',15],['penalty_set_piece_role',10],['recent_usage',5],['stability',5]]),
  define('HANDBALL','assists', [['playmaking_role',30],['minutes',20],['team_scoring_environment',15],['opponent',15],['historical_assist_rate',10],['recent_usage',5],['stability',5]]),

  // Fantasy markets require joint scenario evidence; generic factor weights
  // are used only for context, never as a replacement for the fantasy scoring registry.
  ...([['NFL','player_fantasy_points','offense'],['NCAAFB','player_fantasy_points','offense'],
    ['MLB','batter_fantasy_score','batter'],['MLB','pitcher_fantasy_score','pitcher'],
    ['NBA','player_fantasy_points','player'],['WNBA','player_fantasy_points','player'],
    ['TENNIS','player_fantasy_points','player'],['NHL','player_fantasy_points','skater']] as const)
    .map(([sport, market]) => define(sport, market, defaults,
      { criticalKinds: ['status:fantasy_scenarios_confirmed'] })),
  // Last, so lookups by sport and market find the older definition unless set 3 is approved.
  ...statHistoryV3,
  ...statHistoryV4,
];


const statHistoryReadyKeys=new Set([
  'NFL:passing_yards','NFL:player_pass_attempts','NFL:player_pass_completions',
  'NFL:player_rush_yds','NFL:player_rush_attempts','NFL:player_reception_yds',
  'NFL:player_receptions','NFL:player_receiving_targets',
  'NBA:player_points','NBA:player_rebounds','NBA:player_assists',
  'NBA:player_points_rebounds_assists','NBA:player_points_rebounds',
  'NBA:player_points_assists','NBA:player_rebounds_assists',
  'MLB:batter_hits_runs_rbis','MLB:batter_hits','MLB:batter_walks',
  'MLB:batter_home_runs','MLB:pitcher_strikeouts',
]);

export const statHistoryReadyVersions=marketDefinitions
  .filter((definition)=>statHistoryReadyKeys.has(definition.sport+':'+definition.market))
  .map((definition)=>definition.version);
