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
