import assert from 'node:assert/strict';
import test from 'node:test';
import { createGkrRegistry, statHistoryV3Versions } from '@crowniq/engine';
import { FreeHistoryEvidence } from '../src/free-history-evidence.js';
import { PlayerHistory, SleeperHistory } from '../src/player-history.js';

const now = new Date('2030-10-05T12:00:00Z');
const target = (market: string, sport = 'CS2', playerName = 'Mason Sanderson') => ({ eventId: 'e1', eventName: 'M80 vs TYLOO',
  eventStartTime: '2030-10-05T20:00:00.000Z', league: sport, playerId: `${sport}:p`, playerName, team: null, opponent: null,
  market, sport: sport as never });

test('stat-history set 3 scores CS2 and tennis from player history: projection, form and stability evidence', async () => {
  const keys = Object.entries(createGkrRegistry([...statHistoryV3Versions]).requirements()).filter(([, r]) => r.approved).map(([k]) => k);
  assert.ok(keys.includes('CS2:maps_1_2_kills') && keys.includes('TENNIS:aces'));
  const series = [17, 11, 13, 19, 16, 17, 17, 5, 16, 9].map((value, index) => ({ date: `2030-09-${String(25 - index).padStart(2, '0')}`, opponent: 'X', value }));
  const sleeper = new SleeperHistory({ run: async () => [{ playerName: 'Mason Sanderson', stat: 'headshots_maps_1_2', recentPerformance: series }] }, null, () => now);
  const history = new PlayerHistory([sleeper], null, () => now);
  await history.refresh();
  const adapter = new FreeHistoryEvidence(history, keys, () => now);
  const evidence = await adapter.research([target('maps_1_2_headshots'), target('maps_1_2_kills'), target('player_points', 'NBA')]);
  const projection = evidence.find((item) => item.kind === 'projection:maps_1_2_headshots');
  assert.equal(projection?.numeric?.value, 14, 'the average of the 10 series');
  assert.ok(evidence.some((item) => item.kind === 'metric:historical_volume'));
  assert.ok(evidence.some((item) => item.kind === 'metric:stability'));
  assert.ok(!evidence.some((item) => item.market === 'maps_1_2_kills'), 'no kills history: nothing made up');
  assert.equal(adapter.getHealth().skipped, 1, 'NBA is not this adapter’s');
});
