import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchTarget } from '@crowniq/engine';
import { PublicNflGkrEvidence, parseNflverseHistory } from '../src/public-nfl-gkr-evidence.js';

const target=(market:string):ResearchTarget=>({
  eventId:'event-1',eventName:'AAA @ BBB',eventStartTime:'2030-09-25T00:00:00.000Z',
  league:'NFL',playerId:'board-player-1',playerName:'Fixture QB',team:null,opponent:null,
  market,sport:'NFL',
});
const csv=[
  'player_display_name,week,attempts,completions,passing_yards,carries',
  ...Array.from({length:10},(_,index)=>
    `Fixture QB,${index+1},${30+index},${20+index},${240+index*5},${2+index%3}`),
].join('\n');
const sleeper=JSON.stringify({
  a:{full_name:'Fixture QB',position:'QB',status:'Active',injury_status:null,team:'BBB'},
});

test('public NFL parser keeps required history columns',()=>{
  assert.equal(parseNflverseHistory(csv).length,10);
});

test('key-free NFL evidence builds history projection, factor coverage and current QB status',async()=>{
  let calls=0;
  const fetchFn:typeof fetch=async(input)=>{
    calls++;
    const url=String(input);
    return url.includes('sleeper.app')?new Response(sleeper,{status:200}):
      new Response(csv,{status:200,headers:{'content-type':'text/csv'}});
  };
  const adapter=new PublicNflGkrEvidence({fetchFn,clock:()=>new Date('2030-09-24T12:00:00.000Z')});
  const evidence=await adapter.research([
    target('passing_yards'),target('player_pass_attempts'),target('player_pass_completions')]);
  const kinds=new Set(evidence.map((item)=>item.kind));
  assert.ok(kinds.has('projection:passing_yards'));
  assert.ok(kinds.has('metric:expected_attempts'));
  assert.ok(kinds.has('projection:player_pass_attempts'));
  assert.ok(kinds.has('metric:expected_offensive_plays'));
  assert.ok(kinds.has('metric:pass_rate'));
  assert.ok(kinds.has('projection:player_pass_completions'));
  assert.ok(kinds.has('metric:completion_rate'));
  assert.ok(kinds.has('status:qb_available'));
  assert.equal(evidence.find((item)=>item.kind==='status:qb_available')?.numeric?.value,1);
  assert.equal(calls,3);
  assert.equal(adapter.getHealth().status,'OK');
});

test('known injury is a negative availability status instead of an invented positive',async()=>{
  const injured=JSON.stringify({
    a:{full_name:'Fixture QB',position:'QB',status:'Active',injury_status:'Questionable',team:'BBB'},
  });
  const fetchFn:typeof fetch=async(input)=>String(input).includes('sleeper.app')
    ?new Response(injured,{status:200}):new Response(csv,{status:200});
  const adapter=new PublicNflGkrEvidence({fetchFn,clock:()=>new Date('2030-09-24T12:00:00.000Z')});
  const evidence=await adapter.research([target('passing_yards')]);
  assert.equal(evidence.find((item)=>item.kind==='status:qb_available')?.numeric?.value,0);
});
