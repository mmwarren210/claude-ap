import type { PropLine } from '@crowniq/contracts';

// Fantasy score lines, scored the way each app scores them, from ESPN's public game logs (owner, 2026-10-07: "PrizePicks
// and Underdog do it differently and it's more than just the couple stats"). History Read and Edge use these values;
// GKR does not.
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
// Not read: NHL (both apps score blocked shots and hits, which ESPN's logs don't carry), DK Pick'em (its chart isn't
// confirmed), and any segment line (1st half, 1st quarter). ESPN's logs carry no two-point conversions, and a
// quarterback's log no fumbles lost, so those count 0 (a slight overstatement; receivers' and backs' fumbles count).

export type FantasyApp = 'prizepicks' | 'underdog';
type Row = { metrics: Readonly<Record<string, number>> };

const v = (row: Row, key: string) => row.metrics[key] ?? 0;
const has = (row: Row, ...keys: string[]) => keys.some((key) => Number.isFinite(row.metrics[key]));

function football(row: Row, app: FantasyApp): number | null {
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
  if (['NBA', 'WNBA', 'NCAAB', 'NCAAW'].includes(sport)) return basketball(row);
  if (sport === 'MLB') {
    if (/pitcher/.test(market)) return pitcher(row, app);
    if (/hitter|batter/.test(market)) return hitter(row, app);
    return has(row, 'innings') ? pitcher(row, app) : hitter(row, app);
  }
  return null;
}
