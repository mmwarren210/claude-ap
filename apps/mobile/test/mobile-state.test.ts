import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisSchema, boardResponseSchema, propLineSchema } from '@crowniq/contracts';
import { addLeg, boardLinesForMode, CROWN_LEG_FLOOR, emptyFilters, evidenceExpired, freshness, shareCrown, visibleLines } from '../src/state.js';
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
test('Lite follows GKR ranking, excludes PASS and ignores Full-only grade/direction filters; Full keeps every line',()=>{
  const pass=analysisSchema.parse({...analysis,lineId:'two',direction:'PASS',score:null,
    scoreBand:'PASS',modelVersion:null});
  const suspicious=boardResponseSchema.parse({...board,analyses:[analysis,pass],
    rankedLineIds:['two','one']});
  assert.deepEqual(boardLinesForMode(suspicious,emptyFilters,'LITE').map((item)=>item.id),['one']);
  assert.deepEqual(boardLinesForMode(suspicious,emptyFilters,'FULL').map((item)=>item.id),['one','two']);
  const hiddenFullFilter={...emptyFilters,direction:'PASS',grade:'PASS'};
  assert.deepEqual(boardLinesForMode(suspicious,hiddenFullFilter,'LITE').map((item)=>item.id),['one']);
  assert.deepEqual(boardLinesForMode(suspicious,hiddenFullFilter,'FULL').map((item)=>item.id),['two']);
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
test('Crown draft adds eligible line and rejects duplicate, PASS, invalid alternate',()=>{
  const first=addLeg([],line,analysis,'MORE');
  assert.equal(first.error,null);assert.equal(first.legs.length,1);
  assert.match(addLeg(first.legs,alternate,{...analysis,lineId:'two'},'MORE').error!,/already/);
  assert.equal(addLeg([],{...line,lineType:'UNKNOWN_ALTERNATE'},analysis,'MORE').legs.length,0);
  assert.equal(addLeg([],line,{...analysis,direction:'PASS'},'MORE').legs.length,0);
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
  assert.match(addLeg([],line,analysis,'MORE',event).error!,/event has started/);
  const expiring={...analysis,evidenceExpiresAt:new Date(captured+30*60_000).toISOString()};
  assert.match(addLeg([],line,expiring,'MORE',captured+60*60_000).error!,/evidence expired/);
});

test('Lite drops lines whose evidence expired; Full keeps them for labelling',()=>{
  const expiring=boardResponseSchema.parse({...board,analyses:[{...analysis,evidenceExpiresAt:'2030-01-01T13:00:00Z'}]});
  const before=Date.parse('2030-01-01T12:30:00Z'),after=Date.parse('2030-01-01T13:30:00Z');
  assert.deepEqual(boardLinesForMode(expiring,emptyFilters,'LITE',before).map((item)=>item.id),['one']);
  assert.deepEqual(boardLinesForMode(expiring,emptyFilters,'LITE',after),[]);
  assert.deepEqual(boardLinesForMode(expiring,emptyFilters,'FULL',after).map((item)=>item.id),['one','two']);
  assert.equal(evidenceExpired(expiring.analyses[0],after),true);
  assert.equal(evidenceExpired(expiring.analyses[0],before),false);
});

test('a Crown leg must reach the lowest score any Crown accepts',()=>{
  const now=Date.parse('2030-01-01T12:30:00Z');
  const low=analysisSchema.parse({...analysis,score:79});
  assert.match(addLeg([],line,low,'MORE',now).error??'',/below 80/);
  assert.equal(addLeg([],line,analysisSchema.parse({...analysis,score:80}),'MORE',now).error,null);
  assert.equal(CROWN_LEG_FLOOR,80);
});
