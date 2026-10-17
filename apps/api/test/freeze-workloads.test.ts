import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { PlayerStore } from '../src/player-store.js';
import { PropLineHistory } from '../src/propline-history.js';
import type { PropLineClient } from '../src/scrapers/propline.js';
import { expectedGoals } from '../src/context/sharp-props.js';
import type { GamePrice } from '../src/context/sharp-props.js';

test('player-store loading and pruning yield to timers and preserve every row and season', async () => {
  const store = new PlayerStore(null), now = Date.parse('2030-10-12T00:00:00Z');
  try {
    for(let i=0;i<300;i++) store.put(`baseball_mlb|p${String(i).padStart(3,'0')}`,'baseball_mlb',{at:now},[
      {at:'2030-10-01T00:00:00Z',opponent:'B',stats:{hits:i}},
      {at:'2027-01-01T00:00:00Z',opponent:'A',stats:{hits:2}},
    ],now);
    const expected = store.all(now), actual = new Map();
    let turns = 0, running = true;
    const tick = async () => { while(running) { await yieldToLoop(); turns++; } };
    const ticking = tick();
    await store.loadRecent(now,(key,fetch,games)=>actual.set(key,{fetch,games}));
    assert.deepEqual(actual,expected);
    assert.ok(turns >= 4,`load only yielded ${turns} times`);
    const before = turns;
    assert.equal(await store.pruneInChunks(now+1),300);
    assert.ok(turns > before);
    assert.equal(store.counts().games,0);
    assert.equal(store.counts().seasons,300);
    running = false; await ticking;
  } finally { store.close(); }
});

test('history shares startup and save work; a failed write remains dirty and is retried', async () => {
  const store = new PlayerStore(null), now = Date.parse('2030-10-12T00:00:00Z');
  try {
    let loads=0, writes=0;
    const load=store.loadRecent.bind(store), put=store.put.bind(store);
    store.loadRecent=async (...args) => { loads++; await yieldToLoop(); return load(...args); };
    const client={get:async()=>({games:[{status:'final',commence_time:'2030-10-01T00:00:00Z',stats:{hits:2}}]})} as unknown as PropLineClient;
    const history=new PropLineHistory(client,null,()=> 'baseball_mlb',{store},()=>now);
    await Promise.all([history.ready(),history.ready()]);
    assert.equal(loads,1);
    await history.values({sport:'MLB',eventId:'e',playerName:'Player',market:'batter_hits',eventStartTime:'2030-10-13T00:00:00Z'});
    store.put=(...args)=>{writes++;if(writes===1)throw new Error('DISK_BUSY');return put(...args);};
    await assert.rejects(history.save(),/DISK_BUSY/);
    await Promise.all([history.save(),history.save()]);
    assert.equal(writes,2);
    assert.equal(store.games('baseball_mlb|player')[0]?.stats.hits,2);
  } finally { store.close(); }
});

test('total-goals search ignores corrupt feed numbers and keeps normal output', () => {
  const pair=(line:number):GamePrice[] => ['over','under'].map((side)=>({book:'fixture',league:'nhl',sport:'NHL',eventId:'e',
    home:'A',away:'B',startTime:'2030-10-13T00:00:00Z',market:'total',line,side,probability:.5,american:-110} as GamePrice));
  const value=expectedGoals(pair(5.5)).get('e');
  assert.ok(value!==undefined && value > 5 && value < 6);
  for(const line of [Infinity,NaN,-1.5,1e12+.5]) assert.equal(expectedGoals(pair(line)).size,0);
});

test('indexed internal history preserves ID-or-name matching, tie order, cutoff, limits and new writes', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { InternalHistoryStore } = await import('../src/internal-history.js');
  const dir=await mkdtemp(join(tmpdir(),'freeze-index-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new InternalHistoryStore(join(dir,'history.json'));
  const base={sport:'NFL' as const,sourcePlayerId:null,eventId:'old',occurredAt:'2030-10-01T00:00:00Z',metrics:{passing_yds:200},
    marketValues:{},sourceKind:'SEED_BACKFILL' as const,sourceName:'fixture',sourceUrl:'https://example.org',sourceType:'PUBLIC' as const,
    importedAt:'2030-10-12T00:00:00Z',modelVersion:null,line:null,direction:null,lineScore:null,dataConfidence:null};
  const rows=[{...base,id:'id-only',playerId:'p',playerName:'Other Name'},
    {...base,id:'name-only',playerId:'other',playerName:'José Doe Jr.'},
    {...base,id:'both',playerId:'p',playerName:'Jose Doe'},
    {...base,id:'future',playerId:'p',playerName:'Jose Doe',occurredAt:'2030-10-15T00:00:00Z'},
    {...base,id:'wrong-sport',sport:'NBA' as const,playerId:'p',playerName:'Jose Doe'}];
  await store.add(rows);
  const target={sport:'NFL' as const,league:'NFL',playerId:'p',playerName:'Jose Doe',eventId:'future',eventName:'A @ B',
    eventStartTime:'2030-10-13T00:00:00Z',team:null,opponent:null,market:'passing_yards'};
  assert.deepEqual((await store.rowsFor(target)).map((row)=>row.id),['id-only','name-only','both']);
  assert.deepEqual((await store.rowsForTargets([target],2)).get(target)?.map((row)=>row.id),['id-only','name-only']);
  await store.add([{...base,id:'newest',playerId:'p',playerName:'Jose Doe',occurredAt:'2030-10-12T00:00:00Z'}]);
  assert.deepEqual((await store.rowsFor(target,2)).map((row)=>row.id),['newest','id-only']);
});
