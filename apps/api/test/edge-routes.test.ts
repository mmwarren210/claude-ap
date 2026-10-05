import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { MarketQuote, PropLine } from '@crowniq/contracts';
import { edgeBoardResponseSchema, edgePickSchema } from '@crowniq/contracts';
import type { OddsProvider } from '@crowniq/engine';
import { buildServer } from '../src/server.js';
import { EdgeLedger } from '../src/edge-ledger.js';
import { EdgeResultsWorker } from '../src/edge-service.js';
import { InternalHistoryStore } from '../src/internal-history.js';
import { HeadToHeadLedger } from '../src/head-to-head.js';
import { headToHeadReportSchema } from '@crowniq/contracts';

// Synthetic board and sportsbook prices only; nothing here is a real line or a real result.
const clockTime = new Date('2030-01-10T12:00:00Z');
const start = '2030-01-11T00:00:00Z';
const players = ['Alpha Guard', 'Bravo Wing', 'Charlie Big', 'Delta Forward'];

function lines(fetchedAt: string): PropLine[] {
  return players.flatMap((name, index) => (['MORE', 'LESS'] as const).map((direction) => ({
    id: `line-${index}-${direction}`, provider: 'prizepicks' as const, sourceLineId: `sid-${index}-${direction}`,
    sourceLineIdIsSynthetic: false, sport: 'NBA' as const, league: 'NBA', eventId: index < 2 ? 'game-a' : 'game-b',
    eventName: 'Away @ Home', eventStartTime: start, playerId: 'player-' + index, playerName: name,
    team: null, opponent: null, market: 'player_points', threshold: 20.5, availableDirections: [direction],
    lineType: 'REGULAR' as const, fetchedAt })));
}
function quotes(fetchedAt: string): MarketQuote[] {
  return players.flatMap((name, index) => ['pinnacle', 'fanduel'].map((bookmaker) => ({
    bookmaker, sport: 'NBA' as const, eventId: index < 2 ? 'game-a' : 'game-b', sourceMarketKey: 'player_points',
    market: 'player_points', playerName: name, point: index === 3 ? 18.5 : 23.5, overPrice: 1.87,
    underPrice: 1.95, fetchedAt })));
}

test('Edge routes price the board beside GKR, build slips, evaluate custom slips and grade picks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crowniq-edge-'));
  let current = clockTime;
  const clock = () => current;
  const provider: OddsProvider<PropLine> = {
    id: 'fixture-edge',
    fetchPrizePicksLines: async () => lines(clock().toISOString()),
    normalize: (raw) => raw,
    marketQuotes: (fetchedAt) => quotes(fetchedAt),
  };
  const ledger = new EdgeLedger(join(directory, 'edge.json'), clock);
  const history = new InternalHistoryStore(join(directory, 'history.json'), clock);
  const headToHead = new HeadToHeadLedger(join(directory, 'h2h.json'), clock);
  const worker = new EdgeResultsWorker(ledger, history, null, { clock, headToHead });
  const app = buildServer({ provider, adminToken: 'fixture-token', clock, internalHistory: history,
    edge: { ledger, worker, headToHead } });
  const auth = { authorization: 'Bearer fixture-token' };
  try {
    assert.equal((await app.inject('/v1/edge')).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/refresh', headers: auth })).statusCode, 200);
    const board = (await app.inject('/v1/board')).json();
    assert.equal(board.board.marketQuotes, undefined, 'quotes stay out of the mobile board payload');
    assert.equal(board.analyses[0].reasonCode, 'MODEL_SUPPORT_INCOMPLETE', 'GKR output is unchanged');

    const response = await app.inject('/v1/edge');
    assert.equal(response.statusCode, 200);
    const edge = edgeBoardResponseSchema.parse(response.json());
    assert.equal(edge.counts.quotes, 8);
    assert.equal(edge.counts.sharp, 4);
    assert.equal(edge.picks.length, 4);
    assert.deepEqual(edge.picks.filter((pick) => pick.playerName === 'Delta Forward').map((pick) => pick.side), ['LESS']);
    assert.ok(edge.picks.every((pick) => pick.edge! > 0));
    assert.ok(edge.slips.length > 0);
    assert.deepEqual(edge.picks[0].gkr, { direction: 'PASS', score: null, scoreBand: 'PASS',
      reasonCode: 'MODEL_SUPPORT_INCOMPLETE' }, 'every pick carries GKR\'s call on the same line');
    assert.equal((await app.inject('/v1/edge?view=bogus')).statusCode, 400);
    assert.equal((await app.inject('/v1/edge?sport=NFL')).json().picks.length, 0);

    const line = (await app.inject('/v1/edge/line/line-0-LESS')).json();
    edgePickSchema.parse(line.pick);
    assert.equal(line.pick.side, 'LESS');
    assert.ok(line.pick.probability < .5);
    assert.equal((await app.inject('/v1/edge/line/nope')).statusCode, 404);

    const slip = await app.inject({ method: 'POST', url: '/v1/edge/slip',
      payload: { type: 'POWER', lineIds: ['line-0-MORE', 'line-2-MORE'] } });
    assert.equal(slip.statusCode, 200);
    assert.ok(slip.json().slip.expectedReturn > 1);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/edge/slip',
      payload: { type: 'POWER', lineIds: ['line-0-MORE', 'missing'] } })).statusCode, 422);

    // Picks were tracked; grade one from a result fact and the rest from history rows.
    await new Promise((resolve) => setTimeout(resolve, 20));
    let performance = (await app.inject('/v1/edge/performance')).json();
    assert.equal(performance.tracked, 4);
    assert.equal(performance.pending, 4);
    const graded = await app.inject({ method: 'POST', url: '/v1/admin/edge/results', headers: auth,
      payload: { results: [{ eventId: 'game-a', playerId: 'player-0', market: 'player_points', status: 'FINAL',
        actual: 25, sourceName: 'fixture', sourceUrl: 'https://example.com/box', completedAt: '2030-01-11T03:00:00Z' }] } });
    assert.deepEqual(graded.json(), { graded: 1 });
    current = new Date('2030-01-11T09:00:00Z');
    await history.add(players.slice(1).map((name, index) => ({ id: 'row-' + index, sport: 'NBA' as const,
      playerId: 'player-' + (index + 1), playerName: name, sourcePlayerId: null, eventId: 'stat-game',
      occurredAt: '2030-01-11T00:30:00Z', metrics: { pts: index === 2 ? 30 : 12, minutes: 30 }, marketValues: {},
      sourceKind: 'RESEARCH_ARCHIVE' as const, sourceName: 'fixture', sourceUrl: 'https://example.com',
      sourceType: 'LICENSED_FEED' as const, importedAt: current.toISOString(), modelVersion: null, line: null,
      direction: null, lineScore: null, dataConfidence: null })));
    const run = await worker.runOnce();
    assert.equal(run?.graded, 3);
    const versus = headToHeadReportSchema.parse((await app.inject('/v1/edge/head-to-head')).json());
    assert.equal(versus.tiers.all.edge.calls, 4);
    assert.equal(versus.tiers.all.gkr.calls, 0, 'GKR passed on every fixture line');
    assert.equal(versus.tiers.all.edge.graded, 4, 'graded from the same fact and history rows as the Edge ledger');
    performance = (await app.inject('/v1/edge/performance')).json();
    assert.equal(performance.pending, 0);
    assert.equal(performance.overall.graded, 4);
    const outcomes = Object.fromEntries(performance.recent.map((pick: { playerName: string; outcome: string }) =>
      [pick.playerName, pick.outcome]));
    assert.deepEqual(outcomes, { 'Alpha Guard': 'WIN', 'Bravo Wing': 'LOSS', 'Charlie Big': 'LOSS', 'Delta Forward': 'LOSS' });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); }
});

test('Edge can be disabled without touching the GKR board', async () => {
  const app = buildServer({ edge: { enabled: false } });
  try { assert.equal((await app.inject('/v1/edge')).statusCode, 404); }
  finally { await app.close(); }
});
