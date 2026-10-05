import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisSchema, boardResponseSchema, DEFAULT_PAYOUTS, propLineSchema } from '@crowniq/contracts';
import { crownOutcome, entryOutlook } from '../src/insights.js';
import { agreementText, aiPlay, lateNews, providerName, scoutEvidence, scoutVerdict, unbrand } from '../src/scout.js';
import { bandOf, betaNote } from '../src/beta.js';
import { buildSlip } from '../src/app-slip.js';
import { buildBookSlip, buildMarketSlip, parlayAmerican } from '../src/slip-builders.js';
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
  const scout:{pick:string;score:number|null;kind?:string}={pick:'PASS',score:null,kind:'scout'};
  const merged=withBooksPicks(new Map([['a',scout],['b',{pick:'LESS',score:66,kind:'second'}]]),
    new Map([['a',{side:'MORE' as const,fair:0.6}],['b',{side:'MORE' as const,fair:0.58}],['c',{side:'LESS' as const,fair:0.57}]]));
  assert.equal(merged.get('a'),scout,'Scout looked closer: its PASS stands');
  assert.deepEqual(merged.get('b'),{pick:'MORE',score:58,kind:'books'},'a second opinion is not a pick');
  assert.deepEqual(merged.get('c'),{pick:'LESS',score:57,kind:'books'});
  assert.equal(isPlay(undefined,merged.get('c')),true);
});

test('GKR Beta shows beside GKR only where they differ, and says why it passes',()=>{
  const read=(direction:'MORE'|'PASS',score:number|null,gkr:number,change:'UP'|'LATE_NEWS_PASS'|'SAME')=>({direction,score,
    gkr:{direction:'MORE' as const,score:gkr},change,scouted:true,shift:0,why:'Late news: benched.',modelVersion:'GKR-1.0+SCOUT-BETA-0.1'});
  assert.equal(betaNote(read('MORE',90,82,'UP')),'GKR 82 · Beta 90');
  assert.equal(betaNote(read('PASS',null,90,'LATE_NEWS_PASS')),'Beta passes: benched.');
  assert.equal(betaNote(read('MORE',86,86,'SAME')),null,'same score: only GKR shows');
  assert.equal(bandOf(90),'CROWN_STRONG');
});

test('the slip builder takes GKR strongest app lines: one per player, two per game, two teams, rotates on rebuild',()=>{
  const now=Date.parse('2030-01-01T12:00:00Z');
  const mk=(id:string,score:number,eventId:string,team:string,overrides:Record<string,unknown>={})=>({id,eventId,
    eventStartTime:'2030-01-01T20:00:00Z',playerId:`p-${id}`,team,lineType:'REGULAR',availableDirections:['MORE','LESS'] as ('MORE'|'LESS')[],
    gkr:{direction:'MORE' as const,score},...overrides});
  const lines=[mk('a',95,'g1','BUF'),mk('b',93,'g1','BUF'),mk('c',91,'g1','MIA'),mk('d',90,'g2','BUF'),mk('e',88,'g3','NYJ'),
    mk('dup',99,'g4','KC',{playerId:'p-a'}),mk('none',97,'g5','LV',{gkr:null}),mk('soon',96,'g6','SF',{eventStartTime:'2030-01-01T12:05:00Z'}),
    mk('less-only',94,'g7','DAL',{availableDirections:['LESS']})];
  assert.deepEqual(buildSlip(lines,4,now).map((pick)=>pick.line.id),['dup','b','c','d'],
    'a is the same player as dup; c joins b from g1, then g1 is full');
  const allBuf=[mk('x',95,'g1','BUF'),mk('y',94,'g2','BUF'),mk('z',90,'g3','MIA')];
  assert.deepEqual(buildSlip(allBuf,2,now).map((pick)=>pick.line.id),['x','z'],'the last pick brings a second team');
  assert.deepEqual(buildSlip(lines,2,now,2).map((pick)=>pick.line.id).sort(),['b','c'],'build another starts further down');
});

test('sportsbook and market slip builders: fair prices first, one per player or game, parlay price',()=>{
  const now=Date.parse('2030-01-01T12:00:00Z');
  const book=(id:string,player:string,score:number,american:number,pricey=false)=>({id,eventStartTime:'2030-01-01T20:00:00Z',
    playerName:player,market:'passing_yards',line:240.5,side:'MORE' as const,gkr:{score},american,pricey});
  const picks=[book('a','A',95,-180,true),book('b','B',88,-110),book('c','C',80,+105),book('d','B',90,-115)];
  assert.deepEqual(buildBookSlip(picks,2,now).map((pick)=>pick.id),['d','c'],
    'fair prices first (B once, its stronger line), then C; pricey A last');
  assert.equal(parlayAmerican([{american:-110},{american:-110}]),264);
  assert.equal(parlayAmerican([{american:-110}]),null);
  const market=(id:string,game:string,edge:number)=>({id,game,startTime:'2030-01-01T20:00:00Z',edge,side:'x',price:0.4});
  assert.deepEqual(buildMarketSlip([market('1','g1',0.03),market('2','g1',0.05),market('3','g2',0.02)],3,now).map((pick)=>pick.id),
    ['2','3'],'one per game, biggest edge first');
});

test('the app never shows an AI product name: the two models are Scout A and Scout B', () => {
  assert.deepEqual([providerName('chatgpt'), providerName('claude')], ['Scout A', 'Scout B']);
  assert.equal(unbrand('ChatGPT and Claude agree; GPT-5.4 mini saw OpenAI’s note and Claude’s source.'),
    'Scout and Scout agree; Scout saw Scout’s note and Scout’s source.');
  assert.equal(unbrand('Boston is missing Charlie McAvoy.'), 'Boston is missing Charlie McAvoy.');
  const read = { pick: 'MORE' as const, score: 60, agreement: 'BOTH' as const, researchedAt: '2030-01-01T00:00:00Z',
    providers: [{ provider: 'chatgpt' as const, pick: 'MORE', confidence: 60, summary: '', lateNews: 'Claude found he is out.',
      reasons: [{ text: 'ChatGPT read the depth chart', url: null, kind: 'role' as const }] }] };
  assert.equal(agreementText(read), 'Both scouts agree');
  assert.equal(lateNews(read), 'Scout found he is out.');
  assert.deepEqual(scoutEvidence(read)[0].items[0], { text: 'Scout read the depth chart', url: null, by: 'Scout A' });
});

test('an event name that is a feed id shows as a plain match label', async () => {
  const { matchup } = await import('../src/matchup.js');
  assert.equal(matchup({ opponent: null, eventName: 'LOL JDGSR46300.2916666667', league: 'LOL' }), 'LOL match');
  assert.equal(matchup({ opponent: null, eventName: 'NAVI vs FaZe', league: 'CS2' }), 'NAVI vs FaZe');
  assert.equal(matchup({ opponent: 'Carlos Alcaraz', eventName: 'x', league: 'TENNIS' }), 'vs Carlos Alcaraz');
});

test('GKR 80 and up is good enough for a Crown leg at every size (owner, 2026-10-05)', async () => {
  const { crownMinimumLineScore } = await import('../src/insights.js');
  assert.deepEqual(Object.values(crownMinimumLineScore), [80, 80, 80, 80, 80]);
});
