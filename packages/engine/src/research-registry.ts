import type { Evidence, PropLine, Sport } from '@crowniq/contracts';
import { marketDefinitions } from './models/definitions.js';

// Research routing is deliberately independent of projections and pick scoring.
// Source identifiers are policy labels, not claims that a source has been consulted.
export type EvidenceTier = 'REQUIRED' | 'IMPORTANT' | 'OPTIONAL';
export interface ResearchField {
  readonly kind: string;
  readonly tier: EvidenceTier;
  readonly ttlHours: number;
  readonly components: readonly string[];
}
export interface ResearchPolicy {
  readonly sport: Sport;
  readonly market: string;
  readonly sources: readonly string[];
  readonly fields: readonly ResearchField[];
  readonly version: string;
}
export interface ResearchRoute {
  readonly policy: ResearchPolicy;
  readonly modelVersion: string | null;
  readonly sources: readonly { id: string; reason: string }[];
  readonly status: 'READY' | 'DOWNGRADED' | 'PASS';
  readonly reasonCode: string | null;
  readonly evidence: readonly Evidence[];
  readonly missing: readonly string[];
  readonly stale: readonly string[];
  readonly effects: readonly { kind: string; tier: EvidenceTier; components: readonly string[];
    evidenceId: string | null; state: 'FRESH' | 'MISSING' | 'STALE' | 'NEGATIVE' }[];
}

const field = (kind: string, component: string | readonly string[], tier: EvidenceTier,
  ttlHours: number): ResearchField => ({ kind, tier, ttlHours,
    components: typeof component === 'string' ? [component] : component });
const r = (kind: string, component: string | readonly string[], ttl = 3) =>
  field(kind, component, 'REQUIRED', ttl);
const i = (kind: string, component: string | readonly string[], ttl = 72) =>
  field(kind, component, 'IMPORTANT', ttl);
const o = (kind: string, component: string | readonly string[], ttl = 168) =>
  field(kind, component, 'OPTIONAL', ttl);
const define = (sport: Sport, market: string, sources: string[], fields: ResearchField[]): ResearchPolicy =>
  ({ sport, market, sources, fields, version: 'CROWNIQ-RESEARCH-1' });

export const researchPolicies: readonly ResearchPolicy[] = [
  define('NHL','shots_on_goal',['NHL_STATS','NHL_TEAM_STATUS','NHL_LINES','NHL_ADVANCED'],[
    r('status:player_active','stability',3),r('status:line_confirmed','line_assignment',3),
    r('metric:expected_ice_time','expected_ice_time',3),
    i('metric:shot_volume','shot_volume'),i('metric:sog_60','shot_volume'),
    i('metric:power_play_role','power_play_role',6),
    i('metric:opponent_shot_suppression','opponent_shot_suppression'),
    i('status:role_change','stability',6),
    o('metric:expected_goals','shot_volume'),o('metric:shot_attempts','shot_volume'),
    o('status:opposing_goalie','game_environment',3)]),
  define('NHL','saves',['NHL_TEAM_STATUS','NHL_STATS','NHL_ADVANCED'],[
    r('status:starting_goalie','goalie_start_confirmation',2),
    i('metric:opponent_shots_on_target','expected_shots_against'),
    i('metric:team_defense','team_defense'),i('metric:game_script','game_script')]),
  define('WNBA','player_points_rebounds_assists',['WNBA_INJURY','WNBA_STATS','BASKETBALL_ADVANCED','BASKETBALL_GAME_LOG'],[
    r('status:player_active','stability',3),r('status:lineup_confirmed','minutes',3),
    r('status:minutes_confirmed','minutes',3),
    i('metric:overall_usage','overall_usage',6),i('metric:scoring_opportunity','scoring_opportunity',6),
    i('metric:rebounding_opportunity','rebounding_opportunity',6),
    i('metric:assist_opportunity','assist_opportunity',6),
    i('metric:game_environment','game_environment',6),
    o('metric:opponent_pace','game_environment')]),
  define('MLB','batter_fantasy_score',['MLB_LINEUP','MLB_PITCHER','BASEBALL_SAVANT','FANGRAPHS','NWS_WEATHER'],[
    r('status:starting_lineup',['expected_pa','stability'],2),
    r('status:starting_pitcher','pitcher_matchup',3),
    i('metric:expected_pa','expected_pa',3),i('metric:lineup_position','lineup_position',3),
    i('metric:handedness','pitcher_matchup',24),i('metric:walk_rate','role_opportunity'),
    i('metric:contact_quality','form_history'),i('metric:power','role_opportunity'),
    i('metric:park','expected_volume_environment'),i('metric:weather','expected_volume_environment',3),
    o('metric:bullpen','matchup')]),
  define('MLB','pitcher_strikeouts',['MLB_PITCHER','MLB_LINEUP','BASEBALL_SAVANT','FANGRAPHS','NWS_WEATHER'],[
    r('status:starting_pitcher','stability',3),
    i('metric:expected_batters_faced','expected_batters_faced',6),
    i('metric:pitch_count_innings','pitch_count_innings',6),
    i('metric:pitcher_k_rate','pitcher_k_rate'),i('metric:opponent_k_rate','opponent_k_rate'),
    i('metric:pitch_mix_matchup','pitch_mix_matchup'),i('metric:hook_risk','hook_risk',6),
    o('metric:weather','environment',3)]),
  define('TENNIS','total_games',['ATP_WTA','ITF','TENNIS_ABSTRACT','TENNIS_HISTORY'],[
    r('status:tournament_confirmed','tournament_context',24),
    r('status:tournament_round','tournament_context',24),
    r('status:surface_confirmed','surface',24),
    r('status:opponent_confirmed','expected_competitiveness',24),
    r('status:match_format','three_set_probability',24),
    i('metric:ranking_gap','expected_competitiveness'),
    i('metric:serve_hold_environment','serve_hold_environment'),
    i('metric:three_set_probability','three_set_probability'),
    i('metric:fatigue','fatigue',24),o('metric:recent_form','style_matchup')]),
  define('TENNIS','player_fantasy_points',['ATP_WTA','ITF','TENNIS_ABSTRACT','TENNIS_HISTORY'],[
    r('status:match_format','role_opportunity',24),
    i('fantasy_scenarios','expected_volume_environment',24),
    i('metric:expected_games','expected_volume_environment'),
    o('metric:ace_rate','form_history')]),
  define('SOCCER','passes_attempted',['SOCCER_LINEUP','SOCCER_STATS','SOCCER_TACTICS'],[
    r('status:starting_lineup','minutes',2),r('status:tactical_role','role',3),
    i('metric:passes_per_90','pass_volume'),i('metric:expected_minutes','minutes',3),
    i('metric:team_possession','possession_environment'),
    i('metric:opponent_press','opponent_style'),i('metric:game_script','game_script',6)]),
  define('SOCCER','goalie_saves',['SOCCER_LINEUP','SOCCER_STATS','SOCCER_TACTICS'],[
    r('status:starting_goalie','stability',2),
    i('metric:opponent_shots_on_target','opponent_volume'),
    i('metric:team_possession','game_script'),i('metric:team_defense','team_defense')]),
  define('NCAAFB','passing_yards',['TEAM_STATUS','NCAA_STATS','NCAAFB_MATCHUP','NWS_WEATHER'],[
    r('status:qb_available','stability',3),i('metric:expected_attempts','expected_attempts',6),
    i('metric:opponent','opponent'),i('metric:efficiency','efficiency'),
    i('metric:blowout_rotation_risk','blowout_rotation_risk',6),
    i('metric:game_script','game_script',6),o('metric:weather','efficiency',3)]),
  define('NCAAFB','anytime_td',['TEAM_STATUS','NCAA_STATS','NCAAFB_MATCHUP'],[
    r('status:player_active','stability',3),r('status:goal_line_role','role',6),
    i('metric:red_zone_carries','opportunity'),i('metric:team_scoring_environment','environment'),
    i('metric:teammate_td_competition','competition'),i('metric:game_script','game_script',6)]),
  define('LOL','map_1_kills',['ESPORTS_EVENT','ESPORTS_ROSTER','LOL_MATCH_STATS'],[
    r('status:roster_confirmed','stability',6),r('status:role_confirmed','role',6),
    r('status:series_format','duration',24),i('metric:team_kill_expectation','team_kill_expectation'),
    i('metric:kill_share','kill_share'),i('metric:match_duration','match_duration'),
    o('metric:champion_meta','champion_meta')]),
  define('VALORANT','kills',['ESPORTS_EVENT','ESPORTS_ROSTER','VALORANT_MATCH_STATS'],[
    r('status:roster_confirmed','stability',6),r('status:role_confirmed','role_agent',6),
    r('status:series_format','map_series_environment',24),
    i('metric:round_volume','round_volume'),i('metric:kills_per_round','kill_share'),
    i('metric:map_pool','map_series_environment'),o('metric:opponent','opponent')]),
  define('VALORANT','first_bloods',['ESPORTS_EVENT','ESPORTS_ROSTER','VALORANT_MATCH_STATS'],[
    r('status:roster_confirmed','stability',6),r('status:role_confirmed','role_agent',6),
    r('status:series_format','round_volume',24),
    i('metric:first_kills_per_round','entry_opportunity'),
    i('metric:first_deaths_per_round','entry_risk'),
    i('metric:round_volume','round_volume'),o('metric:team_style','entry_opportunity')]),
  define('CS2','maps_1_2_kills',['ESPORTS_EVENT','ESPORTS_ROSTER','CS2_MATCH_STATS'],[
    r('status:roster_confirmed','stability',6),r('status:series_format','expected_round_volume',24),
    i('metric:expected_round_volume','expected_round_volume'),
    i('metric:kill_share','kill_share'),i('metric:role','role'),
    i('metric:kills_per_round','form_rating'),o('metric:adr','form_rating')]),
  define('CS2','headshots',['ESPORTS_EVENT','ESPORTS_ROSTER','CS2_MATCH_STATS'],[
    r('status:roster_confirmed','stability',6),
    i('metric:expected_kills','expected_kills'),i('metric:historical_hs_pct','historical_hs_pct'),
    i('metric:round_volume','round_volume'),o('metric:role_weapon_profile','role_weapon_profile')]),
  define('HANDBALL','goals',['HANDBALL_EVENT','HANDBALL_TEAM_STATUS','HANDBALL_STATS'],[
    r('status:player_active','stability',6),r('status:role_confirmed','role',6),
    i('metric:shot_volume','shot_volume'),i('metric:penalty_set_piece_role','penalty_set_piece_role',6),
    i('metric:shooting_pct','recent_usage'),i('metric:minutes','minutes',6),
    o('metric:opponent_defense','opponent_defense')]),
  define('AFL','disposals',['AFL_TEAM_SELECTION','AFL_STATS','AFL_ROLE'],[
    r('status:player_active','stability',6),i('metric:time_on_ground','minutes',6),
    i('metric:midfield_role','role',6),i('metric:center_bounce_usage','role',6),
    i('metric:recent_disposals','form_history'),o('metric:opponent_possession','environment')]),
  define('DARTS','one_eighties',['DARTS_EVENT','DARTS_STATS'],[
    r('status:match_format','expected_legs',24),r('status:event_confirmed','stability',24),
    i('metric:one_eighties_per_leg','rate'),i('metric:expected_legs','expected_legs',6),
    o('metric:first_nine_average','form_history')]),
  define('DARTS','first_leg_checkout_total',['DARTS_EVENT','DARTS_STATS'],[
    r('status:match_format','stability',24),
    r('metric:first_leg_checkout_distribution','distribution',72),
    i('metric:throw_order','game_script',6),o('metric:overall_checkout_pct','form_history')]),
  define('KBO','pitcher_strikeouts',['KBO_STARTERS','KBO_STATS','KBO_MATCHUP'],[
    r('status:starting_pitcher','stability',3),
    i('metric:expected_batters_faced','expected_batters_faced',6),
    i('metric:pitch_count_innings','pitch_count_innings',6),
    i('metric:pitcher_k_rate','pitcher_k_rate'),i('metric:opponent_k_rate','opponent_k_rate'),
    i('metric:hook_risk','hook_risk',6)]),
  define('KBO','batter_fantasy_score',['KBO_LINEUP','KBO_STARTERS','KBO_STATS'],[
    r('status:starting_lineup','expected_pa',2),r('status:starting_pitcher','matchup',3),
    i('fantasy_scenarios','expected_volume_environment',24),
    i('metric:kbo_baseline','form_history')]),
  define('KBO','pitcher_fantasy_score',['KBO_STARTERS','KBO_STATS'],[
    r('status:starting_pitcher','stability',3),i('fantasy_scenarios','expected_volume_environment',24),
    i('metric:kbo_baseline','form_history')]),
  define('NHL','season_goals',['NHL_ROSTER','NHL_STATS','NHL_TEAM_STATUS','NHL_ADVANCED'],[
    r('status:season_roster','stability',168),r('status:season_role','role',168),
    i('metric:expected_games','volume',168),i('metric:shot_volume','volume',168),
    i('metric:shooting_regression','efficiency',168),i('metric:power_play_role','role',168),
    o('metric:prior_seasons','form_history',720)]),
  define('NHL','season_points',['NHL_ROSTER','NHL_STATS','NHL_TEAM_STATUS','NHL_ADVANCED'],[
    r('status:season_roster','stability',168),r('status:season_role','role',168),
    i('metric:expected_games','volume',168),i('metric:development_curve','efficiency',168),
    i('metric:power_play_role','role',168),o('metric:teammate_quality','environment',168)]),
  define('NHL','season_goalie_wins',['NHL_ROSTER','NHL_STATS','NHL_TEAM_STATUS'],[
    r('status:projected_starter_role','opportunity',168),
    i('metric:expected_starts','opportunity',168),i('metric:team_strength','environment',168),
    i('metric:goalie_share','opportunity',168),o('metric:backup_competition','stability',168)]),
];

function applicableSources(policy: ResearchPolicy, line: PropLine): string[] {
  if (line.sport !== 'TENNIS') return [...policy.sources];
  const itf = /\bITF\b/i.test(line.league);
  return policy.sources.filter((source) => source !== (itf ? 'ATP_WTA' : 'ITF'));
}

export function researchPolicyFor(line: Pick<PropLine,'sport'|'market'>): ResearchPolicy | null {
  return researchPolicies.find((policy) => policy.sport === line.sport &&
    policy.market === line.market.toLowerCase()) ?? null;
}

const authority = (item: Evidence, sources: readonly string[]) => {
  const named = sources.indexOf(item.sourceName);
  return named < 0 ? 100 + { OFFICIAL: 0, LICENSED_FEED: 10,
    PUBLIC: 20, AI_STRUCTURED: 30 }[item.sourceType] : named;
};

/** Explain the chosen sources, evidence-to-component links, freshness, and missing-data decision. */
export function routeResearch(line: PropLine, candidates: readonly Evidence[], now: Date): ResearchRoute | null {
  const policy = researchPolicyFor(line);
  if (!policy) return null;
  const sources = applicableSources(policy, line);
  const scoped = candidates.filter((item) => item.eventId === line.eventId &&
    (item.entityType === 'EVENT' || (item.entityType === 'PLAYER' && item.entityId === line.playerId) ||
      (item.entityType === 'TEAM' && item.entityId === line.team)) &&
    (item.market === null || item.market === line.market));
  const missing: string[] = [], stale: string[] = [], selected: Evidence[] = [];
  let requiredFailure = false, degraded = false, negative = false;
  const effects = policy.fields.map((item) => {
    const matches = scoped.filter((candidate) => candidate.kind === item.kind);
    const fresh = matches.filter((candidate) => Date.parse(candidate.retrievedAt) <= now.getTime() &&
      Date.parse(candidate.retrievedAt) < Date.parse(line.eventStartTime) &&
      Math.min(Date.parse(candidate.expiresAt), Date.parse(candidate.retrievedAt) +
        item.ttlHours * 3_600_000) > now.getTime());
    const best = fresh.sort((a,b) => authority(a,sources) - authority(b,sources) ||
      Date.parse(b.retrievedAt) - Date.parse(a.retrievedAt))[0];
    if (!best) {
      (matches.length ? stale : missing).push(item.kind);
      if (item.tier === 'REQUIRED') requiredFailure = true;
      if (item.tier === 'IMPORTANT') degraded = true;
    } else {
      selected.push(best);
      if (item.tier === 'REQUIRED' && item.kind.startsWith('status:') &&
        best.numeric?.value !== 1) { requiredFailure = true; negative = true; }
    }
    return { kind: item.kind, tier: item.tier, components: item.components,
      evidenceId: best?.id ?? null,
      state: best ? negative && item.tier === 'REQUIRED' && item.kind.startsWith('status:') &&
        best.numeric?.value !== 1 ? 'NEGATIVE' as const : 'FRESH' as const :
        matches.length ? 'STALE' as const : 'MISSING' as const };
  });
  const definition = marketDefinitions.find((item) => item.sport === line.sport &&
    item.market === line.market);
  return { policy, modelVersion: definition?.version ?? null,
    sources: sources.map((id) => ({ id,
      reason: `Policy ${policy.version} prioritizes ${id} for ${line.sport} ${line.market}.` })),
    status: requiredFailure ? 'PASS' : degraded ? 'DOWNGRADED' : 'READY',
    reasonCode: negative ? 'NEGATIVE_REQUIRED_STATUS' : requiredFailure ? 'REQUIRED_EVIDENCE_MISSING' :
      degraded ? 'IMPORTANT_EVIDENCE_MISSING' : null,
    evidence: selected, missing, stale, effects };
}
