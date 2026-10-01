import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { OddsProvider, ResearchAdapter } from '@crowniq/engine';
import { ModelRegistry, snapshotSelection } from '@crowniq/engine';
import { fixtureAnalysis, fixtureAssessment, fixtureLine, now } from '../../../packages/engine/test/fixtures.js';
import { NflPassingFileResearch } from '../src/nfl-evidence-file.js';
import { JsonSelectionLedger } from '../src/selection-ledger.js';
import { NflverseResultsFeed, parseNflverseStats } from '../src/nflverse-results.js';
import { buildServer } from '../src/server.js';

const later = new Date('2030-09-25T06:00:00.000Z');
const auth = { authorization: 'Bearer synthetic-owner-token', 'x-confirm-provider-cost': 'yes' };
const status = (overrides: Record<string, unknown> = {}) => ({
  id: 'fixture-availability', entityType: 'PLAYER', entityId: 'test-player-1',
  eventId: 'test-event', market: null, kind: 'status:qb_available',
  finding: 'Synthetic confirmed QB availability.', sourceName: 'Synthetic fixture',
  sourceUrl: 'https://example.org/test-only', sourceType: 'OFFICIAL',
  retrievedAt: now.toISOString(), expiresAt: '2030-09-24T15:00:00.000Z',
  quality: 'HIGH', confidence: 1, numeric: { value: 1 }, ...overrides,
});

test('evidence file scopes identities and rejects post-kickoff or unattributed inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crowniq-evidence-'));
  const path = join(dir, 'evidence.json');
  const adapter = new NflPassingFileResearch(path);
  const target = { eventId: 'test-event', eventStartTime: '2030-09-25T00:00:00.000Z',
    eventName: 'Fixture A @ Fixture B', playerName: 'Fixture QB',
    league: 'NFL', playerId: 'test-player-1', team: null, opponent: null,
    market: 'passing_yards', sport: 'NFL' as const };
  try {
    await writeFile(path, JSON.stringify({ format: 'crowniq-nfl-passing-evidence-v1',
      evidence: [status(), status({ id: 'other', entityId: 'another-player' })] }));
    assert.deepEqual((await adapter.research([target])).map((item) => item.id), ['fixture-availability']);
    await writeFile(path, JSON.stringify({ format: 'crowniq-nfl-passing-evidence-v1',
      evidence: [status({ retrievedAt: '2030-09-25T00:30:00.000Z' })] }));
    await assert.rejects(adapter.research([target]), /INVALID_PREGAME_EVIDENCE_TIME/);
    await writeFile(path, JSON.stringify({ format: 'crowniq-nfl-passing-evidence-v1',
      evidence: [status({ sourceUrl: null })] }));
    await assert.rejects(adapter.research([target]), /UNTRUSTED_PILOT_EVIDENCE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PASS gets targeted Second Look research and keeps the user-facing audit flag',async()=>{
  let pulls=0,secondLookCalls=0;
  const line=fixtureLine({id:'second-look-line',sourceLineId:'second-look-source'});
  const provider:OddsProvider={id:'synthetic-provider',
    fetchPrizePicksLines:async()=>{pulls++;return [line];},
    normalize:(raw,fetchedAt)=>({...raw as typeof line,fetchedAt})};
  const primary:ResearchAdapter={id:'primary-empty',research:async()=>[]};
  const secondLook:ResearchAdapter={id:'second-look-fixture',
    supports:(target)=>target.sport==='NFL'&&target.market==='passing_yards',
    research:async(targets)=>{
      secondLookCalls++;
      const target=targets[0];
      return [{id:'second-look-projection',entityType:'PLAYER',entityId:target.playerId,
        eventId:target.eventId,market:target.market,kind:'projection:passing_yards',
        finding:'Synthetic Second Look projection.',sourceName:'Synthetic fixture',
        sourceUrl:'https://example.org/second-look',sourceType:'LICENSED_FEED',
        retrievedAt:now.toISOString(),expiresAt:'2030-09-25T00:00:00.000Z',
        quality:'HIGH',confidence:1,numeric:{value:270,baseline:20,unit:'yards'}}];
    }};
  const models=new ModelRegistry();
  models.register({sport:'NFL',market:'passing_yards',version:'SECOND-LOOK-TEST',
    requiredEvidenceKinds:['projection:passing_yards'],
    assess:({phase})=>fixtureAssessment(phase,'MORE',88)});
  const app=buildServer({provider,models,research:primary,secondLookResearch:secondLook,
    adminToken:'synthetic-owner-token',clock:()=>now});
  try{
    const refreshed=await app.inject({method:'POST',url:'/v1/admin/refresh',headers:auth});
    assert.equal(refreshed.statusCode,200);
    const board=(await app.inject('/v1/board')).json();
    assert.equal(board.rankedLineIds.length,1);
    assert.equal(board.analyses[0].reviewStatus,'SECOND_LOOK');
    assert.equal(board.analyses[0].secondLook.initialReasonCode,'STALE_OR_MISSING_EVIDENCE');
    assert.equal(board.analyses[0].secondLook.evidenceAdded,1);
    assert.equal(board.analyses[0].score,88);
    const status=(await app.inject({url:'/v1/admin/status',headers:auth})).json();
    assert.equal(status.secondLook.finalReasons.UPGRADED,1);
    assert.equal(status.secondLook.bySport.NFL.reasons.UPGRADED,1);
    assert.equal(status.secondLook.byMarket['NFL:passing_yards'].upgraded,1);
    assert.equal(status.secondLook.coverageGaps.total,0);
    assert.equal(pulls,1);
    assert.equal(secondLookCalls,1);
  }finally{await app.close();}
});

test('owner can reanalyze without odds credits, save exact line, grade and inspect performance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crowniq-pilot-'));
  const evidenceFile = join(dir, 'evidence.json');
  const selectionsFile = join(dir, 'selections.json');
  await writeFile(evidenceFile, JSON.stringify({ format: 'crowniq-nfl-passing-evidence-v1',
    evidence: [status()] }));
  let pulls = 0;
  let clock = now;
  const line = fixtureLine({ availableDirections: ['MORE'] });
  const provider: OddsProvider = { id: 'synthetic-provider',
    fetchPrizePicksLines: async () => { pulls++; return [line]; },
    normalize: (raw, fetchedAt) => ({ ...raw as typeof line, fetchedAt }),
  };
  const models = new ModelRegistry();
  models.register({ sport: 'NFL', market: 'passing_yards', version: 'SYNTHETIC-TEST-MODEL',
    requiredEvidenceKinds: ['status:qb_available'],
    assess: ({ phase }) => fixtureAssessment(phase, 'MORE', 92) });
  const selections = new JsonSelectionLedger(selectionsFile);
  const app = buildServer({ provider, models, research: new NflPassingFileResearch(evidenceFile),
    selections, adminToken: 'synthetic-owner-token', clock: () => clock });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/refresh', headers: auth }))
      .json().rankedCount, 1);
    const rankings=(await app.inject('/v1/rankings')).json();
    assert.equal(rankings.rankings.length,1);
    assert.equal(rankings.rankings[0].rank,1);
    assert.equal(rankings.rankings[0].lineId,line.id);
    assert.equal(rankings.rankings[0].playerName,line.playerName);
    assert.equal(rankings.rankings[0].threshold,line.threshold);
    assert.equal(rankings.rankings[0].direction,'MORE');
    assert.ok(rankings.rankings[0].score>=80);
    assert.deepEqual(rankings.watchlistLineIds,[]);
    assert.deepEqual(rankings.watchlist,[]);
    assert.equal(pulls,1);
    assert.equal((await app.inject({ method:'POST',url:'/v1/admin/reanalyze',headers:auth,payload:{} }))
      .statusCode,428);
    const reanalyzed=await app.inject({method:'POST',url:'/v1/admin/reanalyze',headers:auth,
      payload:{acknowledgeResearchCost:true}});
    assert.equal(reanalyzed.statusCode,200);
    assert.equal(reanalyzed.json().oddsCreditsUsed,0);
    assert.equal(pulls,1);
    const saved = await app.inject({ method: 'POST', url: '/v1/admin/selections',
      headers: auth, payload: { lineId: line.id } });
    assert.equal(saved.statusCode, 201);
    assert.equal(saved.json().evidenceSnapshot[0].id, 'fixture-availability');
    const replacement = await app.inject({ method: 'POST', url: '/v1/admin/selections',
      headers: auth, payload: { lineId: line.id } });
    assert.equal(replacement.statusCode, 422);
    clock = later;
    assert.equal((await app.inject('/v1/board')).json().rankedLineIds.length, 0);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/selections',
      headers: auth, payload: { lineId: line.id } })).statusCode, 422);
    const outcome = { eventId: line.eventId, playerId: line.playerId,
      market: 'passing_yards', status: 'FINAL', observedValue: 270,
      completedAt: '2030-09-25T04:00:00.000Z', retrievedAt: '2030-09-25T05:00:00.000Z',
      sourceName: 'Synthetic result', sourceUrl: 'https://example.org/test-only' };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/results',
      headers: auth, payload: { results: [outcome] } })).json().graded, 1);
    assert.equal((await app.inject({ url: '/v1/admin/performance', headers: auth }))
      .json().groups[0].win, 1);
    assert.equal((await app.inject('/v1/admin/selections')).statusCode, 401);
    assert.equal(JSON.parse(await readFile(selectionsFile, 'utf8')).selections[0].line.threshold, 240.5);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('QB status freshness ceiling removes rankings before source expiry without another provider call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crowniq-expiry-'));
  const evidenceFile = join(dir, 'evidence.json');
  await writeFile(evidenceFile, JSON.stringify({ format: 'crowniq-nfl-passing-evidence-v1',
    evidence: [status({ expiresAt: '2030-09-25T23:00:00.000Z' })] }));
  let clock = now, pulls = 0;
  const line = fixtureLine();
  const provider: OddsProvider = { id: 'synthetic-provider',
    fetchPrizePicksLines: async () => { pulls++; return [line]; },
    normalize: (raw, fetchedAt) => ({ ...raw as typeof line, fetchedAt }),
  };
  const models = new ModelRegistry();
  models.register({ sport: 'NFL', market: 'passing_yards', version: 'SYNTHETIC-TEST-MODEL',
    requiredEvidenceKinds: ['status:qb_available'],
    assess: ({ phase }) => fixtureAssessment(phase, 'MORE', 92) });
  const app = buildServer({ provider, models, research: new NflPassingFileResearch(evidenceFile),
    adminToken: 'synthetic-owner-token', clock: () => clock });
  try {
    await app.inject({ method: 'POST', url: '/v1/admin/refresh', headers: auth });
    assert.equal((await app.inject('/v1/board')).json().rankedLineIds.length, 1);
    clock = new Date(now.getTime() + 6 * 60 * 60 * 1000 + 1);
    const expired = (await app.inject('/v1/board')).json();
    assert.deepEqual(expired.rankedLineIds, []);
    assert.equal(expired.analyses[0].reasonCode, 'STALE_OR_MISSING_EVIDENCE');
    assert.equal(pulls, 1);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('nflverse mapping grades only an explicit player/game/team match; absent row remains pending', async () => {
  const csv = 'player_id,game_id,team,attempts,passing_yards,extra\n' +
    '00-0000001,2030_03_AAA_BBB,BBB,34,271,"quoted, field"\n';
  assert.equal(parseNflverseStats(csv)[0].passing_yards, '271');
  const line = fixtureLine();
  const selection = snapshotSelection(line, fixtureAnalysis(line), [], now);
  const dir = await mkdtemp(join(tmpdir(), 'crowniq-nflverse-'));
  const mapFile = join(dir, 'map.json');
  const ledger = new JsonSelectionLedger(join(dir, 'ledger.json'));
  const feed = new NflverseResultsFeed(async () => new Response(csv, { status: 200 }));
  try {
    await ledger.save(selection);
    await writeFile(mapFile, JSON.stringify({ format: 'crowniq-nflverse-map-v1', mappings: [{
      eventId: line.eventId, playerId: line.playerId, nflverseGameId: '2030_03_AAA_BBB',
      nflversePlayerId: '00-0000001', team: 'BBB', season: 2030,
      completedAt: '2030-09-25T04:00:00.000Z',
    }] }));
    const app = buildServer({ selections: ledger, nflverseMappingFile: mapFile,
      nflverseFeed: feed, adminToken: 'synthetic-owner-token', clock: () => later });
    try {
      const absent = new NflverseResultsFeed(async () => new Response(csv.replace('00-0000001',
        '00-OTHER'), { status: 200 }));
      const absentApp = buildServer({ selections: ledger, nflverseMappingFile: mapFile,
        nflverseFeed: absent, adminToken: 'synthetic-owner-token', clock: () => later });
      try {
        const response = await absentApp.inject({ method: 'POST',
          url: '/v1/admin/grade/nflverse', headers: auth });
        assert.equal(response.json().graded, 0);
        assert.equal((await ledger.list())[0].grade, 'PENDING');
      } finally { await absentApp.close(); }
      const failedApp = buildServer({ selections: ledger, nflverseMappingFile: mapFile,
        nflverseFeed: new NflverseResultsFeed(async () => new Response('outage', { status: 503 })),
        adminToken: 'synthetic-owner-token', clock: () => later });
      try {
        assert.equal((await failedApp.inject({ method: 'POST',
          url: '/v1/admin/grade/nflverse', headers: auth })).statusCode, 502);
        assert.equal((await ledger.list())[0].grade, 'PENDING');
      } finally { await failedApp.close(); }
      const graded = await app.inject({ method: 'POST', url: '/v1/admin/grade/nflverse', headers: auth });
      assert.equal(graded.statusCode, 200);
      assert.equal(graded.json().graded, 1);
      assert.equal((await ledger.list())[0].gradeDetail?.observedValue, 271);
    } finally { await app.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
