import type { Sport } from '@crowniq/contracts';
import type { ScrapedLine } from './scraped-line.js';

/** PrizePicks league labels to CrownIQ sports and the matching Odds API sport keys (keeps player ids identical). */
export const leagues: Readonly<Record<string, { sport: Sport; key: string }>> = {
  NFL: { sport: 'NFL', key: 'americanfootball_nfl' }, CFB: { sport: 'NCAAFB', key: 'americanfootball_ncaaf' },
  MLB: { sport: 'MLB', key: 'baseball_mlb' }, NBA: { sport: 'NBA', key: 'basketball_nba' },
  WNBA: { sport: 'WNBA', key: 'basketball_wnba' }, NHL: { sport: 'NHL', key: 'icehockey_nhl' },
  SOCCER: { sport: 'SOCCER', key: 'soccer' }, TENNIS: { sport: 'TENNIS', key: 'tennis' },
  CS2: { sport: 'CS2', key: 'esports_cs2' }, VAL: { sport: 'VALORANT', key: 'esports_valorant' },
  LOL: { sport: 'LOL', key: 'esports_lol' }, DOTA2: { sport: 'DOTA', key: 'esports_dota2' },
  KBO: { sport: 'KBO', key: 'baseball_kbo' }, AFL: { sport: 'AFL', key: 'aussierules_afl' },
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


export function marketKey(sport: Sport, stat: string): string {
  return statKeys[sport]?.[stat] ?? stat.toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}


export function leagueInfo(league: string): { sport: Sport; key: string } {
  return leagues[league] ?? { sport: 'OTHER', key: league.toLowerCase() };
}

/** The PrizePicks league label for a CrownIQ sport (used when a source gives sports, not league labels). */
export function leagueLabel(sport: Sport): string {
  return Object.entries(leagues).find(([, info]) => info.sport === sport)?.[0] ?? sport;
}

/** The model market key of a stored line, whichever source supplied it. */
export const lineMarket = (line: Pick<ScrapedLine, 'league' | 'stat' | 'marketKey'>) =>
  line.marketKey ?? marketKey(leagueInfo(line.league).sport, line.stat);

/** The same line across sources that use different ids: app, league, player, market, number, tier. */
export const sameLineKey = (line: ScrapedLine) => JSON.stringify([line.app, line.league,
  line.player.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''),
  lineMarket(line), line.line, line.tier]);
