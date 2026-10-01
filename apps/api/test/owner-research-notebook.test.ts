import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductLedger } from '../src/product-ledger.js';
import { buildServer } from '../src/server.js';
import { OwnerResearchNotebook } from '../src/owner-research-notebook.js';
import { StatApiOwnerResearch } from '../src/stat-api-owner-research.js';

test('PGA research supports private watched round data; file preserves raw facts and editable notes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'crowniq-owner-notebook-'));
  const path=join(dir,'private','research.json');
  let time=Date.parse('2030-09-24T12:00:00Z'),calls=0,round=70;
  const clock=()=>new Date(time);
  const urls:string[]=[];
  const provider=new StatApiOwnerResearch('fake-secret',async(input)=>{
    const url=String(input);calls++;urls.push(url);
    const headers={'x-quota-remaining':'19999999'};
    if(url.includes('/pga/players?'))return new Response(JSON.stringify({players:[
      {id:9,full_name:'Sample Golfer'}],next_from_id:null}),{headers});
    if(url.endsWith('/pga/players/9'))return new Response(JSON.stringify({id:9,
      full_name:'Sample Golfer',team_id:null}),{headers});
    if(url.includes('/pga/player_rounds?'))return new Response(JSON.stringify({player_rounds:[
      {id:99,player_id:9,tournament_id:88,round_number:1,score:round,birdies:4}],
      next_from_id:null}),{headers});
    throw Error(`unexpected provider path ${url}`);
  },clock);
  const notebook=new OwnerResearchNotebook(path,provider,60,clock);
  const product=new ProductLedger(join(dir,'profiles.json'),'CROWN_STRONG',clock);
  const owner=await product.register('owner@example.org','long-owner-password','Owner_A');
  const guest=await product.register('guest@example.org','long-guest-password','Guest_A');
  const app=buildServer({product,requireProfiles:true,ownerPublicId:owner.profile.publicId,
    ownerResearch:provider,ownerNotebook:notebook,clock});
  const headers={authorization:`Bearer ${owner.token}`};
  const guestHeaders={authorization:`Bearer ${guest.token}`};
  try{
    assert.equal((await app.inject({url:'/v1/owner/research/export',headers:guestHeaders})).statusCode,404);
    assert.equal((await app.inject({url:'/v1/owner/research/refresh',headers,method:'POST',
      payload:{}})).statusCode,400);
    assert.equal(calls,0);
    const search=await app.inject({url:'/v1/owner/research/search?sport=PGA&q=Golfer',headers});
    assert.equal(search.statusCode,200);
    assert.equal(search.json().players[0].name,'Sample Golfer');
    assert.equal(urls[0].includes('roster_status'),false);
    const watch=await app.inject({url:'/v1/owner/research/watch',method:'POST',headers,
      payload:{sport:'PGA',playerId:9,table:'player_rounds'}});
    assert.equal(watch.statusCode,200);
    assert.equal(watch.json().entry.detail.rows[0].metrics.score,70);
    assert.equal((await app.inject({url:'/v1/owner/research/status',headers})).json().notebook.watched,1);
    const original=await app.inject({url:'/v1/owner/research/export',headers});
    assert.equal(original.headers['cache-control'],'private, no-store');
    assert.match(String(original.headers['content-disposition']),/attachment/);
    assert.equal(original.body.includes('fake-secret'),false);
    const file=original.json();
    file.entries[0].notes='This is my private review.';
    file.entries[0].independentSources=['https://example.org/independent-notes'];
    file.entries[0].reviewed=true;
    file.entries[0].detail.rows[0].metrics.score=100000; // Edited provider data must not replace facts.
    const imported=await app.inject({url:'/v1/owner/research/import',method:'PUT',headers,payload:file});
    assert.equal(imported.statusCode,200);
    assert.equal(imported.json().providerSnapshotsChanged,false);
    const retained=(await app.inject({url:'/v1/owner/research/notebook',headers})).json();
    assert.equal(retained.entries[0].detail.rows[0].metrics.score,70);
    assert.equal(retained.entries[0].notes,'This is my private review.');
    assert.equal(retained.entries[0].reviewed,true);
    const saved=JSON.parse(await readFile(path,'utf8'));
    assert.equal(saved.entries[0].detail.rows[0].metrics.score,70);
    assert.equal(saved.entries[0].independentSources.length,1);
    assert.equal((await app.inject({url:'/v1/board',headers})).statusCode,503);
    assert.equal(calls,3); // Only explicit search and watch used records.
    const rejected=await app.inject({url:'/v1/owner/research/import',method:'PUT',headers,
      payload:{version:1,entries:[{key:'NBA/999/game_player_stats',notes:'?',
        independentSources:[],reviewed:true}]}});
    assert.equal(rejected.statusCode,400);
    assert.equal((await app.inject({url:'/v1/owner/research/notebook',headers})).json().entries[0].notes,
      'This is my private review.');
    time+=60*60_000;round=68;
    const refresh=await app.inject({url:'/v1/owner/research/refresh',method:'POST',headers,
      payload:{acknowledgeRecords:true}});
    assert.equal(refresh.statusCode,202);
    await notebook.refreshAll();
    assert.equal((await app.inject({url:'/v1/owner/research/notebook',headers})).json()
      .entries[0].detail.rows[0].metrics.score,68);
    assert.equal((await app.inject({url:'/v1/owner/research/notebook',headers})).json()
      .entries[0].reviewed,false);
    const stale=await app.inject({url:'/v1/owner/research/import',method:'PUT',headers,payload:file});
    assert.equal(stale.statusCode,409);
    assert.equal(stale.json().code,'STALE_RESEARCH_ANNOTATION');
    const unwatch=await app.inject({url:'/v1/owner/research/unwatch',method:'POST',headers,
      payload:{key:'PGA/9/player_rounds'}});
    assert.equal(unwatch.statusCode,200);
    const before=calls;
    assert.equal((await notebook.refreshAll()).skipped,true);
    assert.equal(calls,before);
    const reopened=new OwnerResearchNotebook(path,provider,60,clock);await reopened.load();
    assert.equal(reopened.export().entries[0].watching,false);
    assert.equal(reopened.export().entries[0].notes,'This is my private review.');
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
