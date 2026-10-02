import type { Analysis } from '@crowniq/contracts';

type Component = NonNullable<Analysis['contextBreakdown']>[number];

/** Plain names for the factors CrownIQ measures today, plus the exact-line adjustments. */
export const factorLabels: Readonly<Record<string, string>> = {
  // NFL
  expected_attempts: 'Pass attempts', efficiency_environment: 'Yards per attempt',
  historical_current_form: 'Recent passing yards', expected_offensive_plays: 'Offensive plays',
  pass_rate: 'Pass rate', qb_role_security: 'QB snap share', historical_volume: 'Recent volume',
  attempts: 'Pass attempts', completion_rate: 'Completion rate', passing_style: 'Yards per attempt',
  expected_carries: 'Carries', rush_attempt_rate: 'Carries per snap', rb_efficiency_skill: 'Yards per carry',
  historical_rush_volume: 'Recent rushing yards', offensive_snap_volume: 'Offensive snaps',
  target_opportunity_rate: 'Targets per snap', receiving_efficiency: 'Yards per target',
  historical_receiving_volume: 'Recent receiving yards', target_floor: 'Targets', catch_rate: 'Catch rate',
  historical_reception_volume: 'Recent receptions', historical_target_volume: 'Recent targets',
  coverage_matchup: 'Coverage matchup', matchup_coverage: 'Coverage matchup', qb_environment: 'QB quality',
  qb_completion_environment: 'QB completion rate', protection_pressure: 'Pass protection', game_script: 'Game script',
  personnel: 'Personnel', opponent_rush_defense: 'Opponent run defense',
  // NBA
  expected_minutes: 'Minutes', minutes: 'Minutes', shot_volume: 'Shot attempts', usage_proxy: 'Usage rate',
  scoring_rate: 'Points per minute', rebound_rate: 'Rebounds per minute', historical_rebound_volume: 'Recent rebounds',
  potential_assists: 'Potential assists', ball_handling_rate: 'Ball handling per minute',
  historical_assist_volume: 'Recent assists', scoring_opportunity: 'Recent points', rebounding_opportunity: 'Recent rebounds',
  assist_opportunity: 'Recent assists', points_opportunity: 'Recent points', matchup: 'Matchup', pace: 'Pace',
  opponent_defense: 'Opponent defense', opponent_shot_profile: 'Opponent shot profile',
  team_rebounding_environment: 'Team rebounding',
  // MLB
  expected_pa: 'Plate appearances', contact_obp_skill: 'On-base rate', home_run_rate: 'Home run rate',
  historical_hrrbi_volume: 'Recent hits + runs + RBIs', run_creation_rate: 'Run production per PA',
  contact_ability: 'Batting average', historical_hit_volume: 'Recent hits', hit_rate: 'Hits per PA',
  hitter_walk_rate: 'Walk rate', historical_walk_volume: 'Recent walks', extra_base_power_rate: 'Extra-base hit rate',
  historical_hr_volume: 'Recent home runs', hr_frequency: 'Home runs per PA', expected_batters_faced: 'Batters faced',
  pitch_count_innings: 'Innings pitched', pitcher_k_rate: 'Strikeout rate', opponent_k_rate: 'Opponent strikeout rate',
  pitcher_matchup: 'Pitcher matchup',
  // NFL (more)
  competitiveness: 'Game competitiveness', coverage_influence: 'Coverage on the receiver', expected_adot: 'Average target depth',
  expected_defensive_snaps: 'Defensive snaps', expected_drives: 'Drives', expected_dropbacks: 'Dropbacks',
  field_goal_opportunity: 'Field goal chances', field_position_game_script: 'Field position', fourth_down_aggressiveness: 'Fourth-down aggressiveness',
  historical_punt_rate: 'Recent punts', kicker_accuracy: 'Kicker accuracy', offensive_efficiency: 'Offensive efficiency',
  offensive_line: 'Offensive line', opponent_coverage: 'Opponent coverage', opponent_play_style: 'Opponent play style',
  opponent_pressure_rate: 'Opponent pass rush', opponent_profile: 'Opponent profile', opponent_red_zone_defense: 'Opponent red-zone defense',
  opponent_run_pass_funnel: 'Opponent run/pass tendency', opponent_rush_short_pass_volume: 'Opponent short-pass and run volume',
  personnel_changes: 'Personnel changes', player_snap_share: 'Snap share', position_role: 'Position role', pressure: 'Pass rush pressure',
  qb_accuracy: 'QB accuracy', qb_mobility_time_to_throw: 'QB mobility and time to throw', qb_red_zone_role: 'QB red-zone role',
  qb_sack_tendency: 'QB sack tendency', receiver_availability: 'Receivers available', red_zone_pass_rate: 'Red-zone pass rate',
  red_zone_stalling: 'Red-zone stalls', tackle_efficiency: 'Tackle rate', team_rush_environment: 'Team rushing volume',
  team_scoring_environment: 'Team scoring', weather: 'Weather',
  // College football
  blowout_rotation: 'Blowout rotation', blowout_rotation_risk: 'Blowout rotation risk', committee_risk: 'Committee backfield risk',
  coverage: 'Coverage', designed_rush_share: 'Designed QB runs', efficiency: 'Efficiency', expected_pass_volume: 'Pass volume',
  expected_snaps: 'Snaps', opponent: 'Opponent', opponent_run_defense: 'Opponent run defense', route_participation: 'Routes run',
  sack_treatment_platform_rules: 'Sack scoring rules', scramble_rate: 'Scramble rate', talent_matchup: 'Talent matchup',
  talent_mismatch: 'Talent gap', talent_ol_mismatch: 'Offensive line mismatch', target_share: 'Target share',
  // Shared across sports
  environment: 'Game environment', expected_volume_environment: 'Expected volume', form_history: 'Recent form',
  role_opportunity: 'Role and opportunity', stability_risk: 'Consistency', game_environment: 'Game environment',
  overall_usage: 'Usage', usage: 'Usage', role: 'Role', opponent_quality: 'Opponent quality', recent_form: 'Recent form',
  recent_usage: 'Recent usage', team_strength: 'Team strength', style_matchup: 'Style matchup', fatigue: 'Fatigue',
  tournament_context: 'Tournament context',
  // Basketball (more)
  ball_handling_role: 'Ball-handling role', ft_opportunity: 'Free throw chances', rebound_chance_share: 'Share of rebound chances',
  role_injuries: 'Teammate injuries', teammate_shooting: 'Teammate shooting',
  // MLB (more)
  hook_risk: 'Early-exit risk', lineup_protection: 'Lineup protection', park: 'Ballpark', pitch_mix_matchup: 'Pitch mix matchup',
  pitcher_hr_susceptibility: 'Pitcher home runs allowed', pitcher_walk_rate: 'Pitcher walk rate',
  // NHL
  expected_ice_time: 'Ice time', expected_shots_against: 'Shots against', goalie_start_confirmation: 'Goalie start confirmed',
  ice_time: 'Ice time', line_assignment: 'Line assignment', opponent_goalie: 'Opponent goalie', opponent_shot_rate: 'Opponent shot rate',
  opponent_shot_suppression: 'Opponent shot suppression', power_play_role: 'Power-play role', recent_involvement: 'Recent involvement',
  team_defense: 'Team defense',
  // Tennis, table tennis and badminton
  ace_rate: 'Ace rate', current_form: 'Current form', df_rate: 'Double fault rate', early_match_tendencies: 'Early-match tendencies',
  expected_competitiveness: 'Expected competitiveness', expected_return_games: 'Return games', expected_service_games: 'Service games',
  expected_set_competitiveness: 'Set competitiveness', form: 'Form', h2h_matchup: 'Head-to-head', match_length: 'Match length',
  match_pressure: 'Match pressure', opening_game_competitiveness: 'Opening game competitiveness', opening_return_strength: 'Early return strength',
  opening_serve_strength: 'Early serve strength', opponent_return_profile: 'Opponent return game', opponent_serve_weakness: 'Opponent serve weakness',
  opponent_strength: 'Opponent strength', player_strength_gap: 'Strength gap', ranking: 'Ranking', ranking_differential: 'Ranking gap',
  ranking_gap: 'Ranking gap', recent_competitiveness: 'Recent competitiveness', recent_first_game_history: 'Recent first games',
  recent_match_length: 'Recent match length', recent_serve_stability: 'Serve consistency', return_pressure: 'Return pressure',
  return_quality: 'Return quality', seeding: 'Seeding', serve_hold_environment: 'Serve holds', serve_return_balance: 'Serve/return balance',
  serve_return_differential: 'Serve/return gap', serve_return_style: 'Serve and return style', set_competitiveness: 'Set competitiveness',
  straight_game_probability: 'Straight-games chance', straight_set_probability: 'Straight-sets chance', surface: 'Court surface',
  surface_adjusted_strength: 'Strength on this surface', three_set_probability: 'Three-set chance', tiebreak_probability: 'Tiebreak chance',
  tournament_level: 'Tournament level', tournament_round: 'Tournament round',
  // Handball
  historical_assist_rate: 'Recent assist rate', penalty_set_piece_role: 'Penalty and set-piece role', playmaking_role: 'Playmaking role',
  // Esports
  champion_meta: 'Champion meta', duration: 'Game length', expected_kills: 'Expected kills', expected_placement: 'Expected placement',
  expected_round_volume: 'Rounds', farm_priority: 'Farm priority', fight_frequency: 'Fight frequency', form_rating: 'Form rating',
  hero: 'Hero', historical_hs_pct: 'Headshot rate', kill_participation: 'Kill participation', kill_share: 'Kill share',
  map_series_environment: 'Maps and series', map_volume: 'Maps played', match_duration: 'Match length', player_role: 'Player role',
  position: 'Position', recent_hs_stability: 'Headshot consistency', role_agent: 'Agent role', role_weapon_profile: 'Weapon role',
  round_volume: 'Rounds', team_fight_participation: 'Team fight participation', team_kill_expectation: 'Expected team kills',
  team_kills: 'Team kills', team_strength_series_script: 'Team strength and series script', tournament_format: 'Tournament format',
  // Shared
  stability: 'Consistency', evidence_quality: 'Evidence quality',
  // Adjustments applied to the exact line
  partial_coverage_adjustment: 'Scaled for unmeasured factors', context_score_clamp: 'Context limit',
  threshold_cushion: 'Room between projection and line', variance: 'Outcome spread', evidence: 'Evidence quality',
  demon_tax: 'Demon difficulty', high_variance_market: 'High-variance market', blowout: 'Blowout risk',
  adversarial_risk: 'Open risks', score_clamp: 'Score limit',
};

const acronyms: Readonly<Record<string, string>> = { qb: 'QB', rb: 'RB', ft: 'FT', hr: 'HR', pa: 'PA', hs: 'HS',
  ol: 'OL', df: 'DF', adot: 'aDOT', h2h: 'H2H', obp: 'OBP', k: 'K', hrrbi: 'H+R+RBI' };

/** Readable label for any score component key. */
export function factorLabel(key: string): string {
  if (factorLabels[key]) return factorLabels[key];
  const words = key.split('_').filter(Boolean).map((word) => acronyms[word] ?? word);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const lineAdjustmentNames = new Set(['threshold_cushion', 'variance', 'evidence', 'demon_tax',
  'high_variance_market', 'blowout', 'adversarial_risk', 'score_clamp']);

export type BreakdownRow = { key: string; label: string; value: string; measured: boolean; contribution: number;
  weight: number | null; detail: string | null };

const round1 = (value: number) => Math.round(value * 10) / 10;
const pretty = (value: number) => Math.abs(value) >= 10 ? round1(value).toFixed(1)
  : Math.abs(value) >= 1 ? round1(value).toFixed(1) : value.toFixed(2);

/** Turns one score component into a readable row without changing its numbers. Uses the structured
 * fields when the server sends them, and reads older saved boards from the explanation text. */
export function describeComponent(component: Component): BreakdownRow {
  const textWeight = /weight (\d+(?:\.\d+)?)/.exec(component.explanation);
  const textObserved = /Observed (-?[\d.]+) versus reference (-?[\d.]+)/.exec(component.explanation);
  const weight = component.weight ?? (textWeight ? Number(textWeight[1]) : null);
  const observed = component.observed ?? (textObserved ? Number(textObserved[1]) : null);
  const reference = component.reference ?? (textObserved ? Number(textObserved[2]) : null);
  const missing = component.measured === false || (component.measured === undefined &&
    /No current attributed metric/.test(component.explanation));
  let detail: string | null = null;
  if (observed !== null && reference !== null) {
    const change = reference ? (observed - reference) / Math.abs(reference) : null;
    detail = `Recent ${pretty(observed)} vs usual ${pretty(reference)}` +
      (change === null ? '' : ` (${change >= 0 ? '+' : ''}${Math.round(change * 100)}%)`) +
      (component.favorsBelowReference ? ' · lower helps this LESS pick' : '');
  } else if (component.name === 'partial_coverage_adjustment') {
    detail = 'Measured factors scaled up to cover the ones without data';
  } else if (!missing && weight === null) {
    detail = component.explanation.replace(/(\d+\.\d{3,})/g, (match) => pretty(Number(match)));
  }
  const contribution = round1(component.contribution);
  const signedValue = `${contribution > 0 ? '+' : ''}${contribution.toFixed(1)}`;
  return { key: component.name, label: factorLabel(component.name), measured: !missing,
    value: missing ? 'Not measured' : weight !== null ? `${signedValue} of ${weight}` : signedValue,
    contribution, weight, detail };
}

/** Context rows and exact-line adjustment rows that add up to the GKR score. */
export function scoreBreakdown(analysis: Analysis): { context: BreakdownRow[]; adjustments: BreakdownRow[];
  contextTotal: number; adjustmentTotal: number } {
  const parts = analysis.scoreBreakdown.length ? analysis.scoreBreakdown
    : [...(analysis.contextBreakdown ?? []), ...(analysis.lineAdjustments ?? [])];
  const rows = parts.map(describeComponent);
  const isAdjustment = (component: Component) => component.kind ? component.kind === 'LINE_ADJUSTMENT' ||
    component.kind === 'CLAMP' : lineAdjustmentNames.has(component.name);
  const context = rows.filter((_row, index) => !isAdjustment(parts[index]));
  const adjustments = rows.filter((row, index) => isAdjustment(parts[index]) && row.contribution !== 0);
  const sum = (items: BreakdownRow[]) => round1(items.reduce((total, row) => total + row.contribution, 0));
  return { context, adjustments, contextTotal: sum(context), adjustmentTotal: sum(adjustments) };
}
