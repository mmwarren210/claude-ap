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
      headers:{authorization:'Bearer owner-only','x-confirm-provider-cost':'yes'}});
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

test('the public demo shows the next three days of real lines without a profile, and nothing else',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-demo-routes-'));
  const cache=new BoardCache(join(folder,'board.json'));
  const clock=()=>new Date('2030-09-24T12:00:00Z');
  const line=(id:string,eventStartTime:string)=>fixtureLine({id,sourceLineId:id,playerId:id,eventStartTime,
    fetchedAt:'2030-09-24T11:00:00Z'});
  await cache.save({board:boardSchema.parse({provider:'prizepicks',fetchedAt:'2030-09-24T11:00:00Z',
    lines:[line('started','2030-09-24T11:00:00Z'),line('tomorrow','2030-09-25T00:00:00Z'),
      line('day-three','2030-09-27T11:00:00Z'),line('next-week','2030-10-01T00:00:00Z')]}),evidence:[],
    researchStatus:'UNCONFIGURED',lastSuccessfulRefresh:null,secondLookAudits:{}});
  const app=buildServer({product:new ProductLedger(join(folder,'ledger.json')),requireProfiles:true,
    boardCache:cache,clock});
  try{
    assert.equal((await app.inject('/v1/board')).statusCode,401);
    const demo=await app.inject('/v1/demo/board');
    assert.equal(demo.statusCode,200);
    assert.deepEqual(demo.json().board.lines.map((item:{id:string})=>item.id),['tomorrow','day-three']);
    const rankings=await app.inject('/v1/demo/rankings');
    assert.equal(rankings.statusCode,200);
    assert.ok(Array.isArray(rankings.json().rankings));
    assert.equal((await app.inject({method:'POST',url:'/v1/demo/board'})).statusCode,404);
  }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});

test('a Crown GKR turns down is still saved, as the user own picks',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-crown-fallback-'));
  const cache=new BoardCache(join(folder,'board.json'));
  const clock=()=>new Date('2030-09-24T12:00:00Z');
  const lines=['a','b'].map((name)=>fixtureLine({id:`line-${name}`,sourceLineId:`source-${name}`,playerId:name,
    playerName:`Player ${name}`,eventStartTime:'2030-09-25T00:00:00Z',fetchedAt:'2030-09-24T11:00:00Z',
    availableDirections:['MORE','LESS']}));
  await cache.save({board:boardSchema.parse({provider:'prizepicks',fetchedAt:'2030-09-24T11:00:00Z',lines}),
    evidence:[],researchStatus:'UNCONFIGURED',lastSuccessfulRefresh:null,secondLookAudits:{}});
  const ledger=new ProductLedger(join(folder,'product.json'),'CROWN_STRONG',clock);
  const app=buildServer({boardCache:cache,clock,product:ledger});
  try {
    const session=(await app.inject({method:'POST',url:'/v1/auth/register',
      payload:{username:'Picker_1',email:'picker@example.org',password:'private-passphrase-1'}})).json() as {token:string};
    const headers={authorization:`Bearer ${session.token}`};
    // No model scores these lines, so GKR's Crown rules reject it; it must still be kept.
    const saved=await app.inject({method:'POST',url:'/v1/me/crowns',headers,
      payload:{lineIds:['line-a','line-b'],directions:{'line-a':'MORE','line-b':'LESS'}}});
    assert.equal(saved.statusCode,201);
    assert.equal(saved.json().personal,true);
    assert.ok(saved.json().belowGkr.length);
    const crowns=(await app.inject({url:'/v1/me/crowns',headers})).json().crowns;
    assert.equal(crowns.length,1);
    assert.deepEqual(crowns[0].legs.map((leg:{direction:string})=>leg.direction),['MORE','LESS']);
  } finally {await app.close();await rm(folder,{recursive:true,force:true});}
});

test('Underdog lines are served with the PrizePicks reference, and a slip on them saves as the user own picks',async()=>{
  const { ScrapedLineStore } = await import('../src/scrapers/line-store.js');
  const { createHash } = await import('node:crypto');
  const folder=await mkdtemp(join(tmpdir(),'crowniq-app-board-'));
  const clock=()=>new Date('2030-09-24T12:00:00Z');
  const store=new ScrapedLineStore(join(folder,'lines.json'),clock);
  const row=(id:string,player:string,stat:string,line:number)=>({app:'underdog' as const,appLineId:id,league:'NFL',gameId:'g1',
    player,team:'CHI',teamName:'Chicago Bears',opponent:'GB',stat,line,tier:'REGULAR' as const,
    directions:['MORE','LESS'] as ('MORE'|'LESS')[],startTime:'2030-09-25T00:00:00.000Z',imageUrl:null,multipliers:{MORE:1.8}});
  await store.ingest('zen-studio-underdog',[row('u1','Player A','Receiving Yards',55.5),row('u2','Player B','Rush Yards',40.5)],
    {complete:true,apps:['underdog']});
  const playerId=`americanfootball_nfl:${createHash('sha256').update('player a').digest('hex').slice(0,24)}`;
  const cache=new BoardCache(join(folder,'board.json'));
  await cache.save({board:boardSchema.parse({provider:'prizepicks',fetchedAt:'2030-09-24T11:00:00Z',lines:[fixtureLine({
    id:'pp:1',sourceLineId:'1',playerId,playerName:'Player A',market:'player_reception_yds',threshold:54.5,
    eventStartTime:'2030-09-25T00:00:00Z',fetchedAt:'2030-09-24T11:00:00Z'})]}),
  evidence:[],researchStatus:'UNCONFIGURED',lastSuccessfulRefresh:null,secondLookAudits:{}});
  const ledger=new ProductLedger(join(folder,'product.json'),'CROWN_STRONG',clock);
  const app=buildServer({boardCache:cache,clock,product:ledger,scrapedLines:store});
  try {
    const board=(await app.inject('/v1/apps/underdog/board')).json() as {lines:{id:string;market:string;
      prizePicks:{threshold:number}|null}[]};
    assert.deepEqual(board.lines.map((line)=>[line.id,line.market,line.prizePicks?.threshold??null]),
      [['ud:u1','player_reception_yds',54.5],['ud:u2','player_rush_yds',null]]);
    assert.equal((await app.inject('/v1/apps/betr/board')).statusCode,404);
    const ported=(await app.inject({method:'POST',url:'/v1/apps/underdog/port',
      payload:{legs:[{lineId:'pp:1',direction:'MORE'},{lineId:'pp:1',direction:'LESS'},{lineId:'pp:missing',direction:'MORE'}]}}))
      .json() as {legs:{match:{id:string}|null;comparison:string|null;sideOffered:boolean}[]};
    // Underdog has 55.5 where PrizePicks has 54.5: harder for More, easier for Less; an unknown line has no match.
    assert.deepEqual(ported.legs.map((leg)=>[leg.match?.id??null,leg.comparison,leg.sideOffered]),
      [['ud:u1','WORSE',true],['ud:u1','BETTER',true],[null,null,false]]);
    const session=(await app.inject({method:'POST',url:'/v1/auth/register',
      payload:{username:'Slip_1',email:'slip@example.org',password:'private-passphrase-1'}})).json() as {token:string};
    const headers={authorization:`Bearer ${session.token}`};
    const saved=await app.inject({method:'POST',url:'/v1/me/crowns',headers,payload:{app:'underdog',personal:true,
      lineIds:['ud:u1','ud:u2'],directions:{'ud:u1':'MORE','ud:u2':'LESS'}}});
    assert.equal(saved.statusCode,201);
    const crowns=(await app.inject({url:'/v1/me/crowns',headers})).json().crowns;
    assert.equal(crowns[0].app,'underdog');
    assert.deepEqual(crowns[0].legs.map((leg:{market:string;direction:string})=>[leg.market,leg.direction]),
      [['player_reception_yds','MORE'],['player_rush_yds','LESS']]);
  } finally {await app.close();await rm(folder,{recursive:true,force:true});}
});
