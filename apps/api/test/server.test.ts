import assert from 'node:assert/strict';
import test from 'node:test';
import type { OddsProvider } from '@crowniq/engine';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { buildServer } from '../src/server.js';
import { TheOddsApiProvider } from '../src/the-odds-api-provider.js';

test('empty deployment exposes health but never pretends it has a live board or public admin', async () => {
  const app = buildServer();
  try {
    assert.equal((await app.inject('/health')).statusCode, 200);
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

test('owner refresh publishes a normalized PrizePicks board and keeps quota data private', async () => {
  // Every provider response here is synthetic; no API key or quota is used.
  const event = { id: 'fixture-game', sport_key: 'americanfootball_nfl',
    commence_time: '2030-09-25T00:00:00Z', home_team: 'Fixture Home', away_team: 'Fixture Away' };
  const provider = new TheOddsApiProvider({ apiKey: 'fixture-key', fetchFn: async (input) => {
    const isEventsList = new URL(String(input)).pathname.endsWith('/events');
    return new Response(JSON.stringify(isEventsList ? [event] : { ...event, bookmakers: [
      { key: 'prizepicks', markets: [{ key: 'player_pass_yds', outcomes: [
        { name: 'Over', description: 'Fixture QB', point: 240.5, sid: 'fixture-line' },
      ] }, { key: 'player_pass_yds_alternate', outcomes: [
        { name: 'Over', description: 'Fixture QB', point: 220.5,
          sid: 'fixture-lower', multiplier: null },
        { name: 'Over', description: 'Fixture QB', point: 260.5,
          sid: 'fixture-higher', multiplier: null },
      ] }] },
    ] }), { status: 200, headers: { 'x-requests-remaining': '39', 'x-requests-last': '1' } });
  } });
  const app = buildServer({ provider, adminToken: 'fixture-owner-token' });
  try {
    const auth = { authorization: 'Bearer fixture-owner-token', 'x-confirm-provider-cost': 'yes' };
    const refreshed = await app.inject({ method: 'POST', url: '/v1/admin/refresh', headers: auth });
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.json().lineCount, 3);
    assert.equal(refreshed.json().rankedCount, 0);
    const board = (await app.inject('/v1/board')).json();
    assert.equal(board.board.lines[0].sourceLineId, 'fixture-line');
    assert.equal(board.board.lines[0].market, 'passing_yards');
    assert.deepEqual(board.board.lines.map((line: { lineType: string }) => line.lineType),
      ['REGULAR', 'GOBLIN', 'DEMON']);
    assert.equal(board.board.lines[1].payoutMultiplier, undefined);
    assert.equal(board.analyses[0].reasonCode, 'MODEL_SUPPORT_INCOMPLETE');
    assert.equal((await app.inject('/health')).json().providerHealth, undefined);
    assert.deepEqual((await app.inject({ url: '/v1/admin/status', headers: auth })).json()
      .providerHealth, { creditsRemaining: 39, lastRequestCost: 1, lastHttpStatus: 200 });
  } finally { await app.close(); }
});
