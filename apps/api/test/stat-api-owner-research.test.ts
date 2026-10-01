import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductLedger } from '../src/product-ledger.js';
import { buildServer } from '../src/server.js';
import { StatApiOwnerError, StatApiOwnerResearch } from '../src/stat-api-owner-research.js';

const clock=()=>new Date('2030-09-24T12:00:00Z');
const response=(data:unknown,remaining=19000)=>new Response(JSON.stringify(data),{
  status:200,headers:{'content-type':'application/json','x-quota-used':'1000',
    'x-quota-remaining':String(remaining)},
});

test('only the configured signed-in owner may search; public refresh makes no stat-api request',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'crowniq-owner-research-'));
  const product=new ProductLedger(join(dir,'ledger.json'),'CROWN_STRONG',clock);
  const owner=await product.register('owner@example.org','long-owner-password','Owner_One');
  const guest=await product.register('guest@example.org','long-guest-password','Guest_One');
  const urls:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer fake-private-key');
    const url=String(input);urls.push(url);
    if(url.includes('/nfl/players?'))return response({players:[
      {id:100,full_name:'Sample Quarterback',team_id:7},
      {id:101,full_name:'Sample Receiver',team_id:7}],next_from_id:null});
    if(url.endsWith('/nfl/players/100'))return response({id:100,full_name:'Sample Quarterback',team_id:7});
    if(url.includes('/nfl/game_player_stats?'))return response({game_player_stats:[
      {game_id:99,player_id:100,game_date:'2030-09-20T00:00:00.000Z',
        passing_yds:264,pass_attempts:30}],next_from_id:10});
    throw new Error('Unexpected stat-api request');
  };
  const adapter=new StatApiOwnerResearch('fake-private-key',fetcher,clock);
  const app=buildServer({product,requireProfiles:true,ownerPublicId:owner.profile.publicId,
    ownerResearch:adapter,clock});
  const ownerHeaders={authorization:`Bearer ${owner.token}`};
  const guestHeaders={authorization:`Bearer ${guest.token}`};
  try{
    assert.equal((await app.inject('/v1/board')).statusCode,401);
    assert.equal((await app.inject({url:'/v1/owner/research/status',headers:guestHeaders})).statusCode,404);
    assert.equal((await app.inject({url:'/v1/owner/research/search?sport=NFL&q=Sample',
      headers:guestHeaders})).statusCode,404);
    assert.equal((await app.inject({url:'/v1/owner/research/player/NFL/100?table=game_player_stats',
      headers:guestHeaders})).statusCode,404);
    assert.equal((await app.inject({url:'/v1/board',headers:guestHeaders})).statusCode,503);
    assert.equal((await app.inject({url:'/v1/rankings',headers:guestHeaders})).statusCode,503);
    assert.equal(urls.length,0);
    const status=await app.inject({url:'/v1/owner/research/status',headers:ownerHeaders});
    assert.equal(status.json().publicBoardImpact,'NONE');
    assert.equal(status.json().todayRows,0);
    assert.equal(status.headers['cache-control'],'private, no-store');
    assert.equal(status.body.includes('fake-private-key'),false);
    const search=await app.inject({url:'/v1/owner/research/search?sport=NFL&q=Quarterback',
      headers:ownerHeaders});
    assert.equal(search.statusCode,200);
    assert.equal(search.json().players[0].name,'Sample Quarterback');
    assert.equal(search.json().players.length,1);
    assert.equal(search.body.includes('fake-private-key'),false);
    assert.equal((await app.inject({url:'/v1/owner/research/search?sport=NFL&q=Receiver',
      headers:ownerHeaders})).json().players[0].id,101);
    assert.equal(urls.length,1); // active roster cached across queries
    const detail=await app.inject({url:'/v1/owner/research/player/NFL/100?table=game_player_stats',
      headers:ownerHeaders});
    assert.equal(detail.statusCode,200);
    assert.equal(detail.json().rows[0].metrics.passing_yds,264);
    assert.equal(detail.json().sampleOnly,true);
    assert.equal(detail.json().officialStatusConfirmed,false);
    assert.equal(detail.json().nextFromId,10);
    assert.equal((await app.inject({url:'/v1/owner/research/status',headers:ownerHeaders})).json().todayRows,4);
    assert.equal((await app.inject({url:'/v1/owner/research/player/NFL/100?table=game_player_stats',
      headers:ownerHeaders})).statusCode,200);
    assert.equal(urls.length,3); // player and stat rows cached
    assert.equal((await app.inject({url:'/v1/board',headers:ownerHeaders})).statusCode,503);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('NFL game stats without dates join game_id to recent season game_time',async()=>{
  const urls:string[]=[];
  const fetcher:typeof fetch=async(input)=>{
    const url=String(input);urls.push(url);
    if(url.endsWith('/nfl/players/100'))return response({id:100,full_name:'Sample Quarterback',team_id:7});
    if(url.includes('/nfl/game_player_stats?'))return response({game_player_stats:[
      {game_id:99,player_id:100,passing_yds:264,pass_attempts:30}],next_from_id:null});
    if(url.includes('/nfl/seasons?'))return response({seasons:[
      {id:2030,start_year:2030},{id:2029,start_year:2029},{id:2028,start_year:2028}],next_from_id:null});
    if(url.includes('/nfl/games?season_id=2030'))return response({games:[
      {id:99,game_time:'2030-09-20T20:00:00.000Z'}],next_from_id:null});
    if(url.includes('/nfl/games?season_id=2029')||url.includes('/nfl/games?season_id=2028'))
      return response({games:[],next_from_id:null});
    throw new Error('Unexpected '+url);
  };
  const adapter=new StatApiOwnerResearch('private',fetcher,()=>new Date('2030-09-24T12:00:00Z'));
  const detail=await adapter.inspect('NFL',100,'game_player_stats');
  assert.equal(detail.rows[0].occurredAt,'2030-09-20T20:00:00.000Z');
  assert.ok(urls.some((url)=>url.includes('/nfl/games?season_id=2030')));
});

test('NBA search accepts a player array and still uses the owner-only row budget',async()=>{
  let calls=0;
  const fetcher:typeof fetch=async()=>{
    calls++;
    return response([{id:7,full_name:'Sample Guard',team_id:2}]);
  };
  const adapter=new StatApiOwnerResearch('private',fetcher,clock,20);
  assert.deepEqual((await adapter.search('NBA','Guard')).players,
    [{id:7,name:'Sample Guard',teamId:2}]);
  assert.equal((await adapter.search('NBA','Guard')).players.length,1);
  assert.equal(calls,1);
  assert.equal(adapter.status().todayRows,1);
});

test('invalid sport, table, and identity cannot trigger provider requests',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'crowniq-owner-validation-'));
  const product=new ProductLedger(join(dir,'ledger.json'),'CROWN_STRONG',clock);
  const owner=await product.register('owner@example.org','long-owner-password','Owner_One');
  let calls=0;
  const adapter=new StatApiOwnerResearch('owner-only',async()=>{calls++;throw Error('unexpected');},clock);
  const app=buildServer({product,requireProfiles:true,ownerPublicId:owner.profile.publicId,
    ownerResearch:adapter});
  const headers={authorization:`Bearer ${owner.token}`};
  try{
    for(const url of ['/v1/owner/research/search?sport=NHL&q=Sample',
      '/v1/owner/research/search?sport=NFL&q=x',
      '/v1/owner/research/player/NFL/0?table=game_player_stats',
      '/v1/owner/research/player/NFL/100?table=game_player_batter_stats',
      '/v1/owner/research/player/NFL/100?table=secrets']){
      const response=await app.inject({url,headers});
      assert.equal(response.statusCode,400,url);
    }
    assert.equal(calls,0);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('owner record ceiling and provider quota block further requests without retries',async()=>{
  let calls=0;
  const fetcher:typeof fetch=async()=>{
    calls++;
    return response({players:[{id:41,full_name:'Sample Player',team_id:null}]},0);
  };
  const adapter=new StatApiOwnerResearch('private',fetcher,clock,2501);
  assert.equal((await adapter.search('NFL','Sample')).players.length,1);
  assert.equal(adapter.status().todayRows,1);
  await assert.rejects(()=>adapter.inspect('NFL',41,'game_player_stats'),
    (error:unknown)=>error instanceof StatApiOwnerError && error.status===429);
  assert.equal(calls,1);
  const other=new StatApiOwnerResearch('private',async()=>{
    calls++;return new Response('{}',{status:429});
  },clock);
  await assert.rejects(()=>other.search('NBA','Sample'),
    (error:unknown)=>error instanceof StatApiOwnerError && error.code==='STAT_API_QUOTA_EXHAUSTED');
  await assert.rejects(()=>other.search('NBA','Another'),
    (error:unknown)=>error instanceof StatApiOwnerError && error.code==='STAT_API_BUDGET_EXHAUSTED');
  assert.equal(calls,2);
});


test('NBA current availability exact-matches identity and preserves pregame status fields',async()=>{
  const urls:string[]=[];
  const fetcher:typeof fetch=async(input)=>{
    const url=String(input);urls.push(url);
    if(url.includes('/nba/players/search?'))return response([
      {id:7,full_name:'Sample Guard',team_id:2},
      {id:8,full_name:'Sample Guard Jr',team_id:3},
    ]);
    if(url.endsWith('/nba/players/7'))return response({
      id:7,full_name:'Sample Guard',team_id:2,roster_status:'active',
      injury_status:null,pre_game_status:1,pre_game_injury_status:null,pre_game_starter:1,
    });
    throw new Error('Unexpected '+url);
  };
  const adapter=new StatApiOwnerResearch('private',fetcher,clock,100);
  const availability=await adapter.currentAvailability('NBA','Sample Guard');
  assert.equal(availability?.player.id,7);
  assert.equal(availability?.rosterStatus,'active');
  assert.equal(availability?.injuryStatus,null);
  assert.equal(availability?.preGameStatus,1);
  assert.equal(availability?.preGameStarter,true);
  assert.equal(urls.length,2);
  assert.equal(adapter.status().todayRows,3);
});


test('normalizes NFL roster names before matching punctuation and suffix variants',async()=>{
  let calls=0;
  const fetcher:typeof fetch=async()=>{
    calls++;
    return response({players:[
      {id:201,full_name:'A.J. Sample Jr.',team_id:7},
      {id:202,full_name:'Other Player',team_id:8},
    ],next_from_id:null});
  };
  const adapter=new StatApiOwnerResearch('private',fetcher,clock,3000);
  const result=await adapter.search('NFL','AJ Sample');
  assert.deepEqual(result.players,[{id:201,name:'A.J. Sample Jr.',teamId:7}]);
  assert.equal(calls,1);
});


test('NFL player inspection requests a stable complete practical game-log page',async()=>{
  const urls:string[]=[];
  const fetcher:typeof fetch=async(input)=>{
    const url=String(input);urls.push(url);
    if(url.endsWith('/nfl/players/100'))return response({id:100,full_name:'Sample Receiver',team_id:7});
    if(url.includes('/nfl/game_player_stats?'))return response({game_player_stats:[
      {game_id:9901,player_id:100,receiving_yds:88,receptions:6,targets:9,offensive_snaps:52},
    ],next_from_id:null});
    if(url.includes('/nfl/seasons?'))return response({seasons:[
      {id:2030,start_year:2030},{id:2029,start_year:2029},{id:2028,start_year:2028}],next_from_id:null});
    if(url.includes('/nfl/games?season_id=2030'))return response({games:[
      {id:9901,game_time:'2030-09-20T20:00:00.000Z'}],next_from_id:null});
    if(url.includes('/nfl/games?season_id=2029')||url.includes('/nfl/games?season_id=2028'))
      return response({games:[],next_from_id:null});
    throw new Error('Unexpected '+url);
  };
  const adapter=new StatApiOwnerResearch('private',fetcher,()=>new Date('2030-09-24T12:00:00Z'),10000);
  const detail=await adapter.inspect('NFL',100,'game_player_stats');
  const gameLogUrl=urls.find((url)=>url.includes('/nfl/game_player_stats?'));
  assert.ok(gameLogUrl?.includes('limit=500'));
  assert.ok(gameLogUrl?.includes('from_id=0'));
  assert.equal(detail.rows[0].occurredAt,'2030-09-20T20:00:00.000Z');
  assert.equal(detail.rows[0].metrics.targets,9);
  assert.equal(detail.rows[0].metrics.offensive_snaps,52);
});


test('normalizes NBA dotted initials and suffixes for current availability',async()=>{
  const fetcher:typeof fetch=async(input)=>{
    const url=String(input);
    if(url.includes('/nba/players/search?'))return response([
      {id:77,full_name:'A.J. Sample Jr.',team_id:2},
    ]);
    if(url.endsWith('/nba/players/77'))return response({
      id:77,full_name:'A.J. Sample Jr.',team_id:2,roster_status:'active',
      injury_status:null,status:'active',pre_game_status:null,
      pre_game_injury_status:null,pre_game_starter:null,
    });
    throw new Error('Unexpected '+url);
  };
  const adapter=new StatApiOwnerResearch('private',fetcher,clock,100);
  const availability=await adapter.currentAvailability('NBA','AJ Sample');
  assert.equal(availability?.player.id,77);
});

test('NBA and MLB inspection request stable practical complete game-log windows',async()=>{
  const urls:string[]=[];
  const fetcher:typeof fetch=async(input)=>{
    const url=String(input);urls.push(url);
    if(url.endsWith('/nba/players/70'))return response({id:70,full_name:'Sample Guard',team_id:2});
    if(url.includes('/nba/game_player_stats?'))return response({game_player_stats:[
      {game_id:7001,player_id:70,game_date:'2030-09-20T00:00:00Z',pts:22,minutes:32},
    ],next_from_id:null});
    if(url.endsWith('/mlb/players/80'))return response({id:80,full_name:'Sample Batter',team_id:3});
    if(url.includes('/mlb/game_player_batter_stats?'))return response({game_player_batter_stats:[
      {game_id:8001,player_id:80,game_date:'2030-09-20T00:00:00Z',hits:2,plate_appearances:4},
    ],next_from_id:null});
    throw new Error('Unexpected '+url);
  };
  const adapter=new StatApiOwnerResearch('private',fetcher,clock,5000);
  await adapter.inspect('NBA',70,'game_player_stats');
  await adapter.inspect('MLB',80,'game_player_batter_stats');
  const nba=urls.find((url)=>url.includes('/nba/game_player_stats?'))!;
  const mlb=urls.find((url)=>url.includes('/mlb/game_player_batter_stats?'))!;
  assert.ok(nba.includes('limit=250'));assert.ok(nba.includes('from_id=0'));
  assert.ok(mlb.includes('limit=500'));assert.ok(mlb.includes('from_id=0'));
});
