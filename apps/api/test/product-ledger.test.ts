import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisSchema, boardResponseSchema } from '@crowniq/contracts';
import type { BoardResponse, PropLine } from '@crowniq/contracts';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { ProductLedger } from '../src/product-ledger.js';
import type { ResultFact } from '../src/product-ledger.js';
import { ProductGradingWorker } from '../src/background-grading.js';
import { NflverseResultsFeed } from '../src/nflverse-results.js';

const now=new Date('2030-09-24T12:00:00Z');
function build(event:string,player='alpha',threshold=24.5,scoreBand='CROWN_STRONG',
  version='GKR-NFL-1',market='passing_yards'):BoardResponse {
  const line=fixtureLine({id:`${event}-${player}-${market}-${threshold}`,
    sourceLineId:`source-${event}-${player}-${market}-${threshold}`,
    eventId:event,playerId:player,playerName:player,team:player==='alpha'?'AAA':'BBB',
    eventStartTime:'2030-09-25T00:00:00Z',threshold,market,fetchedAt:now.toISOString(),
    availableDirections:['MORE']});
  const analysis=analysisSchema.parse({lineId:line.id,direction:'MORE',score:89,
    scoreBand,contextScore:92,scoreBreakdown:[],assessments:[],evidenceIds:[],
    evidenceQuality:'HIGH',evidenceExpiresAt:'2030-09-25T00:00:00Z',dangerZone:false,
    thresholdCushion:2,ruleChecks:[],supportingFactors:[],opposingFactors:[],
    rationale:'Synthetic fixture',reasonCode:null,modelVersion:version});
  return boardResponseSchema.parse({board:{provider:'prizepicks',fetchedAt:now.toISOString(),lines:[line]},
    analyses:[analysis],rankedLineIds:[line.id],builtAt:now.toISOString()});
}
function combine(...boards:BoardResponse[]):BoardResponse{return boardResponseSchema.parse({
  board:{provider:'prizepicks',fetchedAt:now.toISOString(),lines:boards.flatMap((b)=>b.board.lines)},
  analyses:boards.flatMap((b)=>b.analyses),rankedLineIds:boards.flatMap((b)=>b.rankedLineIds),
  builtAt:now.toISOString()});}
function fact(line:PropLine,actual:number|null,status:ResultFact['status']='FINAL'):ResultFact {
  return {eventId:line.eventId,playerId:line.playerId,market:line.market,actual,status,
    sourceName:'Synthetic official results',sourceUrl:'https://example.org/fixture',
    completedAt:'2030-09-25T04:00:00Z'};
}

test('strong decisions are immutable, idempotent, distinct after line movement; verified L10 keeps full archive',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-ledger-'));
  try {
    let clock=now;const ledger=new ProductLedger(join(folder,'ledger.json'),'CROWN_STRONG',()=>clock);
    const first=build('e0');
    assert.equal(await ledger.track(first,[]),1);
    assert.equal(await ledger.track(first,[]),0);
    assert.equal(await ledger.track(build('e0','alpha',25.5),[]),1);
    assert.equal(await ledger.track(build('pass','alpha',24.5,'PASS'),[]),0);
    const boards=Array.from({length:12},(_,i)=>build(`e${i+1}`));
    for(const board of boards)await ledger.track(board,[]);
    clock=new Date('2030-09-26T00:00:00Z');
    for(const board of [first,...boards])await ledger.grade([fact(board.board.lines[0],25)]);
    const all=await ledger.listDecisions(0,100);
    assert.equal(all.total,14);
    const history=await ledger.history('NFL','alpha',first.board.lines[0].market);
    assert.equal(history.sampleSize,10);assert.equal(history.fullArchiveCount,14);
    assert.equal(history.label,'CrownIQ Tracked L10');
    assert.equal(history.internalOutcomeDistribution?.mean,25);
    const earlier=all.decisions.find((item)=>item.exactLine===24.5 && item.eventId==='e0')!;
    assert.equal(earlier.modelVersion,'GKR-NFL-1');assert.equal(earlier.exactLine,24.5);
    assert.equal(earlier.grade,'WIN');
    const learning=await ledger.learningSummary();
    assert.deepEqual({tracked:learning.tracked,pending:learning.pending,graded:learning.graded,
      dnpVoid:learning.dnpVoid},{tracked:14,pending:0,graded:14,dnpVoid:0});
    assert.equal(learning.models[0].picks,14);
    const restarted=new ProductLedger(join(folder,'ledger.json'),'CROWN_STRONG',()=>clock);
    assert.equal((await restarted.listDecisions()).total,14);
  } finally {await rm(folder,{recursive:true,force:true});}
});

test('saved picks and Crowns use event start, not a thirty-minute snapshot cutoff',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-event-window-'));
  try{
    let clock=new Date(now.getTime()+60*60_000);
    const ledger=new ProductLedger(join(folder,'data.json'),'CROWN_STRONG',()=>clock,()=>[]);
    const account=await ledger.register('event@example.org','abcdefghijkl','Event_owner');
    const identity=await ledger.authenticate(account.token);assert.ok(identity);
    const board=combine(build('event','alpha'),build('event','beta'));
    const ids=board.board.lines.map((line)=>line.id);
    assert.equal((await ledger.saveUserPick(identity.accountId,ids[0],board,[])).saved,true);
    assert.ok((await ledger.savePrivateCrown(identity.accountId,ids,board,[])).id);
    await ledger.upsertProfile('event-actor','Event Actor');
    const shared=await ledger.share('event-actor',ids,board,[]);
    assert.deepEqual((await ledger.importPreview(shared.publicCrownId,board))?.legs.map(
      (item)=>item.status),['AVAILABLE','AVAILABLE']);
    clock=new Date('2030-09-25T00:00:00Z');
    await assert.rejects(()=>ledger.saveUserPick(identity.accountId,ids[0],board,[]),
      /INVALID_OR_STALE_PICK/);
    await assert.rejects(()=>ledger.savePrivateCrown(identity.accountId,ids,board,[]),
      /INVALID_OR_STALE_CROWN/);
    assert.equal((await ledger.importPreview(shared.publicCrownId,board))?.legs[0].status,
      'CHANGED_OR_UNAVAILABLE');
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('DNP and VOID retain verified grade but do not invent numeric history',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-ledger-'));
  try {let clock=now;const ledger=new ProductLedger(join(folder,'data.json'),'CROWN_STRONG',()=>clock);
    const a=build('a'),b=build('b');await ledger.track(a,[]);await ledger.track(b,[]);
    clock=new Date('2030-09-26T00:00:00Z');
    await ledger.grade([fact(a.board.lines[0],null,'DNP'),fact(b.board.lines[0],null,'VOID')]);
    const history=await ledger.history('NFL','alpha',a.board.lines[0].market);
    assert.equal(history.label,'CrownIQ Tracked L2');
    assert.equal(history.actualSampleSize,0);
    assert.equal(history.internalOutcomeDistribution,null);
    assert.deepEqual(new Set(history.recent.map((item)=>item.grade)),new Set(['DNP','VOID']));
    const learning=await ledger.learningSummary();
    assert.deepEqual({tracked:learning.tracked,pending:learning.pending,graded:learning.graded,
      dnpVoid:learning.dnpVoid},{tracked:2,pending:0,graded:0,dnpVoid:2});
  } finally {await rm(folder,{recursive:true,force:true});}
});

test('Social defaults private; explicit share, follow, unshare, graded public Top 10 and exact-line import',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-social-'));
  try {let clock=now;const ledger=new ProductLedger(join(folder,'data.json'),'CROWN_STRONG',()=>clock,()=>[]);
    const owner=await ledger.upsertProfile('private-actor-a','RioKing');
    const viewer=await ledger.upsertProfile('private-actor-b','Viewer');
    const solo=build('solo');await ledger.track(solo,[]);
    assert.equal((await ledger.topUsers() as {users:unknown[]}).users.length,0);
    assert.equal((await ledger.recentTopCrowns()).length,0);
    const crowns:Awaited<ReturnType<typeof ledger.share>>[]=[];
    const all:BoardResponse[]=[];
    for(let n=0;n<10;n++){
      const pair=combine(build(`ev${n}`,'alpha'),build(`ev${n}`,'beta'));
      all.push(pair);crowns.push(await ledger.share('private-actor-a',pair.board.lines.map((l)=>l.id),pair,[]));
    }
    const shared=crowns[0];assert.equal((await ledger.crownsFor(owner.publicId))?.total,10);
    await assert.rejects(()=>ledger.share('private-actor-a',all[0].board.lines.map((l)=>l.id),all[0],[]),/DUPLICATE/);
    assert.deepEqual(await ledger.follow('private-actor-b',owner.publicId,true),{following:true});
    assert.equal((await ledger.profile(owner.publicId,viewer.publicId))?.following,true);
    assert.equal((await ledger.followingCrowns('private-actor-b')).length,10);
    assert.equal((await ledger.followingCrowns('private-actor-b',2)).length,2);
    assert.equal((await ledger.followingCrowns('private-actor-a')).length,0);
    assert.deepEqual(await ledger.follow('private-actor-b',owner.publicId,false),{following:false});
    assert.equal((await ledger.followingCrowns('private-actor-b')).length,0);
    await ledger.follow('private-actor-b',owner.publicId,true);
    const moved=combine(build('ev0','alpha',25.5),build('ev0','beta'));
    const preview=await ledger.importPreview(shared.publicCrownId,moved);
    assert.equal(preview?.legs[0].status,'CHANGED_OR_UNAVAILABLE');
    assert.equal(preview?.legs[0].currentOptions[0].threshold,25.5);
    clock=new Date('2030-09-26T00:00:00Z');
    for(const pair of all)await ledger.grade(pair.board.lines.map((line)=>fact(line,30)));
    assert.deepEqual((await ledger.crown(shared.publicCrownId))?.legs.map((leg)=>leg.grade),['WIN','WIN']);
    const top=await ledger.topUsers() as {users:{publicId:string;wins:number;graded:number;hitRate:number}[]};
    assert.equal(top.users.length,1);assert.equal(top.users[0].publicId,owner.publicId);
    assert.equal(top.users[0].wins,20);assert.equal(top.users[0].hitRate,1);
    assert.equal((await ledger.recentTopCrowns()).length,10);
    assert.strictEqual(await ledger.topUsers(),await ledger.topUsers());
    await ledger.unshare('private-actor-a',shared.publicCrownId);
    assert.equal((await ledger.followingCrowns('private-actor-b')).length,9);
    assert.equal(await ledger.crown(shared.publicCrownId),null);
    assert.equal((await ledger.profile(owner.publicId))?.wins,20);
    assert.equal((await ledger.crownsFor(owner.publicId))?.total,9);
    assert.equal((await ledger.recentTopCrowns()).length,9);
    const raw=await readFile(join(folder,'data.json'),'utf8');
    assert.ok(!JSON.stringify(await ledger.profile(owner.publicId)).includes('private-actor-a'));
    assert.ok(raw.includes('private-actor-a')); // actor key stays in the private ledger only.
  } finally {await rm(folder,{recursive:true,force:true});}
});

test('Top 10 cap ranks qualified public wins and excludes other users from recent Crowns',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-leaders-'));
  try {
    let clock=now;const ledger=new ProductLedger(join(folder,'data.json'),'CROWN_STRONG',()=>clock,()=>[]);
    const profiles:{publicId:string;displayName:string}[]=[];const results:ResultFact[]=[];
    for(let user=0;user<11;user++){
      profiles.push(await ledger.upsertProfile(`private-${user}`,`User ${user}`));
      for(let event=0;event<10;event++){
        const pair=combine(build(`event-${user}-${event}`,'alpha'),
          build(`event-${user}-${event}`,'beta'));
        await ledger.share(`private-${user}`,pair.board.lines.map((line)=>line.id),pair,[]);
        pair.board.lines.forEach((line,index)=>results.push(fact(line,event*2+index<20-user?30:10)));
      }
    }
    clock=new Date('2030-09-26T00:00:00Z');
    assert.equal((await ledger.topUsers() as {users:unknown[]}).users.length,0);
    await ledger.grade(results);
    const top=await ledger.topUsers() as {users:{publicId:string;wins:number;graded:number}[]};
    assert.equal(top.users.length,10);
    assert.deepEqual(top.users.map((item)=>item.wins),[20,19,18,17,16,15,14,13,12,11]);
    assert.equal(top.users[0].publicId,profiles[0].publicId);
    assert.equal(top.users.every((item)=>item.graded===20),true);
    const recent=await ledger.recentTopCrowns();
    assert.ok(recent.every((item)=>item.ownerPublicId!==profiles[10].publicId));
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('Social sharing fails closed without a trusted correlation audit',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-social-audit-'));
  try {
    const board=combine(build('e','alpha'),build('e','beta'));
    const missing=new ProductLedger(join(folder,'missing.json'),'CROWN_STRONG',()=>now);
    await missing.upsertProfile('owner','Owner');
    await assert.rejects(()=>missing.share('owner',board.board.lines.map((l)=>l.id),board,[]),
      /CORRELATION_AUDIT_UNAVAILABLE/);
    const rejected=new ProductLedger(join(folder,'rejected.json'),'CROWN_STRONG',()=>now,
      ()=>['NEGATIVE_CORRELATION']);
    await rejected.upsertProfile('owner','Owner');
    await assert.rejects(()=>rejected.share('owner',board.board.lines.map((l)=>l.id),board,[]),
      /NEGATIVE_CORRELATION/);
    assert.equal((await rejected.recentTopCrowns()).length,0);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('background grading auto-grades the tracked NFL volume markets into internal history',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-background-multi-'));
  try{
    let clock=now;const ledger=new ProductLedger(join(folder,'data.json'),'CROWN_STRONG',()=>clock);
    const markets=[
      ['player_pass_completions','qb',22],
      ['player_rush_yds','rb-yards',71],
      ['player_rush_attempts','rb-carries',14],
      ['player_reception_yds','wr-yards',83],
      ['player_receptions','wr-catches',6],
      ['player_receiving_targets','wr-targets',9],
    ] as const;
    const boards=markets.map(([market,player])=>build('multi',player,5,'CROWN_STRONG','GKR-NFL-1',market));
    await ledger.track(combine(...boards),[]);
    const path=join(folder,'mapping.json');
    await writeFile(path,JSON.stringify({format:'crowniq-nflverse-map-v1',mappings:markets.map(([,player],index)=>({
      eventId:'multi',playerId:player,nflverseGameId:'2030_01_AAA_BBB',
      nflversePlayerId:`nfl-${index+1}`,team:'BBB',season:2030,
      completedAt:'2030-09-25T04:00:00Z'}))}));
    const header='game_id,player_id,team,attempts,passing_yards,completions,rushing_yards,carries,receiving_yards,receptions,targets\n';
    const rows=markets.map(([,],index)=>{
      const values=[
        ['30','250','22','0','0','0','0','0'],
        ['0','0','0','71','14','0','0','0'],
        ['0','0','0','71','14','0','0','0'],
        ['0','0','0','0','0','83','6','9'],
        ['0','0','0','0','0','83','6','9'],
        ['0','0','0','0','0','83','6','9'],
      ][index];
      return `2030_01_AAA_BBB,nfl-${index+1},BBB,${values.join(',')}`;
    }).join('\n');
    clock=new Date('2030-09-26T00:00:00Z');
    const worker=new ProductGradingWorker(ledger,path,new NflverseResultsFeed(async()=>
      new Response(header+rows)),()=>clock);
    assert.deepEqual(await worker.runOnce(),{graded:6,pending:0});
    for(const [market,player,actual] of markets){
      const history=await ledger.history('NFL',player,market);
      assert.equal(history.recent[0].actual,actual,`${market} actual`);
    }
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('background grading can resolve an exact completed NFL game without a manual mapping file',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-background-auto-map-'));
  try{
    let clock=now;const ledger=new ProductLedger(join(folder,'data.json'),'CROWN_STRONG',()=>clock);
    const board=build('auto-event','auto-player',4.5,'CROWN_STRONG','GKR-NFL-1','player_receptions');
    board.board.lines[0].eventName='Pittsburgh Steelers @ Cleveland Browns';
    board.board.lines[0].eventStartTime='2030-09-25T00:15:00Z';
    board.board.lines[0].playerName='Exact Player';
    board.board.lines[0].team=null;board.board.lines[0].opponent=null;
    await ledger.track(board,[]);
    const schedule='game_id,season,gameday,gametime,away_team,away_score,home_team,home_score\n'+
      '2030_01_PIT_CLE,2030,2030-09-24,20:15,PIT,21,CLE,17\n';
    const stats='game_id,player_id,team,attempts,passing_yards,player_display_name,receptions,targets,receiving_yards\n'+
      '2030_01_PIT_CLE,nfl-auto,PIT,0,0,Exact Player,6,9,83\n';
    const feed=new NflverseResultsFeed(async(input)=>{
      const url=String(input);return new Response(url.includes('games.csv')?schedule:stats,{status:200});
    });
    clock=new Date('2030-09-25T06:30:00Z');
    const worker=new ProductGradingWorker(ledger,null,feed,()=>clock);
    assert.deepEqual(worker.status(),{running:false,scheduled:false,intervalMs:null,
      lastStartedAt:null,lastFinishedAt:null,nextRunAt:null,lastResult:null,lastError:null});
    assert.deepEqual(await worker.runOnce(),{graded:1,pending:0});
    assert.deepEqual(worker.status().lastResult,{graded:1,pending:0});
    assert.equal(worker.status().lastStartedAt,clock.toISOString());
    assert.equal(worker.status().lastFinishedAt,clock.toISOString());
    assert.equal(worker.status().lastError,null);
    const history=await ledger.history('NFL','auto-player','player_receptions');
    assert.equal(history.recent[0].actual,6);
    const decision=(await ledger.listDecisions()).decisions[0];
    assert.equal(decision.resultSourceName,'nflverse weekly player stats');
    assert.ok(decision.resultSourceUrl?.includes('stats_player_week_2030.csv'));
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('background grader reports scheduler and source failures without changing pending decisions',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-background-status-'));
  try{
    let clock=now;
    const ledger=new ProductLedger(join(folder,'data.json'),'CROWN_STRONG',()=>clock);
    const board=build('status-event','status-player',4.5,'CROWN_STRONG','GKR-NFL-1','player_receptions');
    board.board.lines[0].eventName='Pittsburgh Steelers @ Cleveland Browns';
    board.board.lines[0].eventStartTime='2030-09-25T00:15:00Z';
    board.board.lines[0].playerName='Status Player';
    board.board.lines[0].team=null;board.board.lines[0].opponent=null;
    await ledger.track(board,[]);
    clock=new Date('2030-09-25T06:30:00Z');
    const worker=new ProductGradingWorker(ledger,null,new NflverseResultsFeed(async()=>
      new Response('unavailable',{status:503})),()=>clock);
    worker.start(60_000);
    const scheduled=worker.status();
    assert.equal(scheduled.scheduled,true);
    assert.equal(scheduled.intervalMs,60_000);
    assert.equal(scheduled.nextRunAt,'2030-09-25T06:31:00.000Z');
    await assert.rejects(worker.runOnce(),/NFLVERSE_STATS_UNAVAILABLE/);
    const failed=worker.status();
    assert.equal(failed.running,false);
    assert.equal(failed.lastError,'NFLVERSE_STATS_UNAVAILABLE');
    assert.equal(failed.lastResult,null);
    assert.equal((await ledger.listDecisions()).decisions[0].grade,'PENDING');
    worker.stop();
    assert.equal(worker.status().scheduled,false);
    assert.equal(worker.status().nextRunAt,null);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('background grading uses exact NFL mapping and leaves absent results pending',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-background-'));
  try {
    let clock=now;const ledger=new ProductLedger(join(folder,'data.json'),'CROWN_STRONG',()=>clock);
    const board=build('event-1');await ledger.track(board,[]);
    const path=join(folder,'mapping.json');
    await writeFile(path,JSON.stringify({format:'crowniq-nflverse-map-v1',mappings:[{
      eventId:'event-1',playerId:'alpha',nflverseGameId:'2030_01_AAA_BBB',
      nflversePlayerId:'nfl-player',team:'AAA',season:2030,
      completedAt:'2030-09-25T04:00:00Z'}]}));
    clock=new Date('2030-09-26T00:00:00Z');
    const missing=new ProductGradingWorker(ledger,path,new NflverseResultsFeed(async()=>
      new Response('game_id,player_id,team,attempts,passing_yards\nother,other,AAA,30,280')),
      ()=>clock);
    assert.deepEqual(await missing.runOnce(),{graded:0,pending:1});
    const worker=new ProductGradingWorker(ledger,path,new NflverseResultsFeed(async()=>
      new Response('game_id,player_id,team,attempts,passing_yards\n2030_01_AAA_BBB,nfl-player,AAA,30,280')),
      ()=>clock);
    assert.deepEqual(await worker.runOnce(),{graded:1,pending:0});
    assert.deepEqual(await worker.runOnce(),{graded:0,pending:0});
    assert.equal((await ledger.history('NFL','alpha',board.board.lines[0].market)).recent[0].actual,280);
  }finally{await rm(folder,{recursive:true,force:true});}
});

const withScore=(board:BoardResponse,score:number,evidenceIds:string[]=[]):BoardResponse=>boardResponseSchema.parse({
  ...board,analyses:board.analyses.map((item)=>({...item,score,evidenceIds}))});

test('re-tracking the same decision keeps one decision and records changed reads as revisions',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-dedupe-'));
  try{
    let clock=now;
    const ledger=new ProductLedger(join(folder,'data.json'),'CROWN_STRONG',()=>clock);
    const board=build('dedupe');
    assert.equal(await ledger.track(board,[]),1);
    clock=new Date(now.getTime()+15*60_000);
    assert.equal(await ledger.track(board,[]),0);
    assert.equal(await ledger.track(withScore(board,91),[]),0);
    const {total,decisions}=await ledger.listDecisions();
    assert.equal(total,1);
    // The identical second read adds nothing; the changed score is kept as one revision.
    assert.deepEqual(decisions[0].revisions?.map((item)=>item.lineScore),[91]);
    assert.equal(decisions[0].lineScore,89,'the first read stays the graded decision');
    // A different line (moved threshold) is a different decision.
    assert.equal(await ledger.track(build('dedupe','alpha',25.5),[]),1);
    clock=new Date('2030-09-26T00:00:00Z');
    // One result grades each distinct line once: two decisions, never a copy per re-analysis.
    assert.deepEqual(await ledger.grade([fact(board.board.lines[0],30)]),{graded:2,unmatched:0,personal:0});
    assert.deepEqual([(await ledger.learningSummary()).tracked,(await ledger.learningSummary()).graded],[2,2]);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('an older ledger with duplicate decisions is backed up, folded and re-pointed on read',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-migrate-'));
  try{
    const path=join(folder,'data.json');
    // Build a ledger the old way: three copies of one decision under different ids, one graded.
    const seed=new ProductLedger(path,'CROWN_STRONG',()=>now);
    const account=await seed.register('fold@example.org','abcdefghijkl','Fold_owner');
    const identity=(await seed.authenticate(account.token))!;
    await seed.upsertProfile('fold-actor','Fold Actor');
    await seed.track(build('fold'),[]);
    const stored=JSON.parse(await readFile(path,'utf8'));
    const original=stored.decisions[0];
    const copy=(id:string,minutes:number,extra:object={})=>{
      const value={...structuredClone(original),trackedPickId:id,
        createdAt:new Date(now.getTime()+minutes*60_000).toISOString(),lineScore:89+minutes/15,...extra};
      delete value.decisionKey;delete value.revisions;return value;
    };
    stored.decisions=[copy('old-1',0),copy('old-2',15,{grade:'WIN',actualResult:30,resultStatus:'FINAL',
      gradedAt:'2030-09-26T00:00:00Z',resultSourceName:'Synthetic',resultSourceUrl:'https://example.org/r'}),copy('old-3',30)];
    stored.savedPicks=[{accountId:identity.accountId,trackedPickId:'old-2',savedAt:now.toISOString(),removedAt:null},
      {accountId:identity.accountId,trackedPickId:'old-3',savedAt:now.toISOString(),removedAt:null}];
    stored.privateCrowns=[{id:'crown-1',accountId:identity.accountId,trackedPickIds:['old-3','x'],
      savedAt:now.toISOString(),removedAt:null}];
    const publicId=stored.profiles[0].publicId;
    stored.crowns=[{publicCrownId:'00000000-0000-4000-8000-000000000001',ownerPublicId:publicId,createdAt:now.toISOString(),
      legs:[{...{trackedPickId:'old-2',playerName:'alpha',market:'passing_yards',exactLine:24.5,direction:'MORE',
        lineType:'REGULAR',lineScore:90,modelVersion:'GKR-NFL-1',eventId:'fold',playerId:'alpha',sport:'NFL'}}],unsharedAt:null}];
    stored.publicCredits=[{publicId,trackedPickId:'old-2'},{publicId,trackedPickId:'old-3'}];
    await writeFile(path,JSON.stringify(stored));

    const ledger=new ProductLedger(path,'CROWN_STRONG',()=>now);
    const {decisions}=await ledger.listDecisions();
    assert.equal(decisions.length,1);
    assert.equal(decisions[0].trackedPickId,'old-1','the earliest copy is kept');
    assert.equal(decisions[0].grade,'WIN','a grade on any copy carries over');
    assert.deepEqual(decisions[0].revisions?.map((item)=>item.lineScore),[90,91]);
    const after=JSON.parse(await readFile(path,'utf8'));
    assert.deepEqual(after.savedPicks.map((item:{trackedPickId:string})=>item.trackedPickId),['old-1']);
    assert.deepEqual(after.privateCrowns[0].trackedPickIds,['old-1','x']);
    assert.equal(after.crowns[0].legs[0].trackedPickId,'old-1');
    assert.deepEqual(after.publicCredits,[{publicId,trackedPickId:'old-1'}]);
    const { readdir } = await import('node:fs/promises');
    const backups=(await readdir(folder)).filter((name)=>name.startsWith('data.json.backup-'));
    assert.equal(backups.length,1);
    assert.equal(JSON.parse(await readFile(join(folder,backups[0]),'utf8')).decisions.length,3);
    // Reading again changes nothing and makes no second backup.
    await ledger.listDecisions();
    assert.equal((await readdir(folder)).filter((name)=>name.startsWith('data.json.backup-')).length,1);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('picks record their snapshot age, and an optional limit refuses old snapshots for public Crowns',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-snapshot-age-'));
  try{
    const clock=new Date(now.getTime()+45*60_000);
    const ledger=new ProductLedger(join(folder,'data.json'),'CROWN_STRONG',()=>clock,()=>[],undefined,30);
    const account=await ledger.register('age@example.org','abcdefghijkl','Age_owner');
    const identity=(await ledger.authenticate(account.token))!;
    const board=combine(build('age','alpha'),build('age','beta'));
    const ids=board.board.lines.map((line)=>line.id);
    await ledger.saveUserPick(identity.accountId,ids[0],board,[]);
    const [decision]=(await ledger.listDecisions()).decisions;
    assert.deepEqual([decision.boardFetchedAt,decision.snapshotAgeMinutes],[now.toISOString(),45]);
    await ledger.upsertProfile('age-actor','Age Actor');
    await assert.rejects(()=>ledger.share('age-actor',ids,board,[]),/SNAPSHOT_TOO_OLD/);
    const fresh=boardResponseSchema.parse({...board,board:{...board.board,fetchedAt:new Date(clock.getTime()-10*60_000).toISOString()}});
    assert.equal((await ledger.share('age-actor',ids,fresh,[])).legs.length,2);
  }finally{await rm(folder,{recursive:true,force:true});}
});
