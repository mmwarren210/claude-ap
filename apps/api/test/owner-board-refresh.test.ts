import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OddsProvider } from '@crowniq/engine';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { ProductLedger } from '../src/product-ledger.js';
import { buildServer } from '../src/server.js';

const now=new Date('2030-09-24T12:00:00Z');

test('owner learning reports nflverse mapping validity without failing closed diagnostics',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-owner-learning-'));
  try{
    const ledger=new ProductLedger(join(folder,'ledger.json'),'CROWN_STRONG',()=>now);
    const owner=await ledger.register('owner-learning@example.org','abcdefghijkl','Learning_owner');
    const mapping=join(folder,'nflverse-map.json');
    const app=buildServer({product:ledger,requireProfiles:true,ownerPublicId:owner.profile.publicId,
      nflverseMappingFile:mapping,autoGradingEnabled:true,autoGradingStatus:()=>({
        running:false,scheduled:true,intervalMs:3_600_000,
        lastStartedAt:'2030-09-24T11:00:00.000Z',lastFinishedAt:'2030-09-24T11:00:01.000Z',
        nextRunAt:'2030-09-24T12:00:01.000Z',lastResult:{graded:2,pending:3},lastError:null,
      }),clock:()=>now});
    const headers={authorization:['Bearer',owner.token].join(' ')};
    try{
      const invalid=await app.inject({url:'/v1/owner/history/learning',headers});
      assert.equal(invalid.statusCode,200);
      assert.equal(invalid.json().autoGrading.enabled,true);
      assert.equal(invalid.json().autoGrading.automaticResolution,true);
      assert.equal(invalid.json().autoGrading.mappingStatus,'INVALID');
      assert.equal(invalid.json().autoGrading.mappingConfigured,false);
      assert.equal(invalid.json().autoGrading.worker.scheduled,true);
      assert.deepEqual(invalid.json().autoGrading.worker.lastResult,{graded:2,pending:3});
      assert.equal(invalid.json().autoGrading.worker.lastError,null);
      await writeFile(mapping,JSON.stringify({format:'crowniq-nflverse-map-v1',mappings:[]}));
      const valid=await app.inject({url:'/v1/owner/history/learning',headers});
      assert.equal(valid.statusCode,200);
      assert.equal(valid.json().autoGrading.mappingStatus,'VALID');
      assert.equal(valid.json().autoGrading.mappingConfigured,true);
    }finally{await app.close();}
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('configured owner can bootstrap the first board from the app',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-owner-board-'));
  try{
    const ledger=new ProductLedger(join(folder,'ledger.json'),'CROWN_STRONG',()=>now);
    const owner=await ledger.register('owner@example.org','abcdefghijkl','Board_owner');
    const guest=await ledger.register('guest@example.org','mnopqrstuvwx','Board_guest');
    let pulls=0;
    const provider:OddsProvider={id:'fixture-prizepicks',
      fetchPrizePicksLines:async()=>{pulls++;return [{}];},
      normalize:(_raw,fetchedAt)=>fixtureLine({id:'owner-board-line',sourceLineId:'owner-source',
        fetchedAt,eventStartTime:'2030-09-25T00:00:00Z'})};
    const app=buildServer({product:ledger,provider,requireProfiles:true,
      ownerPublicId:owner.profile.publicId,clock:()=>now});
    const ownerHeaders={authorization:['Bearer',owner.token].join(' ')};
    const guestHeaders={authorization:['Bearer',guest.token].join(' ')};
    try{
      assert.equal((await app.inject({method:'POST',url:'/v1/owner/board/refresh',
        headers:guestHeaders,payload:{acknowledgeProviderCost:true}})).statusCode,404);
      assert.equal((await app.inject({method:'POST',url:'/v1/owner/board/refresh',
        headers:ownerHeaders,payload:{}})).statusCode,428);
      const started=await app.inject({method:'POST',url:'/v1/owner/board/refresh',
        headers:ownerHeaders,payload:{acknowledgeProviderCost:true}});
      assert.equal(started.statusCode,202);
      assert.equal(started.json().started,true);

      let state:any=null;
      for(let attempt=0;attempt<25;attempt++){
        state=(await app.inject({url:'/v1/owner/board/status',headers:ownerHeaders})).json();
        if(state.job.status!=='RUNNING')break;
        await new Promise<void>((resolve)=>setImmediate(resolve));
      }
      assert.equal(state.job.status,'SUCCEEDED');
      assert.deepEqual(state.job.counts,{providerReturned:1,normalized:1,saved:1,
        qualified:0,exposed:1});
      assert.equal(pulls,1);
      const board=await app.inject({url:'/v1/board',headers:ownerHeaders});
      assert.equal(board.statusCode,200);
      assert.equal(board.json().board.lines.length,1);
      const diagnostics=await app.inject({url:'/v1/owner/board/diagnostics',headers:ownerHeaders});
      assert.equal(diagnostics.statusCode,200);
      assert.equal(diagnostics.json().lineCount,1);
      assert.equal(diagnostics.json().providerRefreshCost,0);
      assert.equal(diagnostics.json().boardFetchedAt,now.toISOString());
      assert.ok(typeof diagnostics.json().builtAt==='string');
      assert.deepEqual(diagnostics.json().lineTypes.counts,
        {REGULAR:1,GOBLIN:0,DEMON:0,UNKNOWN_ALTERNATE:0});
      assert.deepEqual(diagnostics.json().lineTypes.multiplierCoverage,
        {linesWithMultiplier:0,unknownWithMultiplier:0});
      assert.deepEqual(diagnostics.json().lineTypes.unknownByMarket,[]);
      assert.equal(diagnostics.json().modelSupport.unsupported,1);
      assert.equal(diagnostics.json().reasonCounts.MODEL_SUPPORT_INCOMPLETE,1);
      assert.equal((await app.inject({url:'/v1/owner/history/learning',
        headers:guestHeaders})).statusCode,404);
      const learning=await app.inject({url:'/v1/owner/history/learning',headers:ownerHeaders});
      assert.equal(learning.statusCode,200);
      assert.deepEqual({tracked:learning.json().tracked,pending:learning.json().pending,
        graded:learning.json().graded,dnpVoid:learning.json().dnpVoid},
        {tracked:0,pending:0,graded:0,dnpVoid:0});
      assert.equal(learning.json().autoGrading.enabled,false);
      assert.equal(learning.json().autoGrading.automaticResolution,true);
      assert.equal(learning.json().autoGrading.mappingConfigured,false);
      assert.equal(learning.json().autoGrading.mappingStatus,'MISSING');
      assert.equal(learning.json().autoGrading.pendingEligible,0);
      assert.equal(learning.json().autoGrading.manualMappedPending,0);
      assert.equal(learning.json().autoGrading.autoResolvePending,0);
      assert.equal(learning.json().autoGrading.source,'nflverse');
      assert.ok(learning.json().autoGrading.markets.includes('player_receptions'));
      assert.ok(learning.json().autoGrading.markets.includes('player_receiving_targets'));
      assert.equal(pulls,1);
      const reanalyzed=await app.inject({method:'POST',url:'/v1/owner/board/reanalyze',
        headers:ownerHeaders,payload:{}});
      assert.equal(reanalyzed.statusCode,200);
      assert.equal(reanalyzed.json().oddsCreditsUsed,0);
      assert.equal(pulls,1);
    }finally{await app.close();}
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('paid pulls: bootstrap only without a board, one pull at a time, confirmed admin pulls, restart reported',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-pull-guard-'));
  try{
    const ledger=new ProductLedger(join(folder,'ledger.json'),'CROWN_STRONG',()=>now);
    const owner=await ledger.register('pull-owner@example.org','abcdefghijkl','Pull_owner');
    let pulls=0,credits=500,release:()=>void=()=>undefined;
    let gate=Promise.resolve();
    // Synthetic provider: each pull spends 7 fake credits and can be held open by the test.
    const provider:OddsProvider={id:'fixture-prizepicks',
      fetchPrizePicksLines:async()=>{pulls++;await gate;credits-=7;return [{}];},
      normalize:(_raw,fetchedAt)=>fixtureLine({id:'guard-line',sourceLineId:'guard-source',
        fetchedAt,eventStartTime:'2030-09-25T00:00:00Z'}),
      getHealth:()=>({creditsRemaining:credits,lastRequestCost:7,lastHttpStatus:200})};
    const jobFile=join(folder,'owner-pull-job.json');
    const { OwnerPullJobStore }=await import('../src/owner-pull-job.js');
    const app=buildServer({product:ledger,provider,requireProfiles:true,adminToken:'admin-fixture',
      ownerPublicId:owner.profile.publicId,clock:()=>now,ownerJobStore:new OwnerPullJobStore(jobFile)});
    const ownerHeaders={authorization:['Bearer',owner.token].join(' ')};
    const admin={authorization:'Bearer admin-fixture'};
    const waitForJob=async()=>{
      for(let attempt=0;attempt<50;attempt++){
        const state=(await app.inject({url:'/v1/owner/board/status',headers:ownerHeaders})).json();
        if(state.job.status!=='RUNNING')return state.job;
        await new Promise<void>((resolve)=>setImmediate(resolve));
      }
      throw new Error('job did not finish');
    };
    try{
      assert.equal((await app.inject({method:'POST',url:'/v1/owner/board/bootstrap',headers:ownerHeaders,
        payload:{}})).statusCode,428);
      gate=new Promise<void>((resolve)=>{release=resolve;});
      const first=await app.inject({method:'POST',url:'/v1/owner/board/bootstrap',headers:ownerHeaders,
        payload:{acknowledgeProviderCost:true}});
      assert.equal(first.statusCode,202);
      assert.equal(first.json().started,true);
      // While the pull runs, nothing can start a second one.
      const again=await app.inject({method:'POST',url:'/v1/owner/board/refresh',headers:ownerHeaders,
        payload:{acknowledgeProviderCost:true}});
      assert.equal(again.json().started,false);
      assert.equal((await app.inject({method:'POST',url:'/v1/admin/refresh',headers:admin})).statusCode,428);
      assert.equal((await app.inject({method:'POST',url:'/v1/admin/refresh',
        headers:{...admin,'x-confirm-provider-cost':'yes'}})).statusCode,409);
      release();
      const done=await waitForJob();
      assert.equal(done.status,'SUCCEEDED');
      assert.equal(done.creditsSpent,7);
      assert.equal(done.creditsRemaining,493);
      assert.equal(pulls,1);
      // A board now exists, so the Board tab's recovery path cannot spend credits.
      const blocked=await app.inject({method:'POST',url:'/v1/owner/board/bootstrap',headers:ownerHeaders,
        payload:{acknowledgeProviderCost:true}});
      assert.equal(blocked.statusCode,409);
      assert.equal(blocked.json().code,'BOARD_EXISTS');
      assert.equal(pulls,1);
      const confirmed=await app.inject({method:'POST',url:'/v1/admin/refresh',
        headers:{...admin,'x-confirm-provider-cost':'yes'}});
      assert.equal(confirmed.statusCode,200);
      assert.equal(confirmed.json().creditsSpent,7);
      assert.equal(pulls,2);
    }finally{await app.close();}

    // Simulate a server that stopped mid-pull: the next start reports it instead of showing IDLE.
    await writeFile(jobFile,JSON.stringify({status:'RUNNING',startedAt:now.toISOString(),finishedAt:null,
      error:null,trackingStatus:'PENDING',tracked:0,webResearchJob:null,refreshStage:'provider',
      counts:{providerReturned:0,normalized:0,saved:0,qualified:0,exposed:0},
      creditsSpent:null,creditsRemaining:493}));
    const restarted=buildServer({product:ledger,provider,requireProfiles:true,
      ownerPublicId:owner.profile.publicId,clock:()=>now,ownerJobStore:new OwnerPullJobStore(jobFile)});
    try{
      await restarted.ready();
      const state=(await restarted.inject({url:'/v1/owner/board/status',headers:ownerHeaders})).json();
      assert.equal(state.job.status,'FAILED');
      assert.equal(state.job.error,'INTERRUPTED_BY_RESTART');
      assert.equal(state.job.trackingStatus,'FAILED');
    }finally{await restarted.close();}
  }finally{await rm(folder,{recursive:true,force:true});}
});
