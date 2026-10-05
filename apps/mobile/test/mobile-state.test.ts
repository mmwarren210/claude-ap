import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisSchema, boardResponseSchema, DEFAULT_PAYOUTS, propLineSchema } from '@crowniq/contracts';
import { crownOutcome, entryOutlook } from '../src/insights.js';
import { aiPlay, lateNews, scoutVerdict } from '../src/scout.js';
import { addLeg, betterSwap, boardLinesForMode, isPlay, withBooksPicks, CROWN_LEG_FLOOR, emptyFilters, evidenceExpired, freshness, gkrBacked, shareCrown,
  visibleLines } from '../src/state.js';
import { parseDraft, profileDraftKey } from '../src/draft-codec.js';

const line=propLineSchema.parse({id:'one',sourceLineId:'one',provider:'prizepicks',sport:'CS2',
  league:'CS2',eventId:'event',eventName:'Fixture',eventStartTime:'2030-01-02T00:00:00Z',
  playerId:'a',playerName:'Test Player',team:'A',opponent:'B',market:'maps_1_2_kills',
  threshold:28.5,availableDirections:['MORE','LESS'],lineType:'GOBLIN',
  fetchedAt:'2030-01-01T12:00:00Z'});
const alternate=propLineSchema.parse({...line,id:'two',sourceLineId:'two',threshold:30.5,lineType:'REGULAR'});
const analysis=analysisSchema.parse({lineId:'one',direction:'MORE',score:89,scoreBreakdown:[],
  assessments:[],evidenceIds:[],evidenceQuality:'HIGH',dangerZone:false,ruleChecks:[],
  supportingFactors:[],opposingFactors:[],rationale:'Fixture only',reasonCode:null,
  modelVersion:'fixture-v1',scoreBand:'CROWN_STRONG'});
const board=boardResponseSchema.parse({board:{provider:'prizepicks',fetchedAt:'2030-01-01T12:00:00Z',
  lines:[line,alternate]},analyses:[analysis],rankedLineIds:['one'],builtAt:'2030-01-01T12:00:00Z'});

test('filters reset and select exact lines without modifying the provider board',()=>{
  assert.deepEqual(visibleLines(board,emptyFilters).map((item)=>item.id),['one','two']);
  assert.deepEqual(visibleLines(board,{...emptyFilters,lineType:'GOBLIN'}).map((item)=>item.id),['one']);
  assert.deepEqual(visibleLines(board,{...emptyFilters,direction:'MORE'}).map((item)=>item.id),['one']);
  assert.equal(board.board.lines[1].threshold,30.5);
  const eventStart=Date.parse(line.eventStartTime);
  assert.deepEqual(visibleLines(board,emptyFilters,eventStart),[]);
  assert.deepEqual(boardLinesForMode(board,emptyFilters,'LITE',eventStart),[]);
  assert.deepEqual(boardLinesForMode(board,emptyFilters,'FULL',eventStart),[]);
});
test('Lite follows GKR ranking and ignores Full-only filters; Full shows plays only, never a PASS',()=>{
  const pass=analysisSchema.parse({...analysis,lineId:'two',direction:'PASS',score:null,
    scoreBand:'PASS',modelVersion:null});
  const suspicious=boardResponseSchema.parse({...board,analyses:[analysis,pass],
    rankedLineIds:['two','one']});
  assert.deepEqual(boardLinesForMode(suspicious,emptyFilters,'LITE').map((item)=>item.id),['one']);
  assert.deepEqual(boardLinesForMode(suspicious,emptyFilters,'FULL').map((item)=>item.id),['one']);
  const hiddenFullFilter={...emptyFilters,direction:'PASS',grade:'PASS'};
  assert.deepEqual(boardLinesForMode(suspicious,hiddenFullFilter,'LITE').map((item)=>item.id),['one']);
  assert.deepEqual(boardLinesForMode(suspicious,hiddenFullFilter,'FULL'),[],'a PASS never shows on the Board');
  // Line style is a Board chip, so it applies in Lite too.
  assert.deepEqual(boardLinesForMode(suspicious,{...emptyFilters,lineType:'REGULAR'},'LITE'),[]);
  assert.deepEqual(boardLinesForMode(suspicious,{...emptyFilters,lineType:'GOBLIN'},'LITE').map((item)=>item.id),['one']);
  assert.deepEqual(boardLinesForMode(suspicious,{...emptyFilters,sport:'NHL'},'LITE'),[]);
  assert.equal(suspicious.board.lines[1].threshold,30.5);
});
test('profile draft migration preserves existing filters/legs and saves view choice per profile',()=>{
  const legacy={filters:{...emptyFilters,sport:'CS2'},legs:[{line,direction:'MORE',score:89,
    modelVersion:'fixture-v1'}]};
  const migrated=parseDraft(legacy);
  assert.equal(migrated.viewMode,'LITE');
  assert.equal(migrated.filters.sport,'CS2');
  assert.equal(migrated.legs[0].line.id,'one');
  assert.equal(parseDraft({...migrated,viewMode:'FULL'}).viewMode,'FULL');
  assert.notEqual(profileDraftKey('profile-a'),profileDraftKey('profile-b'));
});
test('Crown draft adds eligible line, blocks what PrizePicks blocks and tips on a PASS line',()=>{
  const first=addLeg([],line,analysis,'MORE');
  assert.equal(first.error,null);assert.equal(first.legs.length,1);assert.deepEqual(first.tips,[]);
  assert.match(addLeg(first.legs,alternate,{...analysis,lineId:'two'},'MORE').error!,/one pick per player/);
  assert.equal(addLeg([],{...line,lineType:'UNKNOWN_ALTERNATE'},analysis,'MORE').legs.length,0);
  assert.match(addLeg([],{...line,availableDirections:['MORE']},analysis,'LESS').error!,/does not offer LESS/);
  const pass=analysisSchema.parse({...analysis,direction:'PASS',score:null,modelVersion:null});
  const tipped=addLeg([],line,pass,'MORE');
  assert.equal(tipped.error,null);assert.equal(tipped.legs.length,0);
  assert.deepEqual(tipped.tips.map((tip)=>tip.id),['NO_SCORE']);
  const yours=addLeg([],line,pass,'MORE',undefined,['NO_SCORE']);
  assert.deepEqual([yours.legs[0].score,yours.legs[0].yourCall],[null,['NO_SCORE']]);
  assert.equal(gkrBacked(yours.legs),false);assert.equal(gkrBacked(first.legs),true);
  assert.match(shareCrown(yours.legs),/your call/);
  assert.equal(first.legs.filter((leg)=>leg.line.id!=='one').length,0);
  assert.match(shareCrown(first.legs),/GKR 89/);
  assert.match(shareCrown(first.legs),/not a guaranteed/);
});
test('snapshot remains usable for future events while expired events are stale',()=>{
  const base=Date.parse(board.board.fetchedAt);
  assert.equal(freshness(board,true,base+60_000),'LIVE');
  assert.equal(freshness(board,true,base+2*60_000),'FRESH');
  assert.equal(freshness(board,true,base+10*60_000),'CACHED');
  assert.equal(freshness(board,true,base+31*60_000),'SNAPSHOT');
  assert.equal(freshness(board,true,base+11*60*60_000),'SNAPSHOT');
  assert.equal(freshness(board,true,Date.parse(line.eventStartTime)),'STALE');
  assert.equal(freshness(board,false,base+60_000),'UNREACHABLE');
  assert.equal(freshness(board,false,base+60_000,true),'OFFLINE');
  assert.equal(freshness(null,true,base),'UNAVAILABLE');
});
test('a saved line can enter a draft until event start, unless evidence has expired',()=>{
  const captured=Date.parse(line.fetchedAt),event=Date.parse(line.eventStartTime);
  assert.equal(addLeg([],line,analysis,'MORE',captured+60*60_000).error,null);
  assert.equal(addLeg([],line,analysis,'MORE',event-1).error,null);
  assert.match(addLeg([],line,analysis,'MORE',event).error!,/game has started/);
  const expiring={...analysis,evidenceExpiresAt:new Date(captured+30*60_000).toISOString()};
  assert.deepEqual(addLeg([],line,expiring,'MORE',captured+60*60_000).tips.map((tip)=>tip.id),['STALE_EVIDENCE']);
});

test('Lite drops lines whose evidence expired; Full keeps the play for labelling',()=>{
  const expiring=boardResponseSchema.parse({...board,analyses:[{...analysis,evidenceExpiresAt:'2030-01-01T13:00:00Z'}]});
  const before=Date.parse('2030-01-01T12:30:00Z'),after=Date.parse('2030-01-01T13:30:00Z');
  assert.deepEqual(boardLinesForMode(expiring,emptyFilters,'LITE',before).map((item)=>item.id),['one']);
  assert.deepEqual(boardLinesForMode(expiring,emptyFilters,'LITE',after),[]);
  assert.deepEqual(boardLinesForMode(expiring,emptyFilters,'FULL',after).map((item)=>item.id),['one']);
  assert.equal(evidenceExpired(expiring.analyses[0],after),true);
  assert.equal(evidenceExpired(expiring.analyses[0],before),false);
});

test('a Crown leg must reach the lowest score any Crown accepts',()=>{
  const now=Date.parse('2030-01-01T12:30:00Z');
  const low=analysisSchema.parse({...analysis,score:79});
  assert.deepEqual(addLeg([],line,low,'MORE',now).tips.map((tip)=>tip.id),['LOW_SCORE']);
  const accepted=addLeg([],line,low,'MORE',now,['LOW_SCORE']);
  assert.deepEqual([accepted.legs[0].score,accepted.legs[0].yourCall],[79,['LOW_SCORE']]);
  assert.equal(addLeg([],line,analysisSchema.parse({...analysis,score:80}),'MORE',now).legs.length,1);
  assert.equal(CROWN_LEG_FLOOR,80);
});

test('taking the side GKR does not back is a tipped your-call leg with no GKR score',()=>{
  const now=Date.parse('2030-01-01T12:30:00Z');
  assert.deepEqual(addLeg([],line,analysis,'LESS',now).tips.map((tip)=>tip.id),['AGAINST_MODEL']);
  const leg=addLeg([],line,analysis,'LESS',now,['AGAINST_MODEL']).legs[0];
  assert.deepEqual([leg.direction,leg.score,leg.modelVersion],['LESS',null,null]);
});

test('a third player from one team is a tip, not a block',()=>{
  const now=Date.parse('2030-01-01T12:30:00Z');
  const player=(id:string)=>propLineSchema.parse({...line,id,sourceLineId:id,playerId:id,playerName:id});
  const scored=(id:string)=>analysisSchema.parse({...analysis,lineId:id});
  let legs=addLeg([],player('p1'),scored('p1'),'MORE',now).legs;
  legs=addLeg(legs,player('p2'),scored('p2'),'MORE',now).legs;
  const third=addLeg(legs,player('p3'),scored('p3'),'MORE',now);
  assert.deepEqual(third.tips.map((tip)=>tip.id),['TEAM_STACK']);
  assert.equal(addLeg(legs,player('p3'),scored('p3'),'MORE',now,['TEAM_STACK']).legs.length,3);
});

test('a clearly stronger qualified pick is offered for the weakest leg',()=>{
  const now=Date.parse('2030-01-01T12:30:00Z');
  const player=(id:string,team:string)=>propLineSchema.parse({...line,id,sourceLineId:id,playerId:id,playerName:id,team});
  const scored=(id:string,score:number)=>analysisSchema.parse({...analysis,lineId:id,score});
  const legs=addLeg([],player('weak','A'),scored('weak',81),'MORE',now).legs;
  const candidates=[{line:player('close','B'),analysis:scored('close',85)},{line:player('strong','C'),analysis:scored('strong',93)}];
  const swap=betterSwap(legs,candidates,now);
  assert.equal(swap?.weakest.line.id,'weak');assert.equal(swap?.line.id,'strong');
  assert.equal(betterSwap(legs,candidates.slice(0,1),now),null,'a small gain is not worth a tip');
});

test('Full shows one card per player: their strongest play, GKR first, then the AI read where GKR cannot score',()=>{
  const other=propLineSchema.parse({...line,id:'three',sourceLineId:'three',playerId:'b',playerName:'Other Player'});
  const withOther=boardResponseSchema.parse({...board,board:{...board.board,lines:[line,alternate,other]}});
  const ai=new Map([['two',{pick:'LESS',score:66}],['three',{pick:'MORE',score:61}]]);
  // Test Player has a GKR play (one) and an AI play (two): one card, the GKR play. Other Player shows by the AI read.
  assert.deepEqual(boardLinesForMode(withOther,emptyFilters,'FULL',undefined,ai).map((item)=>item.id),['one','three']);
  const aiOnly=new Map([['three',{pick:'PASS',score:null}]]);
  assert.deepEqual(boardLinesForMode(withOther,emptyFilters,'FULL',undefined,aiOnly).map((item)=>item.id),['one']);
});

test('Crown units use the app payouts: Flex where offered, Power otherwise',()=>{
  // PrizePicks 5-pick Flex pays 2x on 4 of 5; Pick6 has no Flex, so 4 of 5 pays nothing.
  const grades=['WIN','WIN','WIN','WIN','LOSS'];
  assert.deepEqual(crownOutcome(grades),{status:'SPLIT',units:1,multiplier:2});
  assert.deepEqual(crownOutcome(grades,DEFAULT_PAYOUTS.pick6),{status:'MISSED',units:-1,multiplier:0});
  assert.deepEqual(crownOutcome(['WIN','WIN'],DEFAULT_PAYOUTS.underdog),{status:'CASHED',units:2,multiplier:3});
  // A push drops out: 3 legs with a push grade as a 2-pick entry.
  assert.equal(crownOutcome(['WIN','WIN','PUSH']).multiplier,3);
  assert.deepEqual(entryOutlook(DEFAULT_PAYOUTS.pick6,6,'POWER'),{fullHit:40,breakEven:0.5407});
  assert.equal(entryOutlook(DEFAULT_PAYOUTS.pick6,6,'FLEX'),null);
});

test('a Scout second opinion is a verdict on the GKR pick, never a play by itself',()=>{
  const second={pick:'LESS' as const,score:66,agreement:'BOTH' as const,researchedAt:'2030-01-01T00:00:00Z',kind:'second' as const,
    gkr:{direction:'MORE' as const,score:90},providers:[{provider:'claude' as const,pick:'LESS',confidence:66,summary:'',reasons:[],
      lateNews:'Questionable with a sore wrist.'}]};
  assert.equal(scoutVerdict(second,'MORE'),'DISAGREES');
  assert.equal(scoutVerdict(second,'LESS'),'AGREES');
  assert.equal(scoutVerdict({...second,pick:'PASS',score:null},'MORE'),'NO_EDGE');
  assert.equal(scoutVerdict({...second,kind:'scout'},'MORE'),null,'a Scout pick is not a second opinion');
  assert.equal(lateNews(second),'Questionable with a sore wrist.');
  assert.equal(aiPlay(second),false);
  assert.equal(isPlay(undefined,second),false);
  assert.equal(isPlay(undefined,{...second,kind:'scout'}),true);
});

test('Books picks fill in only where Scout has no read, and count as plays at their no-vig chance',()=>{
  const scout={pick:'PASS',score:null,kind:'scout'};
  const merged=withBooksPicks(new Map([['a',scout],['b',{pick:'LESS',score:66,kind:'second'}]]),
    new Map([['a',{side:'MORE' as const,fair:0.6}],['b',{side:'MORE' as const,fair:0.58}],['c',{side:'LESS' as const,fair:0.57}]]));
  assert.equal(merged.get('a'),scout,'Scout looked closer: its PASS stands');
  assert.deepEqual(merged.get('b'),{pick:'MORE',score:58,kind:'books'},'a second opinion is not a pick');
  assert.deepEqual(merged.get('c'),{pick:'LESS',score:57,kind:'books'});
  assert.equal(isPlay(undefined,merged.get('c')),true);
});
