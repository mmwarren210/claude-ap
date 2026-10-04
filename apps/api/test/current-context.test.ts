import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchTarget } from '@crowniq/engine';
import { CurrentContextResearch } from '../src/current-context.js';

const now=new Date('2030-06-01T16:00:00.000Z');
const target=(overrides:Partial<ResearchTarget>):ResearchTarget=>({
  eventId:'event-1',eventName:'New York Yankees at Boston Red Sox',
  eventStartTime:'2030-06-01T20:00:00.000Z',league:'MLB',playerId:'player-1',
  playerName:'Batter One',team:'New York Yankees',opponent:'Boston Red Sox',
  market:'batter_hits',sport:'MLB',...overrides,
});

test('fresh context emits direct MLB lineup/starter, NFL availability and licensed NBA status',async()=>{
  const fetchFn:typeof fetch=async(input,init)=>{
    const url=String(input);
    if(url.includes('api.sleeper.app')){
      return new Response(JSON.stringify({
        wr:{full_name:'Healthy Receiver',position:'WR',status:'Active',injury_status:null,team:'GB'},
        qb:{full_name:'Healthy Quarterback',position:'QB',status:'Active',injury_status:null,team:'GB'},
      }),{status:200});
    }
    if(url.includes('/schedule?')){
      return new Response(JSON.stringify({dates:[{games:[{gamePk:123,teams:{
        away:{team:{name:'New York Yankees',abbreviation:'NYY'}},
        home:{team:{name:'Boston Red Sox',abbreviation:'BOS'}},
      }}]}]}),{status:200});
    }
    if(url.endsWith('/game/123/feed/live')){
      return new Response(JSON.stringify({
        gameData:{probablePitchers:{away:{id:50,fullName:'Ace Pitcher'},
          home:{id:60,fullName:'Home Starter'}}},
        liveData:{boxscore:{teams:{
          away:{battingOrder:[10],pitchers:[50],players:{
            ID10:{person:{id:10,fullName:'Batter One'}},
            ID50:{person:{id:50,fullName:'Ace Pitcher'}},
          }},
          home:{battingOrder:[20],pitchers:[60],players:{
            ID20:{person:{id:20,fullName:'Home Batter'}},
            ID60:{person:{id:60,fullName:'Home Starter'}},
          }},
        }}},
      }),{status:200});
    }
    return new Response('not found',{status:404});
  };
  const statSource={
    currentAvailability:async(_sport:'NBA',query:string)=>({
      player:{id:query==='Questionable Guard'?7:8,name:query,teamId:2},
      rosterStatus:'active',
      injuryStatus:query==='Questionable Guard'?'QUESTIONABLE':null,
      status:null,preGameStatus:null,preGameInjuryStatus:null,preGameStarter:null,
      sourceUrl:'https://api.stat-api.com/api/v1/nba/players/7',
      retrievedAt:now.toISOString(),
    }),
  };
  const adapter=new CurrentContextResearch({fetchFn,clock:()=>now,statSource,
    allowedKeys:['MLB:batter_hits','MLB:pitcher_strikeouts','NFL:player_reception_yds',
      'NFL:passing_yards','NBA:player_points']});
  const targets:ResearchTarget[]=[
    target({}),
    target({playerId:'pitcher-1',playerName:'Ace Pitcher',market:'pitcher_strikeouts'}),
    target({eventId:'nfl-1',eventName:'Green Bay Packers at Chicago Bears',league:'NFL',
      playerId:'wr-1',playerName:'Healthy Receiver',team:'GB',opponent:'CHI',
      market:'player_reception_yds',sport:'NFL'}),
    target({eventId:'nfl-1',eventName:'Green Bay Packers at Chicago Bears',league:'NFL',
      playerId:'qb-1',playerName:'Healthy Quarterback',team:'GB',opponent:'CHI',
      market:'passing_yards',sport:'NFL'}),
    target({eventId:'nba-1',eventName:'A at B',league:'NBA',playerId:'guard-1',
      playerName:'Questionable Guard',team:'A',opponent:'B',market:'player_points',sport:'NBA'}),
    target({eventId:'nba-1',eventName:'A at B',league:'NBA',playerId:'healthy-guard',
      playerName:'Healthy Guard',team:'A',opponent:'B',market:'player_points',sport:'NBA'}),
  ];
  const evidence=await adapter.research(targets);
  const value=(playerId:string,kind:string)=>evidence.find((item)=>
    item.entityId===playerId&&item.kind===kind)?.numeric?.value;
  assert.equal(value('player-1','status:starting_lineup'),1);
  assert.equal(value('player-1','status:starting_pitcher'),1);
  assert.equal(value('pitcher-1','status:starting_pitcher'),1);
  assert.equal(value('wr-1','status:player_available'),1);
  assert.equal(value('qb-1','status:qb_available'),1);
  assert.equal(value('guard-1','status:player_available'),undefined);
  assert.equal(value('healthy-guard','status:player_available'),1);
  assert.equal(adapter.getHealth().status,'OK');
  assert.equal(adapter.getHealth().sources?.MLB_GAME_MATCH.evidence,2);
  assert.equal(adapter.getHealth().sources?.MLB_PLAYER_MATCH.evidence,2);
  assert.equal(adapter.getHealth().sources?.MLB_LINEUP_POSTED.evidence,1);
  assert.equal(adapter.getHealth().sources?.MLB_STARTER_CONTEXT.evidence,2);
  assert.equal(adapter.getHealth().sources?.MLB_EVIDENCE_TARGETS.evidence,2);
  assert.equal(adapter.getHealth().sources?.NBA_IDENTITY_MATCH.evidence,2);
  assert.equal(adapter.getHealth().sources?.NBA_AVAILABILITY_RESOLVED.evidence,1);
  assert.equal(adapter.getHealth().sources?.NBA_SOURCE_HEALTH.failures,0);
});

test('fresh context refuses unsupported markets and ambiguous MLB games',async()=>{
  const fetchFn:typeof fetch=async(input)=>{
    const url=String(input);
    if(url.includes('/schedule?'))return new Response(JSON.stringify({dates:[{games:[
      {gamePk:1,teams:{away:{team:{name:'New York Yankees'}},home:{team:{name:'Boston Red Sox'}}}},
      {gamePk:2,teams:{away:{team:{name:'New York Yankees'}},home:{team:{name:'Boston Red Sox'}}}},
    ]}]}),{status:200});
    return new Response('{}',{status:200});
  };
  const adapter=new CurrentContextResearch({fetchFn,clock:()=>now,
    allowedKeys:['MLB:batter_hits']});
  assert.equal(adapter.supports(target({market:'batter_hits'})),true);
  assert.equal(adapter.supports(target({market:'batter_total_bases'})),false);
  assert.deepEqual(await adapter.research([target({market:'batter_hits'})]),[]);
});


test('fresh context dedupes reusable status evidence across multiple markets for one player',async()=>{
  const fetchFn:typeof fetch=async(input)=>{
    const url=String(input);
    if(url.includes('api.sleeper.app'))return new Response(JSON.stringify({
      wr:{full_name:'Healthy Receiver',position:'WR',status:'Active',injury_status:null,team:'GB'},
    }),{status:200});
    return new Response('{}',{status:200});
  };
  const adapter=new CurrentContextResearch({fetchFn,clock:()=>now,
    allowedKeys:['NFL:player_reception_yds','NFL:player_receptions']});
  const base={eventId:'nfl-1',eventName:'Green Bay Packers at Chicago Bears',
    eventStartTime:'2030-06-01T20:00:00.000Z',league:'NFL',playerId:'wr-1',
    playerName:'Healthy Receiver',team:'GB',opponent:'CHI',sport:'NFL' as const};
  const evidence=await adapter.research([
    {...base,market:'player_reception_yds'},
    {...base,market:'player_receptions'},
  ]);
  const status=evidence.filter((item)=>item.kind==='status:player_available');
  assert.equal(status.length,1);
  assert.equal(new Set(evidence.map((item)=>item.id)).size,evidence.length);
});


test('postseason placeholder schedule can match by one exact side on the event day',async()=>{
  const fetchFn:typeof fetch=async(input)=>{
    const url=String(input);
    if(url.includes('/schedule?'))return new Response(JSON.stringify({dates:[
      {date:'2030-10-02',games:[{gamePk:321,gameDate:'2030-10-02T21:00:00Z',teams:{
        away:{team:{name:'NLWC3',abbreviation:'NLWC3'}},
        home:{team:{name:'Atlanta Braves',abbreviation:'ATL'}},
      }}]},
      {date:'2030-10-03',games:[{gamePk:322,gameDate:'2030-10-03T21:00:00Z',teams:{
        away:{team:{name:'NLWC3',abbreviation:'NLWC3'}},
        home:{team:{name:'Atlanta Braves',abbreviation:'ATL'}},
      }}]},
    ]}),{status:200});
    if(url.endsWith('/game/321/feed/live'))return new Response(JSON.stringify({
      gameData:{probablePitchers:{away:{id:60,fullName:'Away Starter'},
        home:{id:50,fullName:'Home Starter'}}},
      liveData:{boxscore:{teams:{
        away:{battingOrder:[10],pitchers:[60],players:{
          ID10:{person:{id:10,fullName:'Batter One'}},
          ID60:{person:{id:60,fullName:'Away Starter'}},
        }},
        home:{battingOrder:[20],pitchers:[50],players:{
          ID20:{person:{id:20,fullName:'Home Batter'}},
          ID50:{person:{id:50,fullName:'Home Starter'}},
        }},
      }}},
    }),{status:200});
    return new Response('{}',{status:200});
  };
  const clock=()=>new Date('2030-10-02T12:00:00Z');
  const adapter=new CurrentContextResearch({fetchFn,clock,
    allowedKeys:['MLB:batter_hits']});
  const evidence=await adapter.research([target({
    eventId:'wc-1',eventName:'Philadelphia Phillies @ Atlanta Braves',
    eventStartTime:'2030-10-02T18:00:00Z',playerName:'Batter One',
  })]);
  assert.equal(evidence.some((item)=>item.kind==='status:starting_lineup'),true);
  assert.equal(adapter.getHealth().sources?.MLB_GAME_MATCH.evidence,1);
});


test('current context retries one transient MLB source failure without dropping the sport batch',async()=>{
  let scheduleCalls=0;
  const fetchFn:typeof fetch=async(input)=>{
    const url=String(input);
    if(url.includes('/schedule?')){
      scheduleCalls++;
      if(scheduleCalls===1)return new Response('temporary',{status:503});
      return new Response(JSON.stringify({dates:[{date:'2030-06-01',games:[{
        gamePk:123,gameDate:'2030-06-01T20:00:00Z',teams:{
          away:{team:{name:'New York Yankees'}},home:{team:{name:'Boston Red Sox'}},
        }}]}]}),{status:200});
    }
    if(url.endsWith('/game/123/feed/live'))return new Response(JSON.stringify({
      gameData:{probablePitchers:{home:{id:60,fullName:'Home Starter'}}},
      liveData:{boxscore:{teams:{
        away:{battingOrder:[10],pitchers:[],players:{ID10:{person:{id:10,fullName:'Batter One'}}}},
        home:{battingOrder:[20],pitchers:[60],players:{
          ID20:{person:{id:20,fullName:'Home Batter'}},
          ID60:{person:{id:60,fullName:'Home Starter'}},
        }},
      }}},
    }),{status:200});
    return new Response('{}',{status:404});
  };
  const adapter=new CurrentContextResearch({fetchFn,clock:()=>now,allowedKeys:['MLB:batter_hits']});
  const evidence=await adapter.research([target({})]);
  assert.equal(scheduleCalls,2);
  assert.equal(evidence.some((item)=>item.kind==='status:starting_lineup'),true);
  assert.equal(adapter.getHealth().sources?.MLB_SOURCE_HEALTH.failures,0);
});

test('MLB series games on the same UTC date resolve to the one near the line start; schedule lineups fill an empty boxscore',async()=>{
  const requested:string[]=[];
  const fetchFn:typeof fetch=async(input)=>{
    const url=String(input);requested.push(url);
    const teams={away:{team:{name:'San Diego Padres',abbreviation:'SD'}},
      home:{team:{name:'Milwaukee Brewers',abbreviation:'MIL'}}};
    if(url.includes('/schedule?')){
      // Saturday's night game (00:08 UTC) and Sunday's afternoon game share the UTC date.
      return new Response(JSON.stringify({dates:[{games:[
        {gamePk:1,gameDate:'2030-06-01T00:08:00Z',teams},
        {gamePk:2,gameDate:'2030-06-01T20:08:00Z',teams,
          lineups:{awayPlayers:[{id:10,fullName:'Batter One'}],homePlayers:[{id:20,fullName:'Home Batter'}]}},
      ]}]}),{status:200});
    }
    if(url.endsWith('/game/2/feed/live')){
      return new Response(JSON.stringify({
        gameData:{probablePitchers:{away:{id:50},home:{id:60}}},
        liveData:{boxscore:{teams:{
          away:{battingOrder:[],players:{ID10:{person:{id:10,fullName:'Batter One'}},ID11:{person:{id:11,fullName:'Bench Bat'}}}},
          home:{battingOrder:[],players:{ID20:{person:{id:20,fullName:'Home Batter'}},
            ID60:{person:{id:60,fullName:'Home Starter'}}}},
        }}},
      }),{status:200});
    }
    return new Response('not found',{status:404});
  };
  const adapter=new CurrentContextResearch({fetchFn,clock:()=>now,allowedKeys:['MLB:batter_hits']});
  const sd=target({eventId:'pp-game:1',eventName:'Brewers vs Padres',team:'Padres',opponent:'Brewers',
    eventStartTime:'2030-06-01T20:00:00.000Z'});
  const evidence=await adapter.research([sd,target({eventId:'pp-game:1',eventName:'Brewers vs Padres',
    playerId:'bench',playerName:'Bench Bat',team:'Padres',opponent:'Brewers',eventStartTime:'2030-06-01T20:00:00.000Z'})]);
  assert.ok(requested.some((url)=>url.includes('hydrate=team,probablePitcher,lineups')));
  assert.ok(!requested.some((url)=>url.endsWith('/game/1/feed/live')));
  const lineup=(id:string)=>evidence.find((item)=>item.entityId===id&&item.kind==='status:starting_lineup')?.numeric?.value;
  assert.equal(lineup('player-1'),1);
  assert.equal(lineup('bench'),0);
  const sources=adapter.getHealth().sources??{};
  const game=Object.entries(sources).find(([key])=>key.startsWith('MLB_GAME '));
  assert.equal(game?.[1].errorCode,'GAME_2 LINEUP away:schedule,home:schedule');
});

test('MLB games that cannot be told apart stay unmatched and say so',async()=>{
  const fetchFn:typeof fetch=async(input)=>{
    const url=String(input);
    const teams={away:{team:{name:'New York Yankees'}},home:{team:{name:'Boston Red Sox'}}};
    if(url.includes('/schedule?')){
      return new Response(JSON.stringify({dates:[{games:[
        {gamePk:1,gameDate:'2030-06-01T16:05:00Z',teams},{gamePk:2,gameDate:'2030-06-01T23:35:00Z',teams},
      ]}]}),{status:200});
    }
    throw new Error('feed should not be requested');
  };
  const adapter=new CurrentContextResearch({fetchFn,clock:()=>now,allowedKeys:['MLB:batter_hits']});
  // 20:00 is more than 3 hours from both games of the doubleheader.
  const evidence=await adapter.research([target({})]);
  assert.equal(evidence.length,0);
  const game=Object.entries(adapter.getHealth().sources??{}).find(([key])=>key.startsWith('MLB_GAME '));
  assert.equal(game?.[1].errorCode,'GAME_UNRESOLVED');
});
