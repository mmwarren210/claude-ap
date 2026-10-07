import assert from 'node:assert/strict';
import test from 'node:test';
import { fantasyApp, fantasyValue, isFantasyMarket, outsOf } from '../src/fantasy-history.js';
import { gameLogRows } from '../src/espn-gkr-evidence.js';

const row = (metrics: Record<string, number>) => ({ metrics });

test('NFL: PrizePicks full PPR, Underdog half PPR with -2 per fumble lost', () => {
  const receiver = row({ receptions: 8, receivingYards: 95, receivingTouchdowns: 1, rushingYards: 5, fumblesLost: 1 });
  // 10 yards + 6 TD + 8 catches - 1 fumble = 23 (PrizePicks); 10 + 6 + 4 - 2 = 18 (Underdog).
  assert.equal(fantasyValue('prizepicks', 'NFL', 'player_fantasy_points', receiver), 23);
  assert.equal(fantasyValue('underdog', 'NFL', 'player_fantasy_points', receiver), 18);
  const qb = row({ passingYards: 250, passingTouchdowns: 2, interceptions: 1, rushingYards: 30, rushingTouchdowns: 0 });
  assert.equal(fantasyValue('prizepicks', 'NFL', 'player_fantasy_points', qb), 10 + 8 - 1 + 3);
});

test('basketball: points, 1.2 rebounds, 1.5 assists, 3 blocks and steals, -1 turnovers', () => {
  assert.equal(fantasyValue('underdog', 'WNBA', 'player_fantasy_points',
    row({ points: 20, totalRebounds: 10, assists: 4, blocks: 1, steals: 2, turnovers: 3 })), 20 + 12 + 6 + 3 + 6 - 3);
});

test('MLB: hitters and pitchers on each app’s chart', () => {
  const bat = row({ atBats: 4, hits: 2, doubles: 1, triples: 0, homeRuns: 0, runs: 1, RBIs: 2, walks: 1, hitByPitch: 0, stolenBases: 1 });
  // single 3 + double 5 + run 2 + 2 RBIs 4 + walk (2 PP / 3 UD) + steal (5 PP / 4 UD).
  assert.equal(fantasyValue('prizepicks', 'MLB', 'hitter_fantasy_score', bat), 3 + 5 + 2 + 4 + 2 + 5);
  assert.equal(fantasyValue('underdog', 'MLB', 'player_fantasy_points', bat), 3 + 5 + 2 + 4 + 3 + 4);
  const arm = row({ innings: 6.1, earnedRuns: 2, strikeouts: 7, win: 1 });
  assert.equal(outsOf(6.1), 19);
  // Quality start (6+ innings, 3 or fewer earned runs).
  assert.equal(fantasyValue('prizepicks', 'MLB', 'pitcher_fantasy_score', arm), 6 + 4 + 21 + 19 - 6);
  assert.equal(fantasyValue('underdog', 'MLB', 'player_fantasy_points', arm), 5 + 5 + 21 + 19 - 6);
});

test('not read: NHL, segments; the app comes from the line id; ESPN decisions become wins', () => {
  assert.equal(fantasyValue('prizepicks', 'NHL', 'player_fantasy_points', row({ goals: 1 })), null, 'skaters: no hits or blocks');
  assert.equal(isFantasyMarket('1h_player_fantasy_points'), false);
  assert.equal(isFantasyMarket('hitter_fantasy_score'), true);
  assert.equal(fantasyApp({ id: 'underdog:abc' }), 'underdog');
  assert.equal(fantasyApp({ id: 'pick6:abc' }), 'pick6');
  assert.equal(fantasyApp({ id: 'pp-line-1' }), 'prizepicks');
  const [won] = gameLogRows({ names: ['innings', 'earnedRuns', 'strikeouts', 'wins-losses'], events: {},
    seasonTypes: [{ displayName: '2026 Regular Season', categories: [{ events: [{ eventId: 'g', stats: ['7.0', '1', '9', 'W(12-4)'] }] }] }] });
  assert.equal(won!.metrics.win, 1);
});

test('tennis: PrizePicks chart over a match, with the player’s average aces and double faults', async () => {
  const { tennisFantasy } = await import('../src/fantasy-history.js');
  // Won 6-4 3-6 6-3: 15 games won, 13 lost, 2 sets won of 3; 6 aces and 2 double faults on average.
  assert.equal(tennisFantasy({ gamesWon: 15, gamesLost: 13, setsWon: 2, totalSets: 3 }, 6, 2), 10 + 15 - 13 + 6 - 3 + 3 - 1);
  assert.equal(tennisFantasy({ gamesWon: 15 }, 6, 2), null);
  const { PlayerHistory } = await import('../src/player-history.js');
  const espn = { name: 'espn', sports: ['TENNIS'], refresh: async () => 0, games: async () => ({ source: 'ESPN', url: null, perMap: false,
    games: [{ date: '2030-01-02', opponent: null, stats: { gamesWon: 12, gamesLost: 6, setsWon: 2, totalSets: 2 } }] }) };
  const sleeper = { name: 'sleeper', sports: ['TENNIS'], refresh: async () => 0, games: async () => null,
    valuesFor: async (_name: string, market: string) => ({ source: 'Sleeper', url: null,
      values: [{ date: '2030-01-01', opponent: null, value: market === 'aces' ? 4 : 1 }] }) };
  const history = new PlayerHistory([espn, sleeper] as never);
  assert.deepEqual((await history.tennisFantasy('Test Player'))?.values, [10 + 12 - 6 + 6 + 2 - .5]);
});

test('kickers on PrizePicks’ chart; NHL goalies on both apps', () => {
  const [kick] = gameLogRows({ names: ['fieldGoalsMade1_19-fieldGoalAttempts1_19', 'fieldGoalsMade20_29-fieldGoalAttempts20_29',
    'fieldGoalsMade30_39-fieldGoalAttempts30_39', 'fieldGoalsMade40_49-fieldGoalAttempts40_49', 'fieldGoalsMade50-fieldGoalAttempts50',
    'fieldGoalsMade-fieldGoalAttempts', 'extraPointsMade-extraPointAttempts'], events: {},
  seasonTypes: [{ displayName: '2026 Regular Season', categories: [{ events: [{ eventId: 'k', stats: ['0-0', '1-1', '1-1', '1-2', '1-1', '4-5', '3-4'] }] }] }] });
  // 3 + 3 + 4 + 5 for field goals, 3 extra points, -1 missed field goal, -1 missed extra point.
  assert.equal(fantasyValue('prizepicks', 'NFL', 'player_fantasy_points', kick!), 3 + 3 + 4 + 5 + 3 - 1 - 1);
  assert.equal(fantasyValue('underdog', 'NFL', 'player_fantasy_points', kick!), null);
  assert.equal(fantasyValue('underdog', 'NHL', 'player_fantasy_points', row({ wins: 1, saves: 30, goalsAgainst: 2 })), 6 + 18 - 6);
});
