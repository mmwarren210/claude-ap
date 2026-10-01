import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { playerGameLogSchema } from '@crowniq/contracts';
import { InternalHistoryStore } from '../src/internal-history.js';
import { buildServer } from '../src/server.js';

test('game log endpoint serves real logged values newest first, one per game day', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crowniq-game-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = new Date('2030-10-19T12:00:00.000Z');
  const store = new InternalHistoryStore(join(dir, 'history.json'), () => now);
  const base = { sport: 'NFL' as const, playerId: 'log-player', playerName: 'Fixture QB', sourcePlayerId: '7',
    marketValues: {}, sourceKind: 'SEED_BACKFILL' as const, sourceName: 'stat-api.com',
    sourceUrl: 'https://api.stat-api.com/example', sourceType: 'LICENSED_FEED' as const,
    importedAt: now.toISOString(), modelVersion: null, line: null, direction: null, lineScore: null, dataConfidence: null };
  await store.add(Array.from({ length: 18 }, (_, index) => ({ ...base, id: 'seed-' + index, eventId: 'g-' + index,
    occurredAt: new Date(Date.parse('2030-06-01T00:00:00.000Z') + index * 7 * 86_400_000).toISOString(),
    metrics: { passing_yds: 200 + index } })));
  // A graded result for the newest game day must not double count it.
  await store.add([{ ...base, id: 'live-dup', eventId: 'g-17', sourceKind: 'LIVE_GRADED',
    occurredAt: new Date(Date.parse('2030-06-01T00:00:00.000Z') + 17 * 7 * 86_400_000).toISOString(),
    metrics: {}, marketValues: { passing_yards: 217 } }]);
  const app = buildServer({ internalHistory: store, clock: () => now });
  try {
    const response = await app.inject('/v1/players/NFL/log-player/passing_yards/games');
    assert.equal(response.statusCode, 200);
    const log = playerGameLogSchema.parse(response.json());
    assert.equal(log.games.length, 15);
    assert.equal(log.games[0].value, 217);
    assert.equal(log.games[1].value, 216);
    assert.ok(log.games.every((game) => game.opponent === null));
    assert.equal((await app.inject('/v1/players/NFL/log-player/player_sacks/games')).statusCode, 404);
    assert.equal((await app.inject('/v1/players/NFL/nobody/passing_yards/games')).statusCode, 404);
  } finally { await app.close(); }
});
