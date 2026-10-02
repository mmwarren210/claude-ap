import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Evidence } from '@crowniq/contracts';
import type { OddsProvider, ResearchAdapter } from '@crowniq/engine';
import { ModelRegistry } from '@crowniq/engine';
import { fixtureAssessment, fixtureLine, now } from '../../../packages/engine/test/fixtures.js';
import { BoardCache } from '../src/board-cache.js';
import { BoardService } from '../src/board-service.js';
import { ContextRefreshScheduler, DailyLookupBudget } from '../src/context-refresh.js';

// The fixture game starts 12 hours after `now`; the clock is moved to 6 hours before it.
const tickTime = new Date('2030-09-24T18:00:00.000Z');
function evidence(id: string, kind: string, retrievedAt: Date, ttlMinutes: number): Evidence {
  return { id, entityType: 'PLAYER', entityId: 'test-player-1', eventId: 'test-event',
    market: kind.startsWith('status:') ? null : 'passing_yards', kind, finding: 'Synthetic context refresh evidence.',
    sourceName: 'Synthetic fixture', sourceUrl: 'https://example.org/context', sourceType: 'OFFICIAL',
    retrievedAt: retrievedAt.toISOString(), expiresAt: new Date(retrievedAt.getTime() + ttlMinutes * 60_000).toISOString(),
    quality: 'HIGH', confidence: 1, numeric: { value: kind.startsWith('status:') ? 1 : 270 } };
}
function models() {
  const registry = new ModelRegistry();
  registry.register({ sport: 'NFL', market: 'passing_yards', version: 'context-fixture', calibrationApproved: true,
    requiredEvidenceKinds: ['projection:passing_yards', 'status:qb_available'],
    assess: ({ phase }) => fixtureAssessment(phase, 'MORE', 88) });
  return registry;
}
async function setup() {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-context-'));
  const cache = new BoardCache(join(folder, 'board.json'));
  // Long-lived history, plus a 30-minute player status taken at `now`, so it is long expired by tickTime.
  await cache.save({ board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines: [fixtureLine()] },
    evidence: [evidence('history', 'projection:passing_yards', now, 24 * 60), evidence('status-old', 'status:qb_available', now, 30)],
    researchStatus: 'OK', lastSuccessfulRefresh: now.toISOString() });
  return { folder, cache };
}

test('a context tick re-ranks a line whose player status expired, without touching the odds provider', async () => {
  const { folder, cache } = await setup();
  let pulls = 0, targets = 0;
  const provider: OddsProvider = { id: 'synthetic-provider', fetchPrizePicksLines: async () => { pulls++; return []; },
    normalize: () => fixtureLine() };
  const context: ResearchAdapter = { id: 'synthetic-context', research: async (list) => {
    targets += list.length; return [evidence('status-new', 'status:qb_available', tickTime, 30)];
  } };
  try {
    let clock = now;
    const service = new BoardService(provider, null, models(), () => clock, cache);
    await service.restore();
    assert.equal(service.getBoard()!.rankedLineIds.length, 1);
    clock = tickTime;
    assert.equal(service.getBoard()!.rankedLineIds.length, 0, 'status expired, so the line stops ranking');
    const report = await new ContextRefreshScheduler(service, { adapter: context, intervalMinutes: 15, windowHours: 8 }).tick();
    assert.equal(report?.status, 'SUCCEEDED');
    assert.deepEqual([report?.linesTargeted, report?.evidenceAdded, report?.evidenceExpiredRemoved, report?.oddsCreditsUsed],
      [1, 1, 0, 0]);
    assert.equal(service.getBoard()!.rankedLineIds.length, 1, 'fresh status ranks it again');
    assert.equal(pulls, 0);
    assert.equal(targets, 1);
    // The refreshed status replaced the old one by kind, and the result was saved.
    assert.deepEqual(service.getEvidence().map((item) => item.id).sort(), ['history', 'status-new']);
    assert.deepEqual((await cache.load())!.evidence.map((item) => item.id).sort(), ['history', 'status-new']);
    assert.equal(service.getStatus().lastContextRefresh?.status, 'SUCCEEDED');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a tick drops expired evidence, targets only games inside the window, and skips while other work runs', async () => {
  const { folder, cache } = await setup();
  try {
    const service = new BoardService(null, null, models(), () => tickTime, cache);
    await service.restore();
    const nothing: ResearchAdapter = { id: 'empty', research: async () => [] };
    // A 4-hour window ends before the game (6 hours away), so nothing is targeted.
    const outside = await service.refreshContext(nothing, { windowHours: 4 });
    assert.deepEqual([outside.status, outside.reason], ['SKIPPED', 'NO_UPCOMING_LINES']);
    const inside = await service.refreshContext(nothing, { windowHours: 8 });
    assert.deepEqual([inside.status, inside.linesTargeted, inside.evidenceExpiredRemoved], ['SUCCEEDED', 1, 1]);
    assert.deepEqual(service.getEvidence().map((item) => item.id), ['history']);

    // While a slow tick is still researching, a second request is skipped rather than queued.
    let release = () => {};
    const slow: ResearchAdapter = { id: 'slow', research: () => new Promise((resolve) => { release = () => resolve([]); }) };
    const first = service.refreshContext(slow, { windowHours: 8 });
    const second = await service.refreshContext(nothing, { windowHours: 8 });
    assert.deepEqual([second.status, second.reason], ['SKIPPED', 'BOARD_BUSY']);
    // The scheduler also refuses to start a tick while its previous one runs.
    const scheduler = new ContextRefreshScheduler(service, { adapter: slow, intervalMinutes: 15, windowHours: 8 });
    const pending = scheduler.tick();
    assert.equal(await scheduler.tick(), null);
    release(); await first;
    release(); await pending;
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a tick during a paid pull is skipped, and the pull result is never overwritten', async () => {
  const { folder, cache } = await setup();
  let release = () => {};
  const provider: OddsProvider = { id: 'slow-provider',
    fetchPrizePicksLines: () => new Promise((resolve) => { release = () => resolve([{}]); }),
    normalize: (_raw, fetchedAt) => fixtureLine({ fetchedAt }) };
  let researched = 0;
  const context: ResearchAdapter = { id: 'context', research: async () => { researched++; return []; } };
  try {
    const service = new BoardService(provider, null, models(), () => tickTime, cache);
    await service.restore();
    const pull = service.refresh();
    const tick = await service.refreshContext(context, { windowHours: 8 });
    assert.deepEqual([tick.status, tick.reason], ['SKIPPED', 'BOARD_BUSY']);
    assert.equal(researched, 0);
    release(); await pull;
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('the NBA daily lookup budget stops at its limit, survives a restart and resets the next day', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-budget-'));
  try {
    let clock = new Date('2030-09-24T10:00:00.000Z');
    const file = join(folder, 'budget.json');
    const budget = new DailyLookupBudget(file, 2, () => clock);
    assert.deepEqual([await budget.take(), await budget.take(), await budget.take()], [true, true, false]);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { day: '2030-09-24', used: 2 });
    const restarted = new DailyLookupBudget(file, 2, () => clock);
    assert.equal(await restarted.take(), false);
    clock = new Date('2030-09-25T00:30:00.000Z');
    assert.equal(await restarted.take(), true);
    assert.equal(await restarted.used(), 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
