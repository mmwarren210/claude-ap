import assert from 'node:assert/strict';
import test from 'node:test';
import { boardResponseSchema, playerGameLogSchema, rankingsResponseSchema } from '@crowniq/contracts';
import { DEMO_NOW, demoBoard, demoCrowns, demoPicks, demoRankings } from '../src/demo/data';
import { demoRequest } from '../src/demo/request';

test('demo data satisfies the real API schemas', () => {
  const board = boardResponseSchema.parse(demoBoard);
  const rankings = rankingsResponseSchema.parse(demoRankings);
  assert.ok(board.board.lines.length >= 12);
  assert.ok(rankings.rankings.length >= 6);
  // Ranked lines are upcoming relative to the frozen demo clock, one per player.
  const ranked = board.board.lines.filter((line) => board.rankedLineIds.includes(line.id));
  assert.ok(ranked.every((line) => Date.parse(line.eventStartTime) > DEMO_NOW));
  assert.equal(new Set(ranked.map((line) => line.playerId)).size, ranked.length);
  assert.ok(rankings.watchlist.length >= 1);
});

test('demo results and picks are internally consistent', () => {
  const graded = demoPicks.filter((pick) => pick.result !== 'PENDING');
  assert.equal(graded.length, 50);
  assert.equal(graded.filter((pick) => pick.result === 'WIN').length, 36);
  assert.equal(demoCrowns.length, 4);
  assert.ok(demoCrowns.every((crown) => crown.legs.length >= 3 && crown.legs.length <= 6));
});

test('demo requests serve sample reads and refuse every write', async () => {
  const board = await demoRequest('/v1/board');
  assert.equal(board.status, 200);
  const player = demoBoard.board.lines[0];
  const games = await demoRequest(`/v1/players/${player.sport}/${encodeURIComponent(player.playerId)}/${player.market}/games`);
  assert.equal(games.status, 200);
  assert.equal(playerGameLogSchema.parse(await games.json()).games.length, 15);
  const save = await demoRequest('/v1/me/picks', { method: 'POST', body: '{}' });
  assert.equal(save.status, 403);
  assert.equal((await save.json()).code, 'DEMO_READ_ONLY');
  assert.equal((await demoRequest('/v1/owner/board/status')).status, 404);
});

test('a ?demo web link opens demo mode', async () => {
  const { startsInDemo } = await import('../src/auth');
  assert.equal(startsInDemo('?demo'), true);
  assert.equal(startsInDemo('?demo=1&x=2'), true);
  assert.equal(startsInDemo('?x=2'), false);
  assert.equal(startsInDemo(''), false);
  assert.equal(startsInDemo(undefined), false);
});

test('demo mode shows the server demo feed when it has lines and the sample board otherwise', async () => {
  const realFetch = globalThis.fetch;
  const g = globalThis as { location?: { origin: string } };
  const { isSampleBoard } = await import('../src/demo/data');
  const live = { ...demoBoard, builtAt: '2026-10-04T12:00:00.000Z' };
  const asked: string[] = [];
  let body: unknown = live;
  g.location = { origin: 'https://crowniq.example' };
  globalThis.fetch = (async (url: string) => { asked.push(url);
    return new Response(JSON.stringify(body), { status: 200 }); }) as typeof fetch;
  try {
    const board = await (await demoRequest('/v1/board/lite')).json() as typeof demoBoard;
    assert.deepEqual(asked, ['https://crowniq.example/v1/demo/board']);
    assert.equal(isSampleBoard(board), false);
    body = { ...live, board: { ...live.board, lines: [] } };
    assert.equal(isSampleBoard(await (await demoRequest('/v1/board')).json() as typeof demoBoard), true);
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.equal(isSampleBoard(await (await demoRequest('/v1/board')).json() as typeof demoBoard), true);
  } finally {
    globalThis.fetch = realFetch;
    delete g.location;
  }
});
