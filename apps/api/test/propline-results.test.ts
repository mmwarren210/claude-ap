import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PropLineClient } from '../src/scrapers/propline.js';
import { PropLineResults, proplineGameId } from '../src/scrapers/propline-results.js';

test('PropLine results: a pushed grade and a read-back game grade picks by game, player and stat; only settled props count', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-results-'));
  const asked: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input)); asked.push(url.pathname);
    return new Response(JSON.stringify({ bookmakers: [{ key: 'prizepicks', markets: [{ key: 'player_rush_yds', outcomes: [
      { name: 'Over', description: 'Bijan Robinson', point: 70.5, resolution: 'won', actual_value: 94 },
      { name: 'Over', description: 'Drake London', point: 4.5, resolution: null, actual_value: 3 }] }] }] }), { status: 200 });
  }) as typeof fetch;
  const results = new PropLineResults(new PropLineClient('k', fetchFn, 8, 'https://pl.test', async () => undefined), join(folder, 'r.json'));
  try {
    assert.equal(proplineGameId('pp-game:propline:46672'), '46672');
    await results.record({ event_type: 'resolution', sport_key: 'football_nfl', event: { id: 46672 }, market_key: 'player_rush_tds',
      player_name: 'Bijan Robinson', resolution: 'won', actual_value: 1 });
    // PropLine's key and CrownIQ's name for it both find the grade.
    assert.equal(await results.actual({ eventId: 'pp-game:propline:46672', sport: 'NFL', playerName: 'Bijan Robinson', market: 'rush_tds' }), 1);
    assert.equal(await results.actual({ eventId: 'ud-game:propline:46672', sport: 'NFL', playerName: 'bijan robinson', market: 'player_rush_tds' }), 1);
    // Read back a game PropLine has named before: the settled prop counts, the unsettled one does not.
    await results.fetchGames(['46672']);
    assert.deepEqual(asked, ['/v1/sports/football_nfl/events/46672/results']);
    assert.equal(await results.actual({ eventId: 'pp-game:propline:46672', sport: 'NFL', playerName: 'Bijan Robinson', market: 'player_rush_yds' }), 94);
    assert.equal(await results.actual({ eventId: 'pp-game:propline:46672', sport: 'NFL', playerName: 'Drake London', market: 'player_rush_yds' }), null);
    await results.fetchGames(['46672']);
    assert.equal(asked.length, 1, 'each game is read back at most once an hour');
    // A game PropLine never named can't be read back (its sport is unknown) and a non-PropLine pick never matches.
    assert.equal(await results.actual({ eventId: 'pp-game:12345', sport: 'NFL', playerName: 'Bijan Robinson', market: 'rush_tds' }), null);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
