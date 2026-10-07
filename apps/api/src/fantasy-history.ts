import type { PropLine } from '@crowniq/contracts';

// Fantasy score lines, scored the way each app scores them, from ESPN's public game logs (owner, 2026-10-07: "PrizePicks
// and Underdog do it differently and it's more than just the couple stats"). History Read and Edge use these values;
// GKR does not. Only PrizePicks fantasy lines are read (owner, 2026-10-07); the Underdog charts below are kept for
// reference and tests but no Underdog line uses them.
//
// Charts (published by each app; checked 2026-10-07):
// - PrizePicks NFL/college: full PPR. 0.04 per passing yard, 4 per passing TD, -1 per interception, 0.1 per rushing or
//   receiving yard, 6 per rushing or receiving TD, 1 per catch, -1 per fumble lost, 2 per two-point conversion.
// - Underdog NFL/college: half PPR (0.5 per catch), -2 per fumble lost; the rest as PrizePicks.
// - Basketball, both apps: 1 per point, 1.2 per rebound, 1.5 per assist, 3 per block, 3 per steal, -1 per turnover.
// - MLB hitters: PrizePicks single 3, double 5, triple 8, home run 10, run 2, RBI 2, walk 2, hit by pitch 2, steal 5;
//   Underdog the same except walk 3, hit by pitch 3, steal 4 (and double 5).
// - MLB pitchers: PrizePicks win 6, quality start 4, earned run -3, strikeout 3, out 1; Underdog win 5, quality start 5,
//   earned run -3, strikeout 3, inning 3 (1 per out).
// - PrizePicks tennis: 10 for playing the match, +1 per game won, -1 per game lost, +3 per set won, -3 per set lost, +0.5
//   per ace, -0.5 per double fault (PrizePicks' scoring chart, owner screenshots 2026-10-07). ESPN's results give games and sets per match; aces and double
//   faults come from Sleeper's recent values as the player's average (so a match's spread is slightly understated).
//   Underdog tennis fantasy isn't read (its chart isn't confirmed).
// - PrizePicks kickers: field goal 3 (0-39 yards), 4 (40-49), 5 (50+), extra point 1, -1 per missed field goal or extra
//   point. Underdog kickers aren't read.
// - NHL goalies, both apps: win 6, save 0.6, goal against -3.
// Not read: NHL skaters (both apps score blocked shots and hits, which ESPN's logs don't carry), soccer (PrizePicks scores
// passes, tackles, clearances, dribbles and crosses, which aren't in ESPN's logs), UFC, DK Pick'em (its chart isn't
// confirmed), and any segment line (1st half, 1st quarter). ESPN's logs carry no two-point conversions, and a
// quarterback's log no fumbles lost, so those count 0 (a slight overstatement; receivers' and backs' fumbles count).

export type FantasyApp = 'prizepicks' | 'underdog';
type Row = { metrics: Readonly<Record<string, number>> };

const v = (row: Row, key: string) => row.metrics[key] ?? 0;
const has = (row: Row, ...keys: string[]) => keys.some((key) => Number.isFinite(row.metrics[key]));

function kicker(row: Row, app: FantasyApp): number | null {
  if (app !== 'prizepicks' || !has(row, 'fieldGoalsMade', 'extraPointsMade')) return null;
  const made = (range: string) => v(row, `fieldGoalsMade${range}`);
  const short = made('1_19') + made('20_29') + made('30_39'), mid = made('40_49'), long = made('50');
  const missedFg = v(row, 'fieldGoalAttempts') - v(row, 'fieldGoalsMade'), missedXp = v(row, 'extraPointAttempts') - v(row, 'extraPointsMade');
  return short * 3 + mid * 4 + long * 5 + v(row, 'extraPointsMade') - missedFg - missedXp;
}

function goalie(row: Row): number | null {
  if (!has(row, 'saves') || !has(row, 'goalsAgainst')) return null;
  return v(row, 'wins') * 6 + v(row, 'saves') * .6 - v(row, 'goalsAgainst') * 3;
}

function football(row: Row, app: FantasyApp): number | null {
  if (has(row, 'fieldGoalsMade', 'extraPointsMade')) return kicker(row, app);
  if (!has(row, 'passingYards', 'rushingYards', 'receivingYards', 'receptions')) return null;
  return v(row, 'passingYards') * .04 + v(row, 'passingTouchdowns') * 4 - v(row, 'interceptions')
    + (v(row, 'rushingYards') + v(row, 'receivingYards')) * .1 + (v(row, 'rushingTouchdowns') + v(row, 'receivingTouchdowns')) * 6
    + v(row, 'receptions') * (app === 'underdog' ? .5 : 1)
    - v(row, 'fumblesLost') * (app === 'underdog' ? 2 : 1);
}

function basketball(row: Row): number | null {
  if (!has(row, 'points')) return null;
  return v(row, 'points') + v(row, 'totalRebounds') * 1.2 + v(row, 'assists') * 1.5 + v(row, 'blocks') * 3 + v(row, 'steals') * 3
    - v(row, 'turnovers');
}

/** Outs from ESPN's innings ("5.1" = 5⅓ innings = 16 outs). */
export const outsOf = (innings: number) => Math.floor(innings) * 3 + Math.round((innings % 1) * 10);

function pitcher(row: Row, app: FantasyApp): number | null {
  if (!has(row, 'innings')) return null;
  const outs = outsOf(v(row, 'innings')), earned = v(row, 'earnedRuns');
  const qualityStart = outs >= 18 && earned <= 3 ? 1 : 0;
  return app === 'underdog'
    ? v(row, 'win') * 5 + qualityStart * 5 + v(row, 'strikeouts') * 3 + outs - earned * 3
    : v(row, 'win') * 6 + qualityStart * 4 + v(row, 'strikeouts') * 3 + outs - earned * 3;
}

function hitter(row: Row, app: FantasyApp): number | null {
  if (!has(row, 'atBats')) return null;
  const doubles = v(row, 'doubles'), triples = v(row, 'triples'), homers = v(row, 'homeRuns');
  const singles = v(row, 'hits') - doubles - triples - homers;
  const ud = app === 'underdog';
  return singles * 3 + doubles * 5 + triples * 8 + homers * 10 + v(row, 'runs') * 2 + v(row, 'RBIs') * 2
    + (v(row, 'walks') + v(row, 'hitByPitch')) * (ud ? 3 : 2) + v(row, 'stolenBases') * (ud ? 4 : 5);
}

/** A fantasy line's app from its id (Underdog and DK Pick'em lines carry their app; the rest are PrizePicks). */
export function fantasyApp(line: Pick<PropLine, 'id'>): FantasyApp | 'pick6' {
  return line.id.startsWith('underdog:') ? 'underdog' : line.id.startsWith('pick6:') ? 'pick6' : 'prizepicks';
}

/** A full-game fantasy score line (any app's label); segment lines are left out. */
export const isFantasyMarket = (market: string) => /fantasy/.test(market) && !/^(1h|2h|1q|2q|3q|4q|1p|2p|3p)_/.test(market);

/**
 * One game's fantasy score for an app, or null when the sport isn't read or the row lacks the stats. MLB picks the
 * pitcher chart for a pitching log and the hitter chart otherwise; a "pitcher"/"hitter" market name decides when given.
 */
export function fantasyValue(app: FantasyApp, sport: string, market: string, row: Row): number | null {
  if (sport === 'NFL' || sport === 'NCAAFB') return football(row, app);
  if (sport === 'NHL') return goalie(row);
  if (['NBA', 'WNBA', 'NCAAB', 'NCAAW'].includes(sport)) return basketball(row);
  if (sport === 'MLB') {
    if (/pitcher/.test(market)) return pitcher(row, app);
    if (/hitter|batter/.test(market)) return hitter(row, app);
    return has(row, 'innings') ? pitcher(row, app) : hitter(row, app);
  }
  return null;
}

/** One tennis match on PrizePicks' chart, with the player's average aces and double faults. */
export function tennisFantasy(stats: Readonly<Record<string, number>>, aces: number, doubleFaults: number): number | null {
  const { gamesWon, gamesLost, setsWon, totalSets } = stats;
  if (![gamesWon, gamesLost, setsWon, totalSets].every((value) => Number.isFinite(value))) return null;
  return 10 + gamesWon! - gamesLost! + 3 * setsWon! - 3 * (totalSets! - setsWon!) + .5 * aces - .5 * doubleFaults;
}

/** Whether a line gets a history read at all: fantasy score is read on PrizePicks only. */
export const fantasyBlocked = (line: Pick<PropLine, 'id' | 'market'>) => isFantasyMarket(line.market) && fantasyApp(line) !== 'prizepicks';
