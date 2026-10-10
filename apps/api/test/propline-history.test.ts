import assert from 'node:assert/strict';
import test from 'node:test';
import { gameValue, PropLineHistory, proplineStat, valuesFrom } from '../src/propline-history.js';
import type { PropLine } from '@crowniq/contracts';
import type { PropLineClient } from '../src/scrapers/propline.js';

const line = (sport: PropLine['sport'], market: string, playerName = 'Test Player') =>
  ({ sport, market, playerName, eventId: 'pp-game:propline:123', eventStartTime: '2030-10-12T00:00:00Z' });

test('markets map to PropLine box-score stats, combos sum, and a missing stat is zero only beside its own kind', () => {
  assert.equal(proplineStat('MLB', 'pitcher_strikeouts'), 'strikeouts');
  assert.equal(proplineStat('MLB', 'pitching_outs'), 'outs');
  assert.equal(proplineStat('NHL', 'player_points'), 'points_nhl', 'aliases go through the canonical market');
  assert.deepEqual(proplineStat('SOCCER', 'goals_plus_assists'), ['goals', 'assists']);
  assert.equal(proplineStat('NFL', 'player_fantasy_points'), null, 'fantasy is not a box-score stat');
  assert.equal(proplineStat('LOL', 'kills'), null);
  assert.equal(proplineStat('CS2', 'map_1_kills'), 'kills_map_1');
  assert.equal(proplineStat('CS2', 'MAPS 1-2 Headshots'), 'headshots_maps_1_2');
  assert.equal(proplineStat('CS2', 'maps_1_3_kills'), 'kills_maps_1_2_3');
  assert.equal(proplineStat('CS2', 'kills'), null, 'no map scope, no read');
  assert.equal(proplineStat('UFC', 'significant_strikes'), 'significant_strikes');
  assert.equal(proplineStat('UFC', 'Takedowns'), 'takedowns');
  assert.equal(proplineStat('UFC', 'fight_time'), null);
  assert.equal(gameValue({ receptions: 4, receiving_yards: 51 }, 'receiving_tds'), 0, 'caught passes, no TD row: none scored');
  assert.equal(gameValue({ passing_yards: 250 }, 'receiving_tds'), null, 'a quarterback says nothing about receiving');
  assert.equal(gameValue({ goals: 1, assists: 1 }, ['goals', 'assists']), 2);
  assert.equal(gameValue({ kills_map_1: 0, map_1_gradeable: 0, kills_maps_1_2: 27, maps_1_2_gradeable: 1 }, 'kills_map_1'), null,
    'an ungraded map scope is no game, not a zero');
  assert.equal(gameValue({ kills_map_1: 0, map_1_gradeable: 0, kills_maps_1_2: 27, maps_1_2_gradeable: 1 }, 'kills_maps_1_2'), 27);
});

test('values come newest first from games before the line, and pitchers read their starts', () => {
  const games = [
    { at: '2030-10-01T00:00:00.000Z', opponent: 'A', stats: { strikeouts: 7, outs: 18, pitcher_started: 1 } },
    { at: '2030-10-05T00:00:00.000Z', opponent: 'B', stats: { strikeouts: 1, outs: 3, pitcher_started: 0 } },
    { at: '2030-10-07T00:00:00.000Z', opponent: 'C', stats: { strikeouts: 9, outs: 21, pitcher_started: 1 } },
    { at: '2030-10-20T00:00:00.000Z', opponent: 'D', stats: { strikeouts: 4, outs: 12, pitcher_started: 1 } },
  ];
  assert.deepEqual(valuesFrom(games, 'strikeouts', Date.parse('2030-10-12T00:00:00Z')), [9, 7]);
  assert.deepEqual(valuesFrom(games.map((game) => ({ ...game, stats: { ...game.stats, pitcher_started: 0 } })), 'outs',
    Date.parse('2030-10-12T00:00:00Z')), [21, 3, 18], 'a reliever reads every appearance');
});

test('one request per player serves every stat, is cached, skips NFL preseason and stops at the daily cap', async () => {
  const asked: string[] = [];
  let now = 0;
  const client = { get: async (path: string) => {
    asked.push(path);
    return { games: [
      { commence_time: '2030-08-15T00:00:00Z', status: 'final', opponent: 'PRE', stats: { passing_yards: 111 } },
      { commence_time: '2030-09-14T00:00:00Z', status: 'final', opponent: 'X', stats: { passing_yards: 250, rushing_yards: 30 } },
      { commence_time: '2030-09-21T00:00:00Z', status: 'final', opponent: 'Y', stats: { passing_yards: 301, rushing_yards: 12 } },
      { commence_time: '2030-10-11T00:00:00Z', status: 'in_progress', opponent: 'Z', stats: { passing_yards: 90 } }] };
  } } as unknown as PropLineClient;
  const history = new PropLineHistory(client, null, () => null, { dailyRequests: 2, ttlMs: 1000 }, () => now);
  const valuesOf = async (found: Promise<{ values: number[] } | null | 'PENDING'>) => { const result = await found;
    return result === 'PENDING' ? 'PENDING' : result?.values; };
  assert.deepEqual(await valuesOf(history.values(line('NFL', 'passing_yards'))), [301, 250]);
  assert.deepEqual(await valuesOf(history.values(line('NFL', 'player_rush_yds'))), [12, 30]);
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /^\/v1\/sports\/football_nfl\/players\/Test%20Player\/games\?limit=30$/);
  now = 2000; await history.values(line('NFL', 'passing_yards')); assert.equal(asked.length, 2, 'refetched once the cache is stale');
  assert.equal(await history.values(line('NFL', 'passing_yards', 'Other Player')), null, 'over the daily cap: no request');
  assert.equal(asked.length, 2);
  assert.equal(history.status().skippedBudget, 1);
  // Soccer needs the game's own league key; without one nothing is asked.
  assert.equal(await history.values(line('SOCCER', 'shots')), null);
  const soccer = new PropLineHistory(client, null, () => 'soccer_epl');
  await soccer.values(line('SOCCER', 'shots'));
  assert.match(asked.at(-1)!, /^\/v1\/sports\/soccer_epl\//);
});

test('a caller that cannot wait gets PENDING while the request keeps going, and the next call reads it', async () => {
  let answer: (body: unknown) => void = () => undefined;
  const client = { get: () => new Promise((done) => { answer = done; }) } as unknown as PropLineClient;
  const history = new PropLineHistory(client, null);
  assert.equal(await history.values(line('MLB', 'batter_hits'), 10), 'PENDING');
  answer({ games: [{ commence_time: '2030-10-01T00:00:00Z', status: 'final', opponent: 'A', stats: { hits: 2 } }] });
  await new Promise((done) => setImmediate(done));
  const found = await history.values(line('MLB', 'batter_hits'), 10);
  assert.deepEqual(found === 'PENDING' ? found : found?.values, [2]);
});

test('UFC lines read PropLine fight stats; a soccer line with no league tries the soccer leagues in turn', async () => {
  const asked: string[] = [];
  const client = { get: async (path: string) => { asked.push(path);
    if (path.includes('/mma_ufc/')) return { games: [{ commence_time: '2030-09-01T00:00:00Z', status: 'final', stats: { significant_strikes: 61 } }] };
    if (path.includes('/soccer_bundesliga/')) return { games: [{ commence_time: '2030-09-01T00:00:00Z', status: 'final', stats: { shots: 3 } }] };
    return { games: [] }; } } as unknown as PropLineClient;
  const history = new PropLineHistory(client, null);
  const ufc = await history.values({ ...line('OTHER', 'significant_strikes'), league: 'UFC' });
  assert.deepEqual(ufc === 'PENDING' ? ufc : ufc?.values, [61]);
  const soccer = await history.values({ ...line('SOCCER', 'shots'), league: 'SOCCER' });
  assert.deepEqual(soccer === 'PENDING' ? soccer : soccer?.values, [3]);
  assert.ok(asked.some((path) => path.includes('/soccer_epl/')) && asked.at(-1)!.includes('/soccer_bundesliga/'));
  await history.values({ ...line('SOCCER', 'shots', 'Fresh Striker'), league: 'EPL' });
  assert.ok(asked.at(-1)!.includes('/soccer_epl/'), 'a labeled league asks that league');
});

