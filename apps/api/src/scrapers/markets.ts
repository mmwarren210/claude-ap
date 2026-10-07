import type { Sport } from '@crowniq/contracts';
import type { DfsApp, ScrapedLine } from './scraped-line.js';
import { canonicalMarket } from '../edge/market-map.js';

/** PrizePicks league labels to CrownIQ sports and the matching Odds API sport keys (keeps player ids identical). */
export const leagues: Readonly<Record<string, { sport: Sport; key: string }>> = {
  NFL: { sport: 'NFL', key: 'americanfootball_nfl' }, CFB: { sport: 'NCAAFB', key: 'americanfootball_ncaaf' },
  MLB: { sport: 'MLB', key: 'baseball_mlb' }, NBA: { sport: 'NBA', key: 'basketball_nba' },
  WNBA: { sport: 'WNBA', key: 'basketball_wnba' }, NHL: { sport: 'NHL', key: 'icehockey_nhl' },
  SOCCER: { sport: 'SOCCER', key: 'soccer' }, TENNIS: { sport: 'TENNIS', key: 'tennis' },
  CS2: { sport: 'CS2', key: 'esports_cs2' }, VAL: { sport: 'VALORANT', key: 'esports_valorant' },
  LOL: { sport: 'LOL', key: 'esports_lol' }, DOTA2: { sport: 'DOTA', key: 'esports_dota2' },
  KBO: { sport: 'KBO', key: 'baseball_kbo' }, AFL: { sport: 'AFL', key: 'aussierules_afl' },
  CBB: { sport: 'NCAAB', key: 'basketball_ncaab' }, NCAAB: { sport: 'NCAAB', key: 'basketball_ncaab' },
  WCBB: { sport: 'NCAAW', key: 'basketball_wncaab' }, NCAAW: { sport: 'NCAAW', key: 'basketball_wncaab' },
  EUROLEAGUE: { sport: 'EUROLEAGUE', key: 'basketball_euroleague' },
  // Tennis and esports under the other labels apps use (all map to the same sport and player ids).
  ATP: { sport: 'TENNIS', key: 'tennis' }, WTA: { sport: 'TENNIS', key: 'tennis' },
  CS: { sport: 'CS2', key: 'esports_cs2' }, CSGO: { sport: 'CS2', key: 'esports_cs2' }, 'CS:GO': { sport: 'CS2', key: 'esports_cs2' },
  'COUNTER-STRIKE': { sport: 'CS2', key: 'esports_cs2' }, 'COUNTER STRIKE': { sport: 'CS2', key: 'esports_cs2' },
  'LEAGUE OF LEGENDS': { sport: 'LOL', key: 'esports_lol' }, DOTA: { sport: 'DOTA', key: 'esports_dota2' },
  'DOTA 2': { sport: 'DOTA', key: 'esports_dota2' }, VALORANT: { sport: 'VALORANT', key: 'esports_valorant' },
  // Soccer leagues PrizePicks lists under their own labels (market audit 2026-10-06: "LA LIGA" was landing in OTHER).
  ...Object.fromEntries(['LA LIGA', 'EPL', 'MLS', 'BUNDESLIGA', 'SERIE A', 'LIGUE 1', 'UCL', 'LIGA MX', 'UEFA']
    .map((league) => [league, { sport: 'SOCCER' as Sport, key: 'soccer' }])),
};

const basketball: Readonly<Record<string, string>> = { 'Points': 'player_points', 'Rebounds': 'player_rebounds',
  'Assists': 'player_assists', 'Pts+Rebs+Asts': 'player_points_rebounds_assists', 'Pts+Rebs': 'player_points_rebounds',
  'Pts+Asts': 'player_points_assists', 'Rebs+Asts': 'player_rebounds_assists', '3-PT Made': 'player_threes',
  'Fantasy Score': 'player_fantasy_points' };
/** PrizePicks stat labels to model market keys. Anything else keeps a plain key and simply has no model. */
const statKeys: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  NFL: { 'Pass Yards': 'passing_yards', 'Pass Attempts': 'player_pass_attempts', 'Pass Comp': 'player_pass_completions',
    'Pass Completions': 'player_pass_completions', 'Pass TDs': 'player_pass_tds', 'Rush Yards': 'player_rush_yds',
    'Rush Atts': 'player_rush_attempts', 'Rush Attempts': 'player_rush_attempts', 'Rec Yards': 'player_reception_yds',
    'Receiving Yards': 'player_reception_yds', 'Recs': 'player_receptions', 'Receptions': 'player_receptions',
    'Rec Targets': 'player_receiving_targets', 'Tackles+Ast': 'player_tackles_assists', 'Sacks': 'player_sacks',
    'Kicking Points': 'player_kicking_points', 'Punts': 'player_punts',
    'Completion Percentage': 'player_completion_percentage', 'Fantasy Score': 'player_fantasy_points' },
  NCAAFB: { 'Pass Yards': 'passing_yards', 'Rush Yards': 'player_rush_yds', 'Rec Yards': 'player_reception_yds',
    'Receiving Yards': 'player_reception_yds', 'Fantasy Score': 'player_fantasy_points' },
  MLB: { 'Hits+Runs+RBIs': 'batter_hits_runs_rbis', 'Hits': 'batter_hits', 'Walks': 'batter_walks',
    'Home Runs': 'batter_home_runs', 'Ks': 'pitcher_strikeouts', 'Pitcher Strikeouts': 'pitcher_strikeouts',
    'Hitter FS': 'batter_fantasy_score', 'Pitcher FS': 'pitcher_fantasy_score', 'TB': 'batter_total_bases',
    'Total Bases': 'batter_total_bases' },
  NBA: basketball, WNBA: basketball,
  NHL: { 'Shots On Goal': 'shots_on_goal', 'SOG': 'shots_on_goal', 'Points': 'points', 'Goalie Saves': 'saves',
    'Saves': 'saves', 'Fantasy Score': 'player_fantasy_points' },
};

const nflApps: Readonly<Record<string, string>> = { 'Receiving Yards': 'player_reception_yds',
  'Receptions': 'player_receptions', 'Longest Reception': 'player_reception_longest', 'Sacks': 'player_sacks',
  'Tackles + Assists': 'player_tackles_assists', 'Solo Tackles': 'player_solo_tackles', 'Targets': 'player_receiving_targets',
  'Rush Yards': 'player_rush_yds', 'Rushing Yards': 'player_rush_yds', 'Longest Rush': 'player_rush_longest',
  'Rush Attempts': 'player_rush_attempts', 'Rush + Rec Yards': 'player_rush_reception_yds',
  'Rush + Rec TDs': 'anytime_tds', 'Rush + Rec TD': 'anytime_tds', 'Pass Yards': 'passing_yards',
  'Passing Yards': 'passing_yards', 'Pass TDs': 'player_pass_tds', 'Passing TDs': 'player_pass_tds',
  'Completions': 'player_pass_completions', 'Pass Attempts': 'player_pass_attempts', 'Passing Attempts': 'player_pass_attempts',
  'Pass + Rush Yards': 'player_pass_rush_yds', 'Passing + Rushing Yards': 'player_pass_rush_yds',
  'INTs Thrown': 'player_pass_interceptions', 'Interceptions Thrown': 'player_pass_interceptions',
  'Defensive INTs': 'player_defensive_interceptions', 'Fumbles Lost': 'player_fumbles_lost',
  'FG Made': 'player_field_goals', 'Field Goals Made': 'player_field_goals', 'Kicking Points': 'player_kicking_points',
  'XP Made': 'player_extra_points', 'Fantasy Points': 'player_fantasy_points' };
const mlbApps: Readonly<Record<string, string>> = { 'Hits + Runs + RBIs': 'batter_hits_runs_rbis',
  'Total Bases': 'batter_total_bases', 'Total Bases (From Hits)': 'batter_total_bases', 'RBIs': 'rbis',
  'Runs Batted In': 'rbis', 'Home Runs': 'batter_home_runs', 'Hits': 'batter_hits', 'Runs': 'runs',
  'Batter Walks': 'batter_walks', 'Walks': 'batter_walks', 'Stolen Bases': 'sb', 'Singles': 'singles',
  'Doubles': 'doubles', 'Triples': 'triples', 'Extra Base Hits': 'extra_base_hits', 'Runs + RBIs': 'runs_rbis',
  'Batter Strikeouts': 'hitter_ks', 'Strikeouts': 'pitcher_strikeouts', 'Strikeouts Thrown': 'pitcher_strikeouts',
  'Pitching Outs Recorded': 'pitching_outs', 'Outs': 'pitching_outs', 'Pitcher Hits Allowed': 'hits_allowed',
  'Hits Against': 'hits_allowed', 'Pitcher Earned Runs Allowed': 'pitcher_earned_runs',
  'Earned Runs Allowed': 'pitcher_earned_runs', 'Pitcher Walks Allowed': 'walks_allowed', 'Walks Allowed': 'walks_allowed',
  'Fantasy Points': 'batter_fantasy_score', 'Batter Fantasy Points': 'batter_fantasy_score' };
const nhlApps: Readonly<Record<string, string>> = { 'Goals': 'goals', 'Assists': 'assists', 'Points': 'points',
  'Shots on Goal': 'shots_on_goal', 'Plus Minus': 'plus_minus', 'Faceoffs Won': 'faceoffs_won', 'Hits': 'hits',
  'Blocked Shots': 'blocked_shots', 'Blocks': 'blocked_shots', 'Saves': 'saves', 'Fantasy Points': 'player_fantasy_points' };
/** Underdog and Pick6 stat labels to the same market keys PrizePicks lines use, so lines match and grade alike. */
const appStatKeys: Readonly<Partial<Record<DfsApp, Readonly<Partial<Record<Sport, Readonly<Record<string, string>>>>>>>> = {
  underdog: { NFL: nflApps, NCAAFB: nflApps, MLB: mlbApps, NHL: nhlApps, NBA: basketball, WNBA: basketball },
  pick6: { NFL: nflApps, NCAAFB: nflApps, MLB: mlbApps, NHL: nhlApps, NBA: basketball, WNBA: basketball },
};

export function marketKey(sport: Sport, stat: string, app?: DfsApp): string {
  const own = app ? appStatKeys[app]?.[sport]?.[stat] : undefined;
  if (own) return own;
  // Step 4c: a partial-game stat ("1H Rec Yards") is the full-game key with its segment in front (1h_player_reception_yds),
  // so a 1st-half line meets the books' 1st-half price and never the full-game one.
  const segmented = /^(1H|2H|1Q|2Q|3Q|4Q|1P|2P|3P)\s+(.+)$/i.exec(stat.trim());
  if (segmented) return `${segmented[1]!.toLowerCase()}_${marketKey(sport, segmented[2]!, app)}`;
  return statKeys[sport]?.[stat] ?? stat.toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}


export function leagueInfo(league: string): { sport: Sport; key: string } {
  return leagues[league] ?? leagues[league.trim().toUpperCase()] ?? { sport: 'OTHER', key: league.toLowerCase() };
}

/** The PrizePicks league label for a CrownIQ sport (used when a source gives sports, not league labels). */
export function leagueLabel(sport: Sport): string {
  return Object.entries(leagues).find(([, info]) => info.sport === sport)?.[0] ?? sport;
}

/** The model market key of a stored line, whichever source supplied it. */
export const lineMarket = (line: Pick<ScrapedLine, 'league' | 'stat' | 'marketKey'> & { app?: DfsApp }) => {
  if (line.marketKey) return line.marketKey;
  // PrizePicks' partial-game boards (NFL1H, NHL1P): the base league's key with the segment in front.
  const base = segmentBase(line.league);
  if (base) return `${base.segment.toLowerCase()}_${marketKey(base.sport, line.stat, line.app)}`;
  return marketKey(leagueInfo(line.league).sport, line.stat, line.app);
};

/** A partial-game board's base sport and segment (NFL1H → NFL, 1H), or null for a full-game league. */
export function segmentBase(league: string): { sport: Sport; segment: string } | null {
  const segment = segmentOf(league);
  if (!segment || leagueInfo(league).sport !== 'OTHER') return null;
  const sport = leagueInfo(league.trim().toUpperCase().slice(0, -segment.length)).sport;
  return sport === 'OTHER' ? null : { sport, segment };
}

/** The same line across sources that use different ids: app, league, player, market, number, tier. */
export const sameLineKey = (line: ScrapedLine) => JSON.stringify([line.app, sportGroup(line.league), segmentOf(line.league),
  line.player.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''),
  canonicalMarket(leagueInfo(line.league).sport, lineMarket(line)), line.line, line.tier]);

/** The sport for a known league (so LA LIGA and SOCCER lines meet), else the label itself. */
const sportGroup = (league: string) => { const sport = leagueInfo(league).sport; return sport === 'OTHER' ? league.trim().toUpperCase() : sport; };

/** A partial-game board's segment from its league label (NFL1H, NHL1P), so a 1st-half line never joins a full-game one. */
export const segmentOf = (league: string) => /(1H|2H|1Q|2Q|3Q|4Q|1P|2P|3P)$/.exec(league.trim().toUpperCase())?.[1] ?? '';
