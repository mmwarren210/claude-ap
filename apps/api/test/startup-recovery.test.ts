import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Evidence } from '@crowniq/contracts';
import type { OddsProvider, ResearchAdapter } from '@crowniq/engine';
import { ModelRegistry } from '@crowniq/engine';
import { fixtureAssessment, fixtureLine, now } from '../../../packages/engine/test/fixtures.js';
import { BoardCache } from '../src/board-cache.js';
import { BoardService } from '../src/board-service.js';

const before=new Date(now.getTime()-2*3600_000).toISOString();
const expired=new Date(now.getTime()-3600_000).toISOString();
const future=new Date(now.getTime()+3600_000).toISOString();
function evidence(id:string,kind:string,live=false):Evidence {
  return {id,entityType:'PLAYER',entityId:'test-player-1',eventId:'test-event',
    market:kind.startsWith('status:')?null:'passing_yards',kind,
    finding:'Synthetic startup recovery evidence.',sourceName:'Synthetic fixture',
    sourceUrl:'https://example.org/startup-only',sourceType:'OFFICIAL',
    retrievedAt:live?now.toISOString():before,expiresAt:live?(kind.startsWith('status:')?future:new Date(now.getTime()+2*3600_000).toISOString()):expired,
    quality:'HIGH',confidence:1,numeric:{value:kind.startsWith('status:')?1:270}};
}
function models(){
  const registry=new ModelRegistry();
  registry.register({sport:'NFL',market:'passing_yards',version:'startup-fixture',
    calibrationApproved:true,requiredEvidenceKinds:['projection:passing_yards','status:qb_available'],
    assess:({phase})=>fixtureAssessment(phase,'MORE',88)});
  return registry;
}
async function setup(statusLive=false){
  const folder=await mkdtemp(join(tmpdir(),'crowniq-startup-'));
  const cache=new BoardCache(join(folder,'board.json'));
  const board={provider:'prizepicks' as const,fetchedAt:before,lines:[fixtureLine({fetchedAt:before})]};
  await cache.save({board,evidence:[evidence('old-history','projection:passing_yards'),
    evidence('current:qb','status:qb_available',statusLive)],researchStatus:'OK',
    lastSuccessfulRefresh:before});
  return {folder,cache,board};
}
test('startup recovers local history without pulling odds or reviving expired hard facts',async()=>{
  const {folder,cache,board}=await setup();
  let pulls=0,remoteResearch=0,localCalls=0;
  const provider:OddsProvider={id:'synthetic-provider',fetchPrizePicksLines:async()=>{pulls++;return [];},
    normalize:()=>fixtureLine()};
  const remote:ResearchAdapter={id:'synthetic-paid',research:async()=>{remoteResearch++;return [];}};
  const local:ResearchAdapter={id:'synthetic-local-history',research:async(targets)=>{
    localCalls++;assert.equal(targets.length,1);
    return [evidence('new-history-'+localCalls,'projection:passing_yards',true)];
  }};
  try{
    const service=new BoardService(provider,remote,models(),()=>now,cache,remote,local);
    assert.equal(await service.restore(),true);
    await service.recoverStartupEvidence();
    assert.equal(service.getBoard()!.board.fetchedAt,board.fetchedAt);
    assert.equal(service.getStatus().lastSuccessfulRefresh,before);
    assert.equal(service.getBoard()!.analyses[0].direction,'PASS');
    assert.deepEqual(service.getStatus().evidenceFreshness,{total:2,active:1,expired:1});
    assert.equal(service.getStatus().freshContext.evidenceCount,0);
    assert.deepEqual(service.getStatus().startupRecovery,
      {status:'SUCCEEDED',evidenceAdded:1,oddsCreditsUsed:0,error:null});
    assert.equal(pulls,0);assert.equal(remoteResearch,0);assert.equal(localCalls,1);
    assert.deepEqual(service.getEvidence().map((item)=>item.id),['current:qb','new-history-1']);
    assert.equal((await cache.load())!.lastSuccessfulRefresh,before);
    // Another restart replaces the same stale semantic history record instead of accumulating copies.
    const again=new BoardService(provider,remote,models(),()=>now,cache,remote,local);
    await again.restore();
    await again.recoverStartupEvidence();
    assert.equal(again.getEvidence().length,2);
  }finally{await rm(folder,{recursive:true,force:true});}
});
test('recovered history can rank only with still-valid hard facts; health ages them on read',async()=>{
  const {folder,cache}=await setup(true);
  let clock=now;
  const local:ResearchAdapter={id:'local',research:async()=>[
    evidence('recovered-history','projection:passing_yards',true)]};
  try{
    const service=new BoardService(null,null,models(),()=>clock,cache,null,local);
    await service.restore();
    await service.recoverStartupEvidence();
    assert.equal(service.getBoard()!.rankedLineIds.length,1);
    assert.equal(service.getStatus().freshContext.evidenceCount,1);
    // Current status expires while the historical projection is still active.
    clock=new Date(now.getTime()+61*60_000);
    const aged=service.getStatus();
    assert.equal(service.getBoard()!.rankedLineIds.length,0);
    assert.equal(aged.freshContext.evidenceCount,0);
    assert.equal(aged.evidenceFreshness.active,1);
  }finally{await rm(folder,{recursive:true,force:true});}
});
test('startup history failure preserves the original board and evidence',async()=>{
  const {folder,cache}=await setup();
  const local:ResearchAdapter={id:'failing-local',research:async()=>{throw new Error('fixture failure');}};
  try{
    const service=new BoardService(null,null,models(),()=>now,cache,null,local);
    assert.equal(await service.restore(),true);
    await service.recoverStartupEvidence();
    assert.equal(service.getBoard()!.board.lines.length,1);
    assert.equal(service.getStatus().startupRecovery.status,'FAILED');
    assert.deepEqual(service.getEvidence().map((item)=>item.id),['old-history','current:qb']);
    assert.deepEqual((await cache.load())!.evidence.map((item)=>item.id),['old-history','current:qb']);
  }finally{await rm(folder,{recursive:true,force:true});}
});
test('startup persistence failure retains the original in-memory snapshot',async()=>{
  const {folder,cache}=await setup();
  const local:ResearchAdapter={id:'local',research:async()=>[
    evidence('recovered-history','projection:passing_yards',true)]};
  cache.save=async()=>{throw new Error('synthetic disk failure');};
  try{
    const service=new BoardService(null,null,models(),()=>now,cache,null,local);
    assert.equal(await service.restore(),true);
    await service.recoverStartupEvidence();
    assert.equal(service.getStatus().startupRecovery.status,'FAILED');
    assert.deepEqual(service.getEvidence().map((item)=>item.id),['old-history','current:qb']);
  }finally{await rm(folder,{recursive:true,force:true});}
});
test('fresh saved evidence skips startup history research',async()=>{
  const {folder,cache,board}=await setup(true);
  let calls=0;
  await cache.save({board,evidence:[evidence('fresh-history','projection:passing_yards',true),
    evidence('current:qb','status:qb_available',true)],researchStatus:'OK',lastSuccessfulRefresh:before});
  try{
    const service=new BoardService(null,null,models(),()=>now,cache,null,
      {id:'unused-local',research:async()=>{calls++;return [];}});
    await service.restore();
    await service.recoverStartupEvidence();
    assert.equal(calls,0);
    assert.equal(service.getStatus().startupRecovery.status,'NOT_NEEDED');
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('API serves its restored board while local startup recovery is still running',async()=>{
  const {folder,cache}=await setup();
  let release!:(items:Evidence[])=>void;
  const pending=new Promise<Evidence[]>((resolve)=>{release=resolve;});
  const {buildServer}=await import('../src/server.js');
  const app=buildServer({boardCache:cache,models:models(),clock:()=>now,
    startupResearch:{id:'deferred-local',research:()=>pending}});
  try{
    const response=await app.inject('/health');
    assert.equal(response.statusCode,200);
    assert.equal(response.json().lineCount,1);
    assert.equal(response.json().startupRecovery.status,'RUNNING');
    assert.equal((await app.inject('/v1/board')).statusCode,200);
    release([evidence('local-history','projection:passing_yards',true)]);
    let state=response.json();
    for(let attempt=0;attempt<100&&state.startupRecovery.status==='RUNNING';attempt++){
      await new Promise<void>((resolve)=>setTimeout(resolve,5));
      state=(await app.inject('/health')).json();
    }
    assert.equal(state.startupRecovery.status,'SUCCEEDED');
  }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});
test('owner reanalysis waits for startup recovery and publishes its own current evidence last',async()=>{
  const {folder,cache}=await setup();
  let release!:(items:Evidence[])=>void,remoteCalls=0;
  const pending=new Promise<Evidence[]>((resolve)=>{release=resolve;});
  const local:ResearchAdapter={id:'deferred-local',research:()=>pending};
  const research:ResearchAdapter={id:'explicit-reanalysis',research:async()=>{
    remoteCalls++;return [evidence('explicit-history','projection:passing_yards',true),
      evidence('current:explicit-qb','status:qb_available',true)];
  }};
  try{
    const service=new BoardService(null,research,models(),()=>now,cache,null,local);
    await service.restore();
    const recovery=service.recoverStartupEvidence();
    await new Promise<void>((resolve)=>setImmediate(resolve));
    const reanalysis=service.reanalyze();
    await new Promise<void>((resolve)=>setImmediate(resolve));
    assert.equal(remoteCalls,0);
    release([evidence('local-history','projection:passing_yards',true)]);
    await Promise.all([recovery,reanalysis]);
    assert.equal(remoteCalls,1);
    assert.deepEqual(service.getEvidence().map((item)=>item.id),['explicit-history','current:explicit-qb']);
    assert.deepEqual((await cache.load())!.evidence.map((item)=>item.id),
      ['explicit-history','current:explicit-qb']);
  }finally{await rm(folder,{recursive:true,force:true});}
});
