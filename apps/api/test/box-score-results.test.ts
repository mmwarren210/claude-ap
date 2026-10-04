import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { BoxScoreResults, boxScoreReader, espnRows, mlbRows } from '../src/box-score-results.js';

const now = new Date('2030-10-04T12:00:00Z');
const target = (overrides: Parameters<typeof fixtureLine>[0]) => {
  const lineSnapshot = fixtureLine({ eventStartTime: '2030-10-03T23:00:00.000Z', ...overrides });
  return { eventId: lineSnapshot.eventId, playerId: lineSnapshot.playerId, lineSnapshot };
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const espnScoreboard = (id: string, away: string, home: string, completed = true) => ({ events: [{ id,
  date: '2030-10-03T23:00Z', status: { type: { completed, state: completed ? 'post' : 'in' } },
  competitions: [{ competitors: [{ homeAway: 'home', team: { displayName: home, name: home.split(' ').at(-1) } },
    { homeAway: 'away', team: { displayName: away, name: away.split(' ').at(-1) } }] }] }] });

test('ESPN box scores split compound cells and keep football categories apart', () => {
  const rows = espnRows({ boxscore: { players: [{ team: { displayName: 'Philadelphia Eagles' }, statistics: [
    { name: 'passing', keys: ['completions/passingAttempts', 'passingYards', 'interceptions', 'sacks-sackYardsLost'],
      athletes: [{ athlete: { displayName: 'Jalen Hurts' }, stats: ['16/25', '153', '1', '2-12'] }] },
    { name: 'rushing', keys: ['rushingAttempts', 'rushingYards', 'rushingTouchdowns'],
      athletes: [{ athlete: { displayName: 'Jalen Hurts' }, stats: ['8', '41', '1'] }] },
  ] }] } });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].stats['passing.completions'], rows[0].stats['passing.passingAttempts'],
    rows[0].stats['passing.sacks'], rows[0].stats['rushing.rushingYards']], [16, 25, 2, 41]);
  const read = boxScoreReader(fixtureLine({ market: 'player_pass_rush_yds' }))!;
  assert.equal(read(rows[0].stats), 194);
});

test('quarter splits, esports and fantasy scores are left ungraded', () => {
  assert.equal(boxScoreReader(fixtureLine({ sport: 'OTHER' as never, league: 'NFL1Q', market: 'rec_yards' })), null);
  assert.equal(boxScoreReader(fixtureLine({ market: 'player_fantasy_points' })), null);
  assert.equal(boxScoreReader(fixtureLine({ sport: 'LOL', league: 'LOL', market: 'maps_1_2_kills' })), null);
});

test('NHL picks grade from a final ESPN box score; unfinished games and unknown players wait', async () => {
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/hockey/nhl/scoreboard')) return json(espnScoreboard('77', 'Chicago Blackhawks', 'Buffalo Sabres'));
    if (url.includes('/hockey/nhl/summary?event=77')) return json({ boxscore: { players: [{ team: { displayName: 'Chicago Blackhawks' },
      statistics: [{ name: 'forwards', keys: ['plusMinus', 'goals', 'assists', 'shotsTotal', 'shotsMissed'],
        athletes: [{ athlete: { displayName: 'Tyler Bertuzzi' }, stats: ['-1', '1', '1', '3', '2'] }] }] }] } });
    return new Response('missing', { status: 404 });
  };
  const nhl = { sport: 'NHL' as const, league: 'NHL', homeTeam: 'Sabres', awayTeam: 'Blackhawks', team: 'Blackhawks',
    opponent: 'Sabres', playerName: 'Tyler Bertuzzi' };
  const report = await new BoxScoreResults(fetchFn, () => now).results([
    target({ ...nhl, id: 'a', playerId: 'tb', market: 'shots_on_goal' }),
    target({ ...nhl, id: 'b', playerId: 'tb', market: 'points' }),
    target({ ...nhl, id: 'c', playerId: 'tb', market: 'plus_minus' }),
    target({ ...nhl, id: 'd', playerId: 'nobody', playerName: 'Not Listed', market: 'goals' }),
    target({ ...nhl, id: 'e', playerId: 'later', market: 'goals', eventStartTime: '2030-10-04T11:00:00.000Z' }),
  ]);
  assert.deepEqual(report.facts.map((fact) => [fact.market, fact.status, fact.actual]),
    [['shots_on_goal', 'FINAL', 3], ['points', 'FINAL', 2], ['plus_minus', 'FINAL', -1]]);
  assert.equal(report.waiting, 2);
  assert.ok(report.facts.every((fact) => fact.sourceUrl.includes('event=77')));
});

test('a basketball DNP and a soccer unused substitute are recorded as DNP, not zero', async () => {
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/basketball/nba/scoreboard')) return json(espnScoreboard('5', 'Miami Heat', 'Toronto Raptors'));
    if (url.includes('/basketball/nba/summary')) return json({ boxscore: { players: [{ team: { displayName: 'Miami Heat' },
      statistics: [{ keys: ['points', 'rebounds', 'assists'], athletes: [
        { athlete: { displayName: 'Bench Guard' }, stats: [], didNotPlay: true },
        { athlete: { displayName: 'Star Forward' }, stats: ['30', '10', '5'], didNotPlay: false }] }] }] } });
    if (url.includes('/soccer/all/scoreboard')) return json(espnScoreboard('9', 'Washington Spirit', 'Houston Dash'));
    if (url.includes('/soccer/all/summary')) return json({ rosters: [{ team: { displayName: 'Washington Spirit' }, roster: [
      { athlete: { displayName: 'Unused Sub' }, starter: false, subbedIn: false, stats: [] },
      { athlete: { displayName: 'Striker One' }, starter: true, subbedIn: false,
        stats: [{ name: 'totalShots', value: 4 }, { name: 'shotsOnTarget', value: 2 }] }] }] });
    return new Response('missing', { status: 404 });
  };
  const nba = { sport: 'NBA' as const, league: 'NBA', homeTeam: 'Raptors', awayTeam: 'Heat', team: 'Heat', opponent: 'Raptors' };
  const fut = { sport: 'SOCCER' as const, league: 'SOCCER', homeTeam: 'Houston Dash', awayTeam: 'Washington Spirit',
    team: 'Washington Spirit', opponent: 'Houston Dash' };
  const report = await new BoxScoreResults(fetchFn, () => now).results([
    target({ ...nba, id: '1', playerId: 'bg', playerName: 'Bench Guard', market: 'player_points' }),
    target({ ...nba, id: '2', playerId: 'sf', playerName: 'Star Forward', market: 'player_points_rebounds_assists' }),
    target({ ...fut, id: '3', playerId: 'us', playerName: 'Unused Sub', market: 'shots' }),
    target({ ...fut, id: '4', playerId: 's1', playerName: 'Striker One', market: 'sot' }),
  ]);
  assert.deepEqual(report.facts.map((fact) => [fact.playerId, fact.status, fact.actual]),
    [['bg', 'DNP', null], ['sf', 'FINAL', 45], ['us', 'DNP', null], ['s1', 'FINAL', 2]]);
});

test('MLB picks grade from the official boxscore, including total bases and singles', async () => {
  const requested: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);requested.push(url);
    if (url.includes('/schedule?')) return json({ dates: [{ games: [{ gamePk: 849825, gameDate: '2030-10-03T23:08:00Z',
      status: { abstractGameState: 'Final', detailedState: 'Final' },
      teams: { away: { team: { name: 'San Diego Padres', teamName: 'Padres' } },
        home: { team: { name: 'Milwaukee Brewers', teamName: 'Brewers' } } } }] }] });
    if (url.endsWith('/game/849825/boxscore')) return json({ teams: {
      away: { team: { name: 'San Diego Padres' }, players: {
        ID1: { person: { id: 1, fullName: 'Manny Machado' }, stats: { batting: { hits: 2, doubles: 1, triples: 0,
          homeRuns: 1, runs: 1, rbi: 3, totalBases: 7, baseOnBalls: 0, strikeOuts: 1 }, pitching: {} } },
        ID2: { person: { id: 2, fullName: 'Bench Bat' }, stats: { batting: {}, pitching: {} } } } },
      home: { team: { name: 'Milwaukee Brewers' }, players: {
        ID3: { person: { id: 3, fullName: 'Ace Starter' }, stats: { batting: {}, pitching: { strikeOuts: 8, hits: 4,
          earnedRuns: 1, baseOnBalls: 2, numberOfPitches: 96 } } } } } } });
    return new Response('missing', { status: 404 });
  };
  const mlb = { sport: 'MLB' as const, league: 'MLB', homeTeam: 'Brewers', awayTeam: 'Padres', team: 'Padres', opponent: 'Brewers' };
  const report = await new BoxScoreResults(fetchFn, () => now).results([
    target({ ...mlb, id: '1', playerId: 'mm', playerName: 'Manny Machado', market: 'batter_total_bases' }),
    target({ ...mlb, id: '2', playerId: 'mm', playerName: 'Manny Machado', market: 'batter_hits_runs_rbis' }),
    target({ ...mlb, id: '3', playerId: 'mm', playerName: 'Manny Machado', market: 'singles' }),
    target({ ...mlb, id: '4', playerId: 'bb', playerName: 'Bench Bat', market: 'batter_hits' }),
    target({ ...mlb, id: '5', playerId: 'as', playerName: 'Ace Starter', market: 'pitcher_strikeouts', team: 'Brewers' }),
  ]);
  assert.deepEqual(report.facts.map((fact) => [fact.market, fact.status, fact.actual]),
    [['batter_total_bases', 'FINAL', 7], ['batter_hits_runs_rbis', 'FINAL', 6], ['singles', 'FINAL', 0],
      ['batter_hits', 'DNP', null], ['pitcher_strikeouts', 'FINAL', 8]]);
  assert.equal(requested.filter((url) => url.endsWith('/boxscore')).length, 1, 'one boxscore request per game');
  assert.equal(mlbRows({}).length, 0);
});
