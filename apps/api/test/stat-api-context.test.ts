import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResearchAdapter, ResearchTarget } from '@crowniq/engine';
import { StatApiContextResearch } from '../src/stat-api-context.js';
import { StatApiOwnerResearch } from '../src/stat-api-owner-research.js';

let now=new Date('2030-09-24T12:00:00Z');
const target=(playerId:string,hours:number,sport='NFL'):ResearchTarget=>({sport,league:sport,eventId:'e'+hours,
  playerId,playerName:'Player '+playerId,team:null,market:'player_receptions',
  eventStartTime:new Date(now.getTime()+hours*3600_000).toISOString()} as unknown as ResearchTarget);

test('Stat API context research: soonest games first, a player cap, a cooldown and a time window',async()=>{
  const seen:string[][]=[];
  const inner:ResearchAdapter={id:'inner',supports:(item)=>item.sport==='NFL',
    research:async(targets)=>{seen.push(targets.map((item)=>item.playerId));return [];}};
  const adapter=new StatApiContextResearch(inner,{windowHours:36,cooldownHours:6,maxPlayers:2,clock:()=>now});
  await adapter.research([target('late',30),target('far',48),target('soon',2),target('next',5),target('mlb',1,'MLB')]);
  assert.deepEqual(seen[0],['soon','next']);
  await adapter.research([target('late',30),target('soon',2),target('next',5)]);
  assert.deepEqual(seen[1],['late']);
  now=new Date(now.getTime()+7*3600_000);
  await adapter.research([target('soon',2),target('late',20)]);
  assert.deepEqual(seen[2],['soon','late']);
});

test('the Stat API record count survives a restart on the same day',async()=>{
  const file=join(await mkdtemp(join(tmpdir(),'crowniq-stat-usage-')),'usage.json');
  const clock=()=>new Date('2030-09-24T12:00:00Z');
  const fetcher:typeof fetch=async()=>new Response(JSON.stringify({id:5,full_name:'A Player',team_id:1}),{status:200});
  const first=new StatApiOwnerResearch('key',fetcher,clock,1000,file);
  await first.inspect('NFL',5,'game_player_stats').catch(()=>undefined);
  const rows=first.status().todayRows;
  assert.ok(rows>0);
  await new Promise((resolve)=>setTimeout(resolve,50));
  const second=new StatApiOwnerResearch('key',fetcher,clock,1000,file);
  await second.search('NFL','zz').catch(()=>undefined);
  await new Promise((resolve)=>setTimeout(resolve,20));
  assert.equal(second.status().todayRows,rows);
  const tomorrow=new StatApiOwnerResearch('key',fetcher,()=>new Date('2030-09-25T12:00:00Z'),1000,file);
  await new Promise((resolve)=>setTimeout(resolve,20));
  assert.equal(tomorrow.status().todayRows,0);
});
