import type { Family, VarianceModel } from './distributions.js';

/** Historical game row shape shared with the API's internal-history store. */
export interface StatRow {
  readonly occurredAt: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly marketValues?: Readonly<Record<string, number>>;
}

type Pick = (metrics: Readonly<Record<string, number>>) => number | null;

export interface StatSpec {
  /** Market outcome for one game. */
  readonly value: Pick;
  /** Opportunity measure (minutes, snaps, PA, batters faced). A row with zero opportunity
   * is a DNP/inactive game and is excluded rather than averaged in as a zero. */
  readonly opportunity?: Pick;
}

export interface MarketProfile {
  readonly family: Family;
  readonly variance: VarianceModel;
  readonly discrete: boolean;
  readonly stat?: StatSpec;
}

const get = (key: string): Pick => (m) => Number.isFinite(m[key]) ? m[key] : null;
const total = (...keys: string[]): Pick => (m) =>
  keys.every((key) => Number.isFinite(m[key])) ? keys.reduce((sum, key) => sum + m[key], 0) : null;

const nb = (psi: number, stat?: StatSpec): MarketProfile =>
  ({ family: 'NEGBIN', variance: { phi: 1, psi }, discrete: true, stat });
const poisson = (stat?: StatSpec): MarketProfile =>
  ({ family: 'POISSON', variance: { phi: 1, psi: 0 }, discrete: true, stat });
const normal = (phi: number, psi: number, floor: number, stat?: StatSpec, discrete = true): MarketProfile =>
  ({ family: 'NORMAL', variance: { phi, psi, floor }, discrete, stat });

const minutes = get('minutes'), snaps = get('offensive_snaps'), pa = get('plate_appearances');
const basketball: Record<string, MarketProfile> = {
  player_points: nb(.045, { value: get('pts'), opportunity: minutes }),
  player_rebounds: nb(.08, { value: get('rebounds'), opportunity: minutes }),
  player_assists: nb(.1, { value: get('assists'), opportunity: minutes }),
  player_threes: nb(.15),
  player_blocks: nb(.2), player_steals: nb(.15), player_turnovers: nb(.12),
  player_blocks_steals: nb(.12),
  player_points_rebounds_assists: nb(.04, { value: total('pts', 'rebounds', 'assists'), opportunity: minutes }),
  player_points_rebounds: nb(.045, { value: total('pts', 'rebounds'), opportunity: minutes }),
  player_points_assists: nb(.05, { value: total('pts', 'assists'), opportunity: minutes }),
  player_rebounds_assists: nb(.06, { value: total('rebounds', 'assists'), opportunity: minutes }),
  player_fantasy_points: normal(2, .03, 4, undefined, false),
};

export const marketProfiles: Readonly<Record<string, MarketProfile>> = {
  ...Object.fromEntries(Object.entries(basketball).map(([key, value]) => ['NBA:' + key, value])),
  ...Object.fromEntries(Object.entries(basketball).map(([key, value]) => ['WNBA:' + key, value])),
  'NFL:passing_yards': normal(0, .065, 100, { value: get('passing_yds'), opportunity: get('pass_attempts') }),
  'NFL:player_pass_attempts': nb(.03, { value: get('pass_attempts'), opportunity: snaps }),
  'NFL:player_pass_completions': nb(.03, { value: get('completions'), opportunity: get('pass_attempts') }),
  'NFL:player_pass_tds': nb(.05), 'NFL:player_pass_interceptions': poisson(),
  'NFL:player_rush_yds': normal(2, .25, 25, { value: get('rushing_yds'), opportunity: get('rushing_attempts') }),
  'NFL:player_rush_attempts': nb(.06, { value: get('rushing_attempts'), opportunity: snaps }),
  'NFL:player_reception_yds': normal(3, .3, 25, { value: get('receiving_yds'), opportunity: get('targets') }),
  'NFL:player_receptions': nb(.08, { value: get('receptions'), opportunity: snaps }),
  'NFL:player_receiving_targets': nb(.08, { value: get('targets'), opportunity: snaps }),
  'NFL:player_rush_reception_yds': normal(3, .2, 30),
  'NFL:player_pass_rush_yds': normal(0, .06, 100),
  'NFL:player_tackles_assists': nb(.1), 'NFL:player_solo_tackles': nb(.12),
  'NFL:player_sacks': nb(.3), 'NFL:player_kicking_points': nb(.08),
  'NFL:player_field_goals': nb(.1), 'NFL:player_pats': nb(.1),
  'NFL:player_rush_longest': normal(2, .3, 16), 'NFL:player_reception_longest': normal(2, .25, 16),
  'NFL:player_pass_longest_completion': normal(2, .12, 36),
  'NFL:player_fantasy_points': normal(3, .08, 9, undefined, false),
  'MLB:batter_hits': nb(.05, { value: get('hits'), opportunity: pa }),
  'MLB:batter_total_bases': nb(.35),
  'MLB:batter_hits_runs_rbis': nb(.25, { value: total('hits', 'runs', 'runs_batted_in'), opportunity: pa }),
  'MLB:batter_rbis': nb(.5), 'MLB:batter_runs_scored': nb(.25),
  'MLB:batter_walks': poisson({ value: get('walks'), opportunity: pa }),
  'MLB:batter_home_runs': poisson({ value: get('home_runs'), opportunity: pa }),
  'MLB:batter_strikeouts': nb(.05), 'MLB:batter_singles': nb(.05), 'MLB:batter_doubles': poisson(),
  'MLB:batter_stolen_bases': nb(.3),
  'MLB:pitcher_strikeouts': nb(.03, { value: get('strikeouts_pitched'), opportunity: get('batters_faced') }),
  'MLB:pitcher_hits_allowed': nb(.05), 'MLB:pitcher_walks': nb(.08), 'MLB:pitcher_earned_runs': nb(.25),
  'TENNIS:games_won': normal(.5, .01, 4),
  'MLB:pitcher_outs': normal(0, .025, 9),
  'MLB:batter_fantasy_score': normal(2, .2, 4, undefined, false),
  'MLB:pitcher_fantasy_score': normal(2, .06, 25, undefined, false),
  'NHL:shots_on_goal': nb(.05), 'NHL:points': nb(.1), 'NHL:player_goals': poisson(),
  'NHL:player_assists': nb(.1), 'NHL:player_total_saves': normal(1, .02, 9),
  'NHL:player_blocked_shots': nb(.15), 'NHL:player_power_play_points': poisson(),
  'NHL:player_fantasy_points': normal(2, .1, 4, undefined, false),
  'TENNIS:total_games': normal(.6, .012, 6), 'TENNIS:player_aces': nb(.15),
  'TENNIS:player_double_faults': nb(.2), 'TENNIS:first_set_total_games': normal(.3, .01, 2),
};

/** The board's market keys (scraped PrizePicks, Underdog, Pick6, SharpAPI) where they differ from the profile keys. */
const aliases: Readonly<Record<string, string>> = {
  'NHL:saves': 'NHL:player_total_saves', 'NHL:goals': 'NHL:player_goals', 'NHL:assists': 'NHL:player_assists',
  'NHL:blocked_shots': 'NHL:player_blocked_shots', 'NHL:power_play_points': 'NHL:player_power_play_points',
  'MLB:pitching_outs': 'MLB:pitcher_outs', 'MLB:rbis': 'MLB:batter_rbis', 'MLB:runs': 'MLB:batter_runs_scored',
  'MLB:hits_allowed': 'MLB:pitcher_hits_allowed', 'MLB:walks_allowed': 'MLB:pitcher_walks',
  'MLB:pitcher_earned_runs': 'MLB:pitcher_earned_runs', 'MLB:earned_runs': 'MLB:pitcher_earned_runs',
  'MLB:singles': 'MLB:batter_singles', 'MLB:doubles': 'MLB:batter_doubles', 'MLB:hitter_ks': 'MLB:batter_strikeouts',
  'MLB:sb': 'MLB:batter_stolen_bases', 'MLB:stolen_bases': 'MLB:batter_stolen_bases',
  'NFL:pass_plus_rush_yds': 'NFL:player_pass_rush_yds', 'NFL:rush_plus_rec_yds': 'NFL:player_rush_reception_yds',
  'NCAAFB:passing_yards': 'NFL:passing_yards', 'NCAAFB:player_rush_yds': 'NFL:player_rush_yds',
  'NCAAFB:player_reception_yds': 'NFL:player_reception_yds',
  'TENNIS:aces': 'TENNIS:player_aces', 'TENNIS:double_faults': 'TENNIS:player_double_faults',
};

export function profileFor(sport: string, market: string): MarketProfile {
  const exact = marketProfiles[sport + ':' + market] ?? marketProfiles[aliases[sport + ':' + market] ?? ''];
  if (exact) return exact;
  if (/yds|yards|longest/.test(market)) return normal(2, .2, 25);
  if (/fantasy/.test(market)) return normal(2, .06, 4, undefined, false);
  if (/saves|outs|total_games|total_points/.test(market)) return normal(1, .02, 6);
  if (/goals|home_runs|touchdown|_tds|aces/.test(market)) return nb(.15);
  return nb(.12);
}
