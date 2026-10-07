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
  /**
   * Scoring events (TDs, goals): a typical scorer's per-game rate and how many games it counts as. A player's short record is
   * blended toward it, so five games without a touchdown read as unlikely, not impossible.
   */
  readonly prior?: { readonly mean: number; readonly games: number };
}

/**
 * Scoring-event markets (anytime TDs, goals): the app's 0.5 line is the only line these bets can have, not a coin flip, so
 * it is never read as one, and the team's expected scoring moves them in full.
 */
export const scoringMarket = (market: string) =>
  /anytime|(^|_)tds?$|rush_tds|rec_tds|reception_tds|touchdown|goal_scorer|(^|_)goals$|goal_plus_assist/.test(market);

const get = (key: string): Pick => (m) => Number.isFinite(m[key]) ? m[key] : null;
const total = (...keys: string[]): Pick => (m) =>
  keys.every((key) => Number.isFinite(m[key])) ? keys.reduce((sum, key) => sum + m[key], 0) : null;

const nb = (psi: number, stat?: StatSpec): MarketProfile =>
  ({ family: 'NEGBIN', variance: { phi: 1, psi }, discrete: true, stat });
const poisson = (stat?: StatSpec): MarketProfile =>
  ({ family: 'POISSON', variance: { phi: 1, psi: 0 }, discrete: true, stat });
/** A scoring event: Poisson, blended toward a typical scorer's rate (`mean` per game, worth `games` games). */
const scoring = (mean: number, games: number, stat?: StatSpec): MarketProfile => ({ ...poisson(stat), prior: { mean, games } });
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
  // Scoring events. Typical skill-position rates: about 0.3 rush+rec TDs a game; priors count as 4 games.
  'NFL:anytime_tds': scoring(.3, 4, { value: total('rushing_tds', 'receiving_tds'), opportunity: snaps }),
  'NFL:player_rush_tds': scoring(.2, 4, { value: get('rushing_tds'), opportunity: snaps }),
  'NFL:player_reception_tds': scoring(.2, 4, { value: get('receiving_tds'), opportunity: snaps }),
  // Soccer: a typical attacker scores about 0.25 a match and assists about 0.15.
  'SOCCER:goals': scoring(.25, 4), 'SOCCER:assists': scoring(.15, 4), 'SOCCER:goal_plus_assist': scoring(.4, 4),
  'SOCCER:shots': nb(.12), 'SOCCER:sot': nb(.15), 'SOCCER:fouls': nb(.12),
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
  'NHL:shots_on_goal': nb(.05), 'NHL:points': nb(.1), 'NHL:player_goals': scoring(.25, 4),
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
  // Market audit (2026-10-06): PrizePicks' short stat labels as the scraper stores them.
  'TENNIS:total_games_won': 'TENNIS:games_won', 'NCAAFB:pass_plus_rush_yds': 'NFL:player_pass_rush_yds',
  'WNBA:3ptm': 'WNBA:player_threes', 'WNBA:pra': 'WNBA:player_points_rebounds_assists',
  'NBA:3ptm': 'NBA:player_threes', 'NBA:pra': 'NBA:player_points_rebounds_assists',
  'MLB:earned_runs_allowed': 'MLB:pitcher_earned_runs', 'MLB:po': 'MLB:pitcher_outs',
  'NFL:longest_rec': 'NFL:player_reception_longest', 'NFL:longest_rush': 'NFL:player_rush_longest',
  'NFL:int': 'NFL:player_pass_interceptions', 'NFL:fg_made': 'NFL:player_field_goals',
  'NFL:rush_rec_tds': 'NFL:anytime_tds', 'NFL:rush_plus_rec_tds': 'NFL:anytime_tds', 'NFL:rush_tds': 'NFL:player_rush_tds',
  'NFL:rec_tds': 'NFL:player_reception_tds', 'NFL:receiving_tds': 'NFL:player_reception_tds',
  'NCAAFB:anytime_tds': 'NFL:anytime_tds', 'NCAAFB:rush_tds': 'NFL:player_rush_tds', 'NCAAFB:rec_tds': 'NFL:player_reception_tds',
  'SOCCER:shots_on_target': 'SOCCER:sot', 'SOCCER:goals_plus_assists': 'SOCCER:goal_plus_assist',
  ...Object.fromEntries(Object.entries({ recs: 'player_receptions', player_receptions: 'player_receptions',
    pass_tds: 'player_pass_tds', player_pass_tds: 'player_pass_tds', rush_atts: 'player_rush_attempts',
    player_rush_attempts: 'player_rush_attempts', pass_attempts: 'player_pass_attempts', player_pass_attempts: 'player_pass_attempts',
    pass_comp: 'player_pass_completions', longest_rec: 'player_reception_longest', player_reception_longest: 'player_reception_longest',
    longest_rush: 'player_rush_longest', player_rush_longest: 'player_rush_longest', longest_completion: 'player_pass_longest_completion',
    player_pass_longest_completion: 'player_pass_longest_completion', int: 'player_pass_interceptions',
    player_pass_interceptions: 'player_pass_interceptions', kicking_points: 'player_kicking_points',
    player_kicking_points: 'player_kicking_points', pat_made: 'player_pats', player_pats: 'player_pats', fg_made: 'player_field_goals',
    player_fantasy_points: 'player_fantasy_points', player_pass_rush_yds: 'player_pass_rush_yds',
    rush_plus_rec_yds: 'player_rush_reception_yds', player_rush_reception_yds: 'player_rush_reception_yds' })
    .map(([board, profile]) => [`NCAAFB:${board}`, `NFL:${profile}`])),
};

// Learned variance functions (spec §2.1), keyed by the profile's sport:market. Set from the API's dispersion file.
let learned: ReadonlyMap<string, { phi: number; psi: number }> = new Map();
const learnedProfiles = new Map<string, MarketProfile>();

/** Replaces the learned variance functions used by `profileFor` (empty map = the hand-set defaults). */
export function setLearnedDispersion(fits: ReadonlyMap<string, { phi: number; psi: number }>): void {
  learned = fits; learnedProfiles.clear();
}

/** The profile key `profileFor` resolves a board market to, or null for the generic fallbacks. */
export function profileKey(sport: string, market: string): string | null {
  const key = sport + ':' + market;
  return marketProfiles[key] ? key : marketProfiles[aliases[key] ?? ''] ? aliases[key]! : null;
}

export function profileFor(sport: string, market: string): MarketProfile {
  const key = profileKey(sport, market);
  if (key) {
    const fit = learned.get(key), base = marketProfiles[key]!;
    if (!fit) return base;
    let profile = learnedProfiles.get(key);
    if (!profile) learnedProfiles.set(key, profile = { ...base, variance: { ...base.variance, phi: fit.phi, psi: fit.psi } });
    return profile;
  }
  // Shapes the generic count model gets wrong (market audit 2026-10-06): plus/minus goes negative, time on ice and rate stats
  // are continuous with a narrow spread, and high-volume counts are far less dispersed than a ψ of 0.12 says.
  if (/plus_minus/.test(market)) return normal(0, 0, 1.5);
  if (/time_on_ice|^minutes$/.test(market)) return normal(0, 0, 6, undefined, false);
  if (/percentage/.test(market)) return normal(0, .015, 9, undefined, false);
  if (/per_carry|per_attempt|per_reception/.test(market)) return normal(0, .25, 1, undefined, false);
  if (/attempts|atts|pitches|kills|passes|comp\b|completions|headshots|faceoffs|batters_faced|plate_appearances|strikes_counted|balls_counted|first_bloods|rebounds|tackles|clearances/.test(market)) return nb(.03);
  if (/yds|yards|longest/.test(market)) return normal(2, .2, 25);
  if (/fantasy/.test(market)) return normal(2, .06, 4, undefined, false);
  if (/saves|outs|total_games|total_points/.test(market)) return normal(1, .02, 6);
  if (/goals|home_runs|touchdown|_tds|aces/.test(market)) return nb(.15);
  return nb(.12);
}
