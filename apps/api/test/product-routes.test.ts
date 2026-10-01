import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSchema } from '@crowniq/contracts';
import type { OddsProvider } from '@crowniq/engine';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { ProductLedger } from '../src/product-ledger.js';
import { BoardCache } from '../src/board-cache.js';
import { buildServer } from '../src/server.js';

test('ordinary mobile reads cannot spend provider credits, owner force refresh requires acknowledgement',async()=>{
  let calls=0;const clock=()=>new Date('2030-09-24T12:00:00Z');
  const provider:OddsProvider={id:'synthetic',fetchPrizePicksLines:async()=>{calls++;return [{id:'fixture'}];},
    normalize:(_raw,fetchedAt)=>fixtureLine({fetchedAt})};
  const folder=await mkdtemp(join(tmpdir(),'crowniq-routes-'));
  const app=buildServer({provider,clock,adminToken:'owner-only',
    product:new ProductLedger(join(folder,'product.json'),'CROWN_STRONG',clock)});
  try {
    for(let n=0;n<10;n++){
      assert.equal((await app.inject('/v1/board')).statusCode,503);
      assert.equal((await app.inject('/v1/rankings')).statusCode,503);
      assert.equal((await app.inject('/v1/board/summary')).statusCode,503);
    }
    assert.equal(calls,0);
    assert.equal((await app.inject({method:'POST',url:'/v1/admin/force-provider-refresh'})).statusCode,401);
    const auth={authorization:'Bearer owner-only'};
    assert.equal((await app.inject({method:'POST',url:'/v1/admin/force-provider-refresh',headers:auth})).statusCode,428);
    assert.equal(calls,0);
    assert.equal((await app.inject({method:'POST',url:'/v1/admin/force-provider-refresh',
      headers:{...auth,'x-confirm-provider-cost':'yes'}})).statusCode,200);
    assert.equal(calls,1);
    for(let n=0;n<10;n++){
      assert.equal((await app.inject('/v1/board')).statusCode,200);
      assert.equal((await app.inject('/v1/board/summary')).json().providerRefreshCost,0);
    }
    assert.equal(calls,1);
    assert.equal((await app.inject({method:'POST',url:'/v1/social/profile',
      payload:{displayName:'Anyone'}})).statusCode,503);
    assert.equal((await app.inject('/v1/social/top-users')).json().users.length,0);
  } finally {await app.close();await rm(folder,{recursive:true,force:true});}
});

test('the saved board survives a restart without a paid refresh and stays accurately dated',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-board-cache-'));
  const cache=new BoardCache(join(folder,'board.json'));
  let calls=0,clock=new Date('2030-09-24T12:00:00Z');
  const provider:OddsProvider={id:'synthetic',fetchPrizePicksLines:async()=>{calls++;return [{id:'x'}];},
    normalize:(_raw,fetchedAt)=>fixtureLine({fetchedAt,
      eventStartTime:'2030-09-25T00:00:00Z'})};
  const original=buildServer({provider,boardCache:cache,clock:()=>clock,
    adminToken:'owner-only'});
  try {
    await original.inject({method:'POST',url:'/v1/admin/refresh',
      headers:{authorization:'Bearer owner-only'}});
    assert.equal(calls,1);
  }finally{await original.close();}
  clock=new Date('2030-09-24T13:00:00Z');
  const restarted=buildServer({provider,boardCache:cache,clock:()=>clock});
  try {
    const board=(await restarted.inject('/v1/board')).json();
    assert.equal(board.board.fetchedAt,'2030-09-24T12:00:00.000Z');
    assert.equal((await restarted.inject('/v1/board/summary')).json().providerRefreshCost,0);
    assert.equal(calls,1);
  }finally{await restarted.close();await rm(folder,{recursive:true,force:true});}
});

test('restored cache applies verified provider market aliases without a paid refresh',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-cache-alias-'));
  const cache=new BoardCache(join(folder,'board.json'));
  let calls=0;const clock=()=>new Date('2030-09-24T12:00:00Z');
  const line=fixtureLine({id:'nhl-points',sourceLineId:'nhl-points-source',
    sourceSportKey:'icehockey_nhl',sourceMarketKey:'player_points',sport:'NHL',league:'NHL',
    market:'player_points',eventStartTime:'2030-09-25T00:00:00Z',
    fetchedAt:'2030-09-24T11:00:00Z'});
  await cache.save({board:boardSchema.parse({provider:'prizepicks',
    fetchedAt:'2030-09-24T11:00:00Z',lines:[line]}),evidence:[],
    researchStatus:'UNCONFIGURED',lastSuccessfulRefresh:null,secondLookAudits:{}});
  const provider:OddsProvider={id:'synthetic',fetchPrizePicksLines:async()=>{calls++;return [];},
    normalize:()=>{throw new Error('provider should not be called');}};
  const app=buildServer({provider,boardCache:cache,clock});
  try{
    const restored=(await app.inject('/v1/board')).json();
    assert.equal(restored.board.lines[0].market,'points');
    assert.equal(restored.board.lines[0].sourceMarketKey,'player_points');
    assert.equal(restored.board.fetchedAt,'2030-09-24T11:00:00Z');
    assert.equal(calls,0);
  }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});

test('Social write identity is server trusted and public profiles hide private actor keys',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-social-routes-'));
  const app=buildServer({product:new ProductLedger(join(folder,'ledger.json')),
    socialActor:(request)=>request.headers['x-test-actor']==='owner'?'private-owner':null});
  try {
    assert.equal((await app.inject({method:'POST',url:'/v1/social/profile',
      payload:{displayName:'Public'}})).statusCode,401);
    const profile=await app.inject({method:'POST',url:'/v1/social/profile',
      headers:{'x-test-actor':'owner'},payload:{displayName:'Public'}});
    assert.equal(profile.statusCode,200);
    const id=profile.json().publicId;
    const publicProfile=await app.inject(`/v1/social/user/${id}`);
    assert.equal(publicProfile.json().displayName,'Public');
    assert.ok(!publicProfile.body.includes('private-owner'));
    assert.equal((await app.inject('/v1/social/following-crowns')).statusCode,401);
    const following=await app.inject({url:'/v1/social/following-crowns',
      headers:{'x-test-actor':'owner'}});
    assert.equal(following.statusCode,200);
    assert.deepEqual(following.json(),{crowns:[]});
    assert.equal((await app.inject({method:'POST',url:`/v1/social/follow/${id}`,
      headers:{'x-test-actor':'owner'}})).statusCode,422); // self-follow
  }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});
