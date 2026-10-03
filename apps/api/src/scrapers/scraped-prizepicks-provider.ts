import { createHash } from 'node:crypto';
import { propLineSchema } from '@crowniq/contracts';
import type { PropLine, Sport } from '@crowniq/contracts';
import type { OddsProvider } from '@crowniq/engine';
import { NFL_TEAMS } from '../current-context.js';
import type { ScrapedLineStore, StoredLine } from './line-store.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

/** PrizePicks league labels to CrownIQ sports and the matching Odds API sport keys (keeps player ids identical). */
const leagues: Readonly<Record<string, { sport: Sport; key: string }>> = {
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

/** PrizePicks NFL abbreviations that differ from the standard ones. */
const nflAliases: Readonly<Record<string, string>> = { JAC: 'JAX', LA: 'LAR', WSH: 'WAS' };

export function marketKey(sport: Sport, stat: string): string {
  return statKeys[sport]?.[stat] ?? stat.toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Readable team names for a slate: NFL full names, otherwise the names the rows themselves give. */
function teamNames(lines: readonly StoredLine[]): (league: string, abbreviation: string | null) => string | null {
  const names = new Map<string, string>();
  for (const line of lines) {
    if (line.team && line.teamName) names.set(`${line.league}|${line.team}`, line.teamName);
    for (const side of [line.home, line.away]) if (side?.name) names.set(`${line.league}|${side.abbreviation}`, side.name);
  }
  return (league, abbreviation) => {
    if (!abbreviation) return null;
    if (league === 'NFL') return NFL_TEAMS[nflAliases[abbreviation] ?? abbreviation] ?? abbreviation;
    return names.get(`${league}|${abbreviation}`) ?? abbreviation;
  };
}

/**
 * PrizePicks lines from the scraper store, as board lines. Reading the store is free; the scraper
 * pulls happen on their own schedule. Ids and market keys follow the Odds API provider's, so player
 * history and models line up whichever source supplied a line.
 */
export class ScrapedPrizePicksProvider implements OddsProvider<PropLine> {
  readonly id = 'apify-scrapers:prizepicks';
  constructor(private readonly store: ScrapedLineStore) {}

  async fetchPrizePicksLines(): Promise<readonly PropLine[]> {
    const lines = await this.store.active('prizepicks');
    if (!lines.length) throw new Error('SCRAPED_LINES_UNAVAILABLE');
    const name = teamNames(lines);
    return lines.map((line) => {
      const league = leagues[line.league] ?? { sport: 'OTHER' as Sport, key: line.league.toLowerCase() };
      const team = name(line.league, line.team), opponent = name(line.league, line.opponent);
      // Real home and away when a source said which is which; otherwise the two sides in a fixed order.
      const home = line.home ? name(line.league, line.home.abbreviation) : null;
      const away = line.away ? name(line.league, line.away.abbreviation) : null;
      const sides = home && away ? [away, home] : [team, opponent].filter((side): side is string => !!side).sort();
      return propLineSchema.parse({
        id: 'pp:' + line.appLineId, provider: 'prizepicks', sourceLineId: line.appLineId,
        sport: league.sport, league: line.league, sourceSportKey: league.key,
        eventId: 'pp-game:' + line.gameId,
        eventName: sides.length !== 2 ? `${line.league} ${line.gameId}` : home && away ? `${away} @ ${home}` : `${sides[0]} vs ${sides[1]}`,
        eventStartTime: line.startTime,
        playerId: league.key + ':' + hash(line.player.trim().toLowerCase()), playerName: line.player,
        team, opponent, homeTeam: sides.length === 2 ? sides[1] : null, awayTeam: sides.length === 2 ? sides[0] : null,
        market: marketKey(league.sport, line.stat), threshold: line.line, availableDirections: line.directions,
        lineType: line.tier, fetchedAt: line.lastSeenAt,
        ...(line.imageUrl ? { playerImageUrl: line.imageUrl } : {}),
      });
    });
  }

  normalize(raw: PropLine): PropLine { return raw; }
}
