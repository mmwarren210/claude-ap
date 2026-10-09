import assert from 'node:assert/strict';
import test from 'node:test';
import type { OddsProvider } from '@crowniq/engine';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { buildServer } from '../src/server.js';

test('empty deployment exposes health but never pretends it has a live board or public admin', async () => {
  const app = buildServer();
  try {
    assert.equal((await app.inject('/health')).statusCode, 200);
    // Anonymous health exposes liveness only, never research, model or quota detail.
    assert.deepEqual((await app.inject('/health')).json(), { status: 'ok', boardAvailable: false });
    assert.deepEqual((await app.inject('/v1/board')).json(), { code: 'BOARD_UNAVAILABLE' });
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/refresh' })).statusCode, 503);
  } finally { await app.close(); }
});

test('admin token gates refresh; provider failure preserves the last validated board', async () => {
  let fail = false;
  const provider: OddsProvider = {
    id: 'fixture-only',
    fetchPrizePicksLines: async () => {
      if (fail) throw new Error('Fixture provider outage');
      return [{ id: 'fixture-1' }];
    },
    normalize: (_raw, fetchedAt) => fixtureLine({ fetchedAt }),
  };
  const app = buildServer({ provider, adminToken: 'fixture-owner-token' });
  const auth = { authorization: 'Bearer fixture-owner-token', 'x-confirm-provider-cost': 'yes' };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/refresh',
      headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
    const refreshed = await app.inject({ method: 'POST', url: '/v1/admin/refresh', headers: auth });
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.json().lineCount, 1);
    const board = (await app.inject('/v1/board')).json();
    assert.equal(board.board.lines[0].provider, 'prizepicks');
    assert.equal(board.analyses[0].reasonCode, 'MODEL_SUPPORT_INCOMPLETE');
    fail = true;
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/refresh', headers: auth })).statusCode, 502);
    assert.deepEqual((await app.inject('/v1/board')).json(), board);
  } finally { await app.close(); }
});
