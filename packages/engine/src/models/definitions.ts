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

export const marketDefinitions: readonly MarketDefinition[] = [
  define('NFL','passing_yards', [['expected_attempts',25],['efficiency_environment',20],['protection_pressure',15],['game_script',15],['personnel',10],['historical_current_form',10],['stability',5]], {version:'GKR-NFL-PASSING-YARDS-1.2',criticalKinds:['status:qb_available','status:weather_clear','status:protection_confirmed'],hardCriticalKinds:['status:qb_available'],partialCoverageNormalization:true,blowoutMode:'VOLUME_LOSS'}),
  define('NFL','player_pass_attempts', [['game_script',30],['expected_offensive_plays',20],['pass_rate',20],['qb_role_security',10],['opponent_run_pass_funnel',10],['historical_volume',5],['stability',5]], {version:'GKR-NFL-PLAYER-PASS-ATTEMPTS-1.2',criticalKinds:['status:qb_available'],partialCoverageNormalization:true,blowoutMode:'VOLUME_LOSS'}),
  define('NFL','player_pass_completions', [['attempts',30],['completion_rate',20],['passing_style',15],['opponent_coverage',15],['game_script',10],['pressure',5],['stability',5]], {version:'GKR-NFL-PLAYER-PASS-COMPLETIONS-1.2',criticalKinds:['status:qb_available'],partialCoverageNormalization:true,blowoutMode:'VOLUME_LOSS'}),
  define('NFL','player_pass_tds', [['team_scoring_environment',25],['red_zone_pass_rate',20],['qb_red_zone_role',15],['opponent_red_zone_defense',15],['receiver_availability',10],['expected_attempts',10],['stability',5]], {criticalKinds:['status:qb_available','status:receivers_confirmed'],highVariance:true,blowoutMode:'VOLUME_LOSS'}),
  define('NFL','player_rush_yds', [['expected_carries',30],['rush_attempt_rate',25],['rb_efficiency_skill',20],['historical_rush_volume',10],['game_script',5],['opponent_rush_defense',5],['stability',5]], {version:'GKR-NFL-PLAYER-RUSH-YDS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'RUSH_GAIN'}),
  define('NFL','player_rush_attempts', [['rush_attempt_rate',35],['historical_volume',25],['offensive_snap_volume',15],['game_script',10],['team_rush_environment',10],['stability',5]], {version:'GKR-NFL-PLAYER-RUSH-ATTEMPTS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'RUSH_GAIN'}),
  define('NFL','player_reception_yds', [['target_opportunity_rate',25],['receiving_efficiency',20],['offensive_snap_volume',20],['historical_receiving_volume',15],['coverage_matchup',10],['qb_environment',5],['stability',5]], {version:'GKR-NFL-PLAYER-RECEPTION-YDS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'VOLUME_LOSS'}),
  define('NFL','player_receptions', [['target_floor',25],['catch_rate',20],['offensive_snap_volume',20],['historical_reception_volume',15],['matchup_coverage',10],['qb_completion_environment',5],['stability',5]], {version:'GKR-NFL-PLAYER-RECEPTIONS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true,blowoutMode:'VOLUME_LOSS'}),
  define('NFL','player_receiving_targets', [['target_opportunity_rate',30],['offensive_snap_volume',25],['historical_target_volume',20],['personnel_changes',10],['coverage_influence',10],['stability',5]], {version:'GKR-NFL-PLAYER-RECEIVING-TARGETS-1.3',criticalKinds:['status:player_available'],hardCriticalKinds:['status:player_available'],partialCoverageNormalization:true}),
  define('NFL','player_tackles_assists', [['expected_defensive_snaps',25],['player_snap_share',20],['position_role',15],['opponent_play_style',15],['opponent_rush_short_pass_volume',10],['tackle_efficiency',10],['stability',5]]),
  define('NFL','player_sacks', [['opponent_pressure_rate',25],['offensive_line',20],['qb_sack_tendency',20],['expected_dropbacks',15],['game_script',10],['qb_mobility_time_to_throw',5],['stability',5]]),
  define('NFL','player_kicking_points', [['team_scoring_environment',25],['field_goal_opportunity',20],['red_zone_stalling',15],['weather',10],['kicker_accuracy',10],['competitiveness',10],['opponent_profile',5],['stability',5]], {criticalKinds:['status:kicker_available','status:weather_clear']}),
  define('NFL','player_punts', [['expected_drives',20],['offensive_efficiency',25],['opponent_defense',20],['field_position_game_script',15],['fourth_down_aggressiveness',10],['historical_punt_rate',5],['stability',5]]),
  define('NFL','player_completion_percentage', [['passing_style',25],['qb_accuracy',20],['opponent_coverage',15],['pressure',15],['expected_adot',10],['weather',5],['receiver_availability',5],['stability',5]], {criticalKinds:['status:qb_available','status:weather_clear']}),

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
  define('BADMINTON','game_point_totals', [['expected_competitiveness',30],['straight_game_probability',20],['ranking_gap',15],['style_matchup',15],['recent_match_length',10],['tournament_context',5],['stability',5]], {criticalKinds:['status:tournament_round']}),

  define('CS2','maps_1_2_kills', [['expected_round_volume',25],['kill_share',20],['role',15],['form_rating',15],['opponent',10],['team_strength_series_script',10],['stability',5]], {criticalKinds:['status:roster_confirmed','status:series_format'],dangerUnits:1.5}),
  define('CS2','headshots', [['expected_kills',30],['historical_hs_pct',30],['role_weapon_profile',15],['round_volume',10],['opponent',5],['recent_hs_stability',5],['stability',5]], {criticalKinds:['status:roster_confirmed'],highVariance:true}),
  define('VALORANT','kills', [['role_agent',20],['round_volume',25],['kill_share',20],['team_strength',10],['opponent',10],['map_series_environment',10],['stability',5]], {criticalKinds:['status:roster_confirmed','status:series_format']}),
  define('LOL','kills', [['role',20],['team_kill_expectation',25],['kill_share',20],['match_duration',15],['opponent',10],['champion_meta',5],['stability',5]], {criticalKinds:['status:roster_confirmed']}),
  define('LOL','assists', [['role',25],['team_kills',25],['kill_participation',25],['duration',10],['team_strength',10],['stability',5]], {criticalKinds:['status:roster_confirmed']}),
  define('DOTA','kills', [['position',20],['team_kill_expectation',20],['hero',15],['farm_priority',15],['match_duration',15],['opponent',10],['stability',5]], {criticalKinds:['status:roster_confirmed']}),
  define('DOTA','assists', [['position',20],['team_fight_participation',25],['team_kills',20],['hero',15],['match_duration',10],['opponent',5],['stability',5]], {criticalKinds:['status:roster_confirmed']}),
  define('APEX','kills', [['player_role',20],['team_strength',20],['expected_placement',15],['fight_frequency',15],['tournament_format',10],['map_volume',10],['recent_form',5],['stability',5]], {criticalKinds:['status:roster_confirmed','status:tournament_format']}),

  define('NHL','shots_on_goal', [['shot_volume',30],['expected_ice_time',20],['line_assignment',15],['power_play_role',10],['opponent_shot_suppression',10],['game_environment',10],['stability',5]], {criticalKinds:['status:line_confirmed']}),
  define('NHL','points', [['line_assignment',20],['power_play_role',20],['ice_time',15],['team_scoring_environment',15],['opponent_goalie',15],['recent_involvement',10],['stability',5]], {criticalKinds:['status:line_confirmed'],highVariance:true}),
  define('NHL','saves', [['expected_shots_against',35],['opponent_shot_rate',20],['goalie_start_confirmation',15],['team_defense',10],['game_script',10],['opponent_quality',5],['stability',5]], {criticalKinds:['status:starting_goalie']}),
  define('NCAAFB','passing_yards', [['game_script',20],['expected_attempts',25],['efficiency',15],['talent_mismatch',15],['opponent',10],['blowout_rotation_risk',10],['stability',5]], {criticalKinds:['status:qb_available'],blowoutMode:'ROTATION'}),
  define('NCAAFB','player_rush_yds', [['expected_carries',25],['game_script',20],['talent_ol_mismatch',20],['opponent_run_defense',15],['committee_risk',10],['blowout_rotation',5],['stability',5]], {criticalKinds:['status:workload_confirmed'],blowoutMode:'ROTATION'}),
  define('NCAAFB','qb_rushing_yards', [['designed_rush_share',25],['scramble_rate',15],['game_script',15],['opponent',15],['expected_snaps',15],['sack_treatment_platform_rules',5],['blowout_rotation',5],['stability',5]], {criticalKinds:['status:qb_available','status:sack_rules_confirmed'],blowoutMode:'ROTATION'}),
  define('NCAAFB','player_reception_yds', [['target_share',25],['expected_pass_volume',20],['talent_matchup',15],['coverage',15],['route_participation',10],['game_script',10],['stability',5]], {criticalKinds:['status:target_role_confirmed'],blowoutMode:'ROTATION'}),
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
