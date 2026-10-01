import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Board } from '@crowniq/contracts';
import type { OddsProvider } from '@crowniq/engine';
import { researchTargetsFor } from '@crowniq/engine';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { buildServer } from '../src/server.js';
import { ProductLedger } from '../src/product-ledger.js';
import { extractWebFindings, planWebResearch, sourceHintsFor,
  WebResearchAdapter, WebResearchCatalog } from '../src/web-research.js';

const at = new Date('2030-09-24T12:00:00.000Z');
const source = 'https://www.nfl.com/stats/player-stats';
const other = 'https://invented.example.com/fake';

function response(findings: unknown[], cited = [source]) {
  return { status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { sources: cited.map((url) => ({ url })) } },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ findings }) }] },
  ] };
}

function board(): Board {
  return { provider: 'prizepicks', fetchedAt: at.toISOString(), lines: [
    fixtureLine(),
    fixtureLine({ id: 'other-direction', market: 'player_pass_attempts', threshold: 31.5 }),
    fixtureLine({ id: 'mlb-line', sport: 'MLB', league: 'MLB', eventId: 'baseball-game',
      playerId: 'batter', playerName: 'Test Batter', market: 'batter_hits',
      eventName: 'Club C vs Club D' }),
    fixtureLine({ id: 'mls-line', sport: 'OTHER', league: 'MLS', eventId: 'soccer-game',
      playerId: 'forward', playerName: 'Test Forward', market: 'shots',
      eventName: 'Club E vs Club F' }),
  ] };
}

test('full-board search plan deduplicates markets and gives every sport a relevant query', () => {
  const plans = planWebResearch(researchTargetsFor(board()), at);
  assert.equal(plans.length, 3);
  assert.deepEqual(plans.find((plan) => plan.sport === 'NFL')?.markets,
    ['passing_yards', 'player_pass_attempts']);
  assert.match(plans.find((plan) => plan.sport === 'MLB')!.query, /starting pitcher/);
  assert.match(plans.find((plan) => plan.sport === 'OTHER')!.query, /MLS/);
  assert.deepEqual(sourceHintsFor('OTHER', 'MLS'), ['mlssoccer.com']);
  assert.deepEqual(sourceHintsFor('NFL', 'NFL', ['nfl.com']), ['nfl.com']);
  assert.equal(planWebResearch(researchTargetsFor(board()), new Date('2030-09-25T00:00:00Z')).length, 0);
});

test('only actually searched citations become short-lived, low confidence context', () => {
  const plan = planWebResearch(researchTargetsFor(board()), at).find((item) => item.sport === 'NFL')!;
  const valid = { category: 'recent_stats', claim: 'A dated recent box score is available.',
    source_url: source, published_at: '2030-09-23T18:00:00Z' };
  const extracted = extractWebFindings(response([valid, { ...valid, source_url: other },
    { ...valid, category: 'injury', claim: 'A three-week-old status is stale.',
      published_at: '2030-08-30T12:00:00Z' }]), plan, at);
  assert.equal(extracted.evidence.length, 1);
  assert.equal(extracted.evidence[0].sourceUrl, source);
  assert.equal(extracted.evidence[0].sourceType, 'AI_STRUCTURED');
  assert.equal(extracted.evidence[0].numeric, undefined);
  assert.equal(extracted.evidence[0].expiresAt, '2030-09-24T14:00:00.000Z');
  assert.throws(() => extractWebFindings({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ findings: [valid] }) }] },
  ] }, plan, at), /WEB_SEARCH_NOT_COMPLETED/);
});

test('web adapter searches, persists exact queries and websites, and reuses its cache', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-research-'));
  const path = join(folder, 'catalog.json');
  let calls = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tool_choice, 'required');
    assert.deepEqual(body.include, ['web_search_call.action.sources']);
    return new Response(JSON.stringify(response([{ category: 'recent_stats',
      claim: 'A dated recent box score is available.', source_url: source,
      published_at: '2030-09-23T18:00:00Z' }])), { status: 200 });
  };
  try {
    const target = researchTargetsFor({ ...board(), lines: [board().lines[0], board().lines[1]] });
    const first = new WebResearchAdapter({ apiKey: 'synthetic-test-key', fetchFn,
      catalog: new WebResearchCatalog(path), clock: () => at });
    assert.equal((await first.research(target)).length, 1);
    assert.equal(first.getHealth().status, 'OK');
    assert.equal(calls, 1);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.searches[0].query.includes('Test Player'), true);
    assert.deepEqual(saved.searches[0].sourceUrls, [source]);
    const second = new WebResearchAdapter({ apiKey: 'synthetic-test-key', fetchFn,
      catalog: new WebResearchCatalog(path), clock: () => at });
    assert.equal((await second.research(target)).length, 1);
    assert.equal(second.getHealth().cacheHits, 1);
    assert.equal(calls, 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('partial or uncited searches are reported and never create scored inputs', async () => {
  const target = researchTargetsFor({ ...board(), lines: [board().lines[0], board().lines[2]] });
  let calls = 0;
  const adapter = new WebResearchAdapter({ apiKey: 'synthetic-test-key',
    clock: () => at, concurrency: 1,
    fetchFn: async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify(response([{ category: 'recent_stats',
        claim: 'This model-generated claim lacks a consulted citation.', source_url: other,
        published_at: null }])), { status: 200 });
      return new Response('unavailable', { status: 400 });
    } });
  assert.deepEqual(await adapter.research(target), []);
  assert.equal(adapter.getHealth().status, 'FAILED');
  assert.equal(adapter.getHealth().noSources, 1);
  assert.equal(adapter.getHealth().failures, 1);
});

test('pulls never start web research; it runs on request and stays out of scoring', async () => {
  const provider: OddsProvider = { id: 'fixture-provider',
    fetchPrizePicksLines: async () => [{ id: 'fixture' }],
    normalize: (_raw, fetchedAt) => fixtureLine({ fetchedAt }),
  };
  let calls = 0;
  const adapter = new WebResearchAdapter({ apiKey: 'synthetic-test-key', clock: () => at,
    fetchFn: async () => {
      calls++;
      return new Response(JSON.stringify(response([{ category: 'recent_stats',
        claim: 'A dated recent box score is available.', source_url: source,
        published_at: '2030-09-23T18:00:00Z' }])), { status: 200 });
    } });
  const app = buildServer({ provider, adminToken: 'fixture-owner-token', webResearch: adapter,
    clock: () => at });
  const headers = { authorization: 'Bearer fixture-owner-token', 'x-confirm-provider-cost': 'yes' };
  try {
    assert.equal((await app.inject('/v1/admin/research/catalog')).statusCode, 401);
    const refreshed = await app.inject({ method: 'POST', url: '/v1/admin/refresh', headers });
    assert.equal(refreshed.statusCode, 200);
    // A paid odds pull does not also spend OpenAI searches.
    assert.equal(refreshed.json().webResearchJob, null);
    assert.equal(calls, 0);
    const started = await app.inject({ method: 'POST', url: '/v1/admin/research/start', headers });
    assert.equal(started.statusCode, 202);
    for (let i = 0; i < 20; i++) {
      const state = (await app.inject({ url: '/v1/admin/research/status', headers })).json().job;
      if (state.status !== 'RUNNING') break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const status = (await app.inject({ url: '/v1/admin/research/status', headers })).json().job;
    assert.equal(status.status, 'COMPLETE');
    assert.equal(status.evidenceCount, 1);
    assert.equal((await app.inject({ url: '/v1/admin/evidence', headers })).json().evidence.length, 1);
    assert.equal((await app.inject({ url: '/v1/admin/research/catalog', headers })).json().total, 1);
    const boardResponse = (await app.inject('/v1/board')).json();
    assert.equal(boardResponse.analyses[0].direction, 'PASS');
    // The finding is listed for display but never counted as model evidence.
    assert.equal(boardResponse.analyses[0].evidenceIds.length, 0);
    assert.equal(boardResponse.analyses[0].contextEvidenceIds.length, 1);
    assert.equal(boardResponse.analyses[0].evidenceExpiresAt, null);
    await app.inject('/v1/rankings');
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('owner starts web research only with an explicit cost confirmation', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-owner-web-'));
  let calls = 0;
  const adapter = new WebResearchAdapter({ apiKey: 'synthetic-test-key', clock: () => at, maxSearches: 25,
    fetchFn: async () => { calls++; return new Response(JSON.stringify(response([])), { status: 200 }); } });
  const provider: OddsProvider = { id: 'fixture-provider', fetchPrizePicksLines: async () => [{ id: 'fixture' }],
    normalize: (_raw, fetchedAt) => fixtureLine({ fetchedAt }) };
  try {
    const ledger = new ProductLedger(join(folder, 'ledger.json'), 'CROWN_STRONG', () => at);
    const owner = await ledger.register('web-owner@example.org', 'abcdefghijkl', 'Web_owner');
    const app = buildServer({ provider, product: ledger, requireProfiles: true, webResearch: adapter,
      ownerPublicId: owner.profile.publicId, clock: () => at });
    const headers = { authorization: 'Bearer ' + owner.token };
    try {
      assert.equal((await app.inject({ method: 'POST', url: '/v1/owner/board/web-research', headers,
        payload: { acknowledgeResearchCost: true } })).statusCode, 503);
      await app.inject({ method: 'POST', url: '/v1/owner/board/bootstrap', headers,
        payload: { acknowledgeProviderCost: true } });
      for (let i = 0; i < 50 && (await app.inject({ url: '/v1/board', headers })).statusCode !== 200; i++)
        await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 0);
      assert.equal((await app.inject({ method: 'POST', url: '/v1/owner/board/web-research', headers,
        payload: {} })).statusCode, 428);
      const started = await app.inject({ method: 'POST', url: '/v1/owner/board/web-research', headers,
        payload: { acknowledgeResearchCost: true } });
      assert.equal(started.statusCode, 202);
      assert.equal(started.json().maxSearches, 25);
    } finally { await app.close(); }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
