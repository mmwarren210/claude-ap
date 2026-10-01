import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { marketDefinitions, statHistoryReadyVersions } from '@crowniq/engine';
import type { ResearchTarget } from '@crowniq/engine';
import { InternalHistoryResearch, InternalHistoryStore, internalHistorySpecs } from '../src/internal-history.js';

const target:ResearchTarget={
  eventId:'future-event',eventName:'AAA @ BBB',eventStartTime:'2030-10-20T00:00:00.000Z',
  league:'NFL',playerId:'board-player',playerName:'Fixture QB',team:null,opponent:null,
  market:'passing_yards',sport:'NFL',
};

test('internal history seeds become attributed pre-event model evidence without line leakage',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'crowniq-history-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new InternalHistoryStore(join(dir,'history.json'),()=>new Date('2030-10-19T12:00:00.000Z'));
  const rows=Array.from({length:10},(_,index)=>({
    id:'seed-'+index,sport:'NFL' as const,playerId:'board-player',playerName:'Fixture QB',
    sourcePlayerId:'7',eventId:'old-'+index,
    occurredAt:new Date(Date.parse('2030-08-01T00:00:00.000Z')+index*7*86400_000).toISOString(),
    metrics:{passing_yds:220+index*8,pass_attempts:28+index,offensive_snaps:60},
    marketValues:{},sourceKind:'SEED_BACKFILL' as const,sourceName:'stat-api.com',
    sourceUrl:'https://api.stat-api.com/example',sourceType:'LICENSED_FEED' as const,
    importedAt:'2030-10-19T12:00:00.000Z',modelVersion:null,line:null,direction:null,
    lineScore:null,dataConfidence:null,
  }));
  assert.equal(await store.add(rows),10);
  assert.equal(await store.add(rows),0);
  const adapter=new InternalHistoryResearch(store,5,10,()=>new Date('2030-10-19T12:00:00.000Z'));
  const evidence=await adapter.research([target]);
  const projection=evidence.find((item)=>item.kind==='projection:passing_yards');
  assert.ok(projection);
  assert.equal(projection!.sourceType,'LICENSED_FEED');
  assert.ok(projection!.numeric!.baseline!>0);
  assert.ok(evidence.some((item)=>item.kind==='metric:expected_attempts'));
  assert.ok(evidence.some((item)=>item.kind==='metric:historical_current_form'));
  assert.ok(evidence.some((item)=>item.kind==='metric:stability'));
  assert.equal((await store.status()).bySource.SEED_BACKFILL,10);
});


test('internal history mirrors sixty percent factor coverage for the model-ready cohort',()=>{
  const ready=marketDefinitions.filter((definition)=>statHistoryReadyVersions.includes(definition.version));
  for(const definition of ready){
    const spec=internalHistorySpecs[definition.sport as keyof typeof internalHistorySpecs]?.[definition.market];
    assert.ok(spec,`missing internal history spec for ${definition.sport}:${definition.market}`);
    const available=new Set([...Object.keys(spec!.factors),'stability']);
    const factors=definition.factors.filter(([key])=>key!=='evidence_quality');
    const total=factors.reduce((sum,[,weight])=>sum+weight,0);
    const covered=factors.reduce((sum,[key,weight])=>sum+(available.has(key)?weight:0),0);
    assert.ok(covered/total>=.6,
      `${definition.sport}:${definition.market} only has ${covered}/${total} internal-history weight`);
  }
});


test('projection-only cache does not suppress targeted factor backfill',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'crowniq-history-coverage-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const incompleteStore=new InternalHistoryStore(join(dir,'incomplete.json'));
  const receiver={...target,playerId:'receiver-1',playerName:'Fixture Receiver',
    market:'player_reception_yds'};
  const incomplete=Array.from({length:10},(_,index)=>({
    id:'incomplete-'+index,sport:'NFL' as const,playerId:receiver.playerId,
    playerName:receiver.playerName,sourcePlayerId:null,eventId:'old-incomplete-'+index,
    occurredAt:new Date(Date.parse('2030-08-01T00:00:00.000Z')+index*7*86400_000).toISOString(),
    metrics:{receiving_yds:50+index*3},marketValues:{},
    sourceKind:'LIVE_GRADED' as const,sourceName:'Synthetic history',
    sourceUrl:'https://example.org/history',sourceType:'PUBLIC' as const,
    importedAt:'2030-10-19T12:00:00.000Z',modelVersion:null,line:null,direction:null,
    lineScore:null,dataConfidence:null,
  }));
  await incompleteStore.add(incomplete);
  assert.equal(await incompleteStore.hasMinimumSamples(receiver,5,10),true);
  assert.equal(await incompleteStore.hasModelReadyEvidence(receiver,5,10,.6),false);

  const completeStore=new InternalHistoryStore(join(dir,'complete.json'));
  const complete=incomplete.map((row,index)=>({...row,id:'complete-'+index,
    metrics:{receiving_yds:50+index*3,targets:6+index%3,offensive_snaps:45+index}}));
  await completeStore.add(complete);
  assert.equal(await completeStore.hasModelReadyEvidence(receiver,5,10,.6),true);
});
