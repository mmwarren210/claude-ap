import assert from 'node:assert/strict';
import test from 'node:test';
import { marketDefinitions, statHistoryReadyVersions } from '@crowniq/engine';
import type { ResearchTarget } from '@crowniq/engine';
import { StatApiGkrEvidence, statHistoryFactorsFor } from '../src/stat-api-gkr-evidence.js';

const target:ResearchTarget={
  eventId:'event-1',eventName:'AAA @ BBB',eventStartTime:'2030-09-25T00:00:00.000Z',
  league:'NFL',playerId:'board-player-1',playerName:'Fixture QB',team:null,opponent:null,
  market:'passing_yards',sport:'NFL',
};

const rows=Array.from({length:10},(_,index)=>({
  gameId:100+index,tournamentId:null,
  occurredAt:new Date(Date.parse('2030-08-01T00:00:00.000Z')+index*7*24*3600_000).toISOString(),
  metrics:{passing_yds:240+index*5,pass_attempts:30+index,completions:20+index,
    offensive_snaps:60,rushing_yds:10,rushing_attempts:2,receiving_yds:0,
    receptions:0,targets:0,fantasy_pts:18},
}));

test('stat evidence builds attributed history projection and factor inputs without status guesses',async()=>{
  let searchCalls=0,inspectCalls=0;
  const source={
    search:async()=>{searchCalls++;return {players:[{id:7,name:'Fixture QB',teamId:1}],
      partial:false,sourceUrl:'https://api.stat-api.com/api/v1/nfl/players',
      retrievedAt:'2030-09-24T12:00:00.000Z'};},
    inspect:async()=>{inspectCalls++;return {sport:'NFL' as const,
      player:{id:7,name:'Fixture QB',teamId:1},table:'game_player_stats',
      sourceUrl:'https://api.stat-api.com/api/v1/nfl/game_player_stats?player_id=7',
      retrievedAt:'2030-09-24T12:00:00.000Z',nextFromId:null,sampleOnly:true as const,
      officialStatusConfirmed:false as const,rows};},
  };
  const adapter=new StatApiGkrEvidence(source,{clock:()=>new Date('2030-09-24T12:00:00.000Z')});
  const evidence=await adapter.research([target]);
  const kinds=new Set(evidence.map((item)=>item.kind));
  assert.ok(kinds.has('projection:passing_yards'));
  assert.ok(kinds.has('metric:expected_attempts'));
  assert.ok(kinds.has('metric:efficiency_environment'));
  assert.ok(kinds.has('metric:historical_current_form'));
  assert.ok(kinds.has('metric:stability'));
  assert.ok(![...kinds].some((kind)=>kind.startsWith('status:')));
  const projection=evidence.find((item)=>item.kind==='projection:passing_yards')!;
  assert.equal(projection.sourceType,'LICENSED_FEED');
  assert.equal(projection.entityId,target.playerId);
  assert.ok(projection.numeric!.baseline!>0);
  assert.equal(searchCalls,1);assert.equal(inspectCalls,1);
  assert.equal(adapter.getHealth().status,'OK');
  assert.equal(adapter.getHealth().sources?.PROVIDER_IDENTITY.errorCode,null);
  assert.equal(adapter.getHealth().sources?.PROVIDER_HISTORY.errorCode,null);
});

test('stat evidence reuses persistent internal history before provider lookups',async()=>{
  let searchCalls=0;
  const source={
    search:async()=>{searchCalls++;throw new Error('provider lookup should be skipped');},
    inspect:async()=>{throw new Error('provider inspect should be skipped');},
  };
  const adapter=new StatApiGkrEvidence(source,{clock:()=>new Date('2030-09-24T12:00:00.000Z'),
    skipTarget:async()=>true});
  assert.deepEqual(await adapter.research([target]),[]);
  assert.equal(searchCalls,0);
  assert.equal(adapter.getHealth().cacheHits,1);
});

test('stat evidence can restrict provider spend to approved sport-market keys',async()=>{
  let searchCalls=0;
  const source={
    search:async()=>{searchCalls++;return {players:[{id:7,name:'Fixture QB',teamId:1}],
      partial:false,sourceUrl:'https://example.org/players',retrievedAt:'2030-09-24T12:00:00.000Z'};},
    inspect:async()=>{throw new Error('unapproved target must not inspect');},
  };
  const adapter=new StatApiGkrEvidence(source,{clock:()=>new Date('2030-09-24T12:00:00.000Z'),
    allowedKeys:['NFL:player_pass_attempts']});
  assert.deepEqual(await adapter.research([target]),[]);
  assert.equal(searchCalls,0);
});

test('stat evidence refuses ambiguous player identity rather than name-guessing',async()=>{
  const source={
    search:async()=>({players:[{id:7,name:'Fixture QB',teamId:1},
      {id:8,name:'Fixture QB Jr.',teamId:2}],partial:false,sourceUrl:'https://example.org/players',
      retrievedAt:'2030-09-24T12:00:00.000Z'}),
    inspect:async()=>{throw new Error('must not inspect ambiguous player');},
  };
  const adapter=new StatApiGkrEvidence(source,{clock:()=>new Date('2030-09-24T12:00:00.000Z')});
  assert.deepEqual(await adapter.research([target]),[]);
  assert.equal(adapter.getHealth().noSources,1);
});


test('every stat-history-ready model has at least sixty percent directly derivable factor weight',()=>{
  const ready=marketDefinitions.filter((definition)=>statHistoryReadyVersions.includes(definition.version));
  assert.equal(ready.length,20);
  for(const definition of ready){
    const available=new Set(statHistoryFactorsFor(definition.sport,definition.market));
    const factors=definition.factors.filter(([key])=>key!=='evidence_quality');
    const total=factors.reduce((sum,[,weight])=>sum+weight,0);
    const covered=factors.reduce((sum,[key,weight])=>sum+(available.has(key)?weight:0),0);
    assert.ok(covered/total>=.6,
      `${definition.sport}:${definition.market} only has ${covered}/${total} history-backed factor weight`);
  }
});

test('a shared name resolves to the candidate on the line team, learned from uniquely matched teammates',async()=>{
  const inspected:number[]=[];
  const people:Record<string,{id:number;name:string;teamId:number}[]>={
    'Freddie Freeman':[{id:1,name:'Freddie Freeman',teamId:27}],'Mookie Betts':[{id:2,name:'Mookie Betts',teamId:27}],
    'Max Muncy':[{id:1467,name:'Max Muncy',teamId:30},{id:1366,name:'Max Muncy',teamId:27}],
    'Lone Name':[{id:9,name:'Lone Name',teamId:30},{id:10,name:'Lone Name',teamId:31}],
  };
  const source={
    search:async(_sport:string,query:string)=>({players:people[query]??[],partial:false,
      sourceUrl:'https://api.stat-api.com/api/v1/nfl/players',retrievedAt:'2030-09-24T12:00:00.000Z'}),
    inspect:async(_sport:string,id:number)=>{inspected.push(id);return {sport:'NFL' as const,
      player:{id,name:'x',teamId:27},table:'game_player_stats',
      sourceUrl:`https://api.stat-api.com/api/v1/nfl/game_player_stats?player_id=${id}`,
      retrievedAt:'2030-09-24T12:00:00.000Z',nextFromId:null,sampleOnly:true as const,
      officialStatusConfirmed:false as const,rows};},
  };
  const adapter=new StatApiGkrEvidence(source,{clock:()=>new Date('2030-09-24T12:00:00.000Z'),concurrency:1});
  const on=(playerName:string,team:string)=>({...target,playerId:playerName,playerName,team});
  await adapter.research([on('Freddie Freeman','Dodgers'),on('Mookie Betts','Dodgers'),on('Max Muncy','Dodgers'),
    on('Lone Name','Rays')]);
  assert.deepEqual(inspected.sort((a,b)=>a-b),[1,2,1366],'the Dodgers Max Muncy; an unresolvable shared name is skipped');
  assert.equal(adapter.getHealth().sources?.PROVIDER_IDENTITY.errorCode,'IDENTITY_UNRESOLVED');
});
