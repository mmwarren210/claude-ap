import assert from 'node:assert/strict';
import test from 'node:test';
import { boardSchema, evidenceSchema } from '@crowniq/contracts';
import { createGkrRegistry, evaluateBoard, fantasyRules, marketDefinitions,
  researchPolicies, routeResearch, scoreFantasyStats } from '../src/index.js';
import { teamSports } from './fixtures/research/team-sports.js';
import { racketAndSoccer } from './fixtures/research/racket-soccer.js';
import { esports } from './fixtures/research/esports.js';
import { seasonAndNiche } from './fixtures/research/season-niche.js';
import { at, evidenceFor, lineFor } from './fixtures/research/types.js';

const examples = [...teamSports,...racketAndSoccer,...esports,...seasonAndNiche];
const example = (id: string) => examples.find((item) => item.id === id)!;
const routed = (id: string) => {
  const item = example(id), line = lineFor(item);
  return routeResearch(line, evidenceFor(item,line), at)!;
};

test('all synthetic examples carry auditable source order, tiers, TTLs and component effects', () => {
  assert.equal(examples.length,26);
  assert.equal(new Set(examples.map((item) => item.id)).size,examples.length);
  assert.equal(new Set(researchPolicies.map((item) => `${item.sport}:${item.market}`)).size,
    researchPolicies.length);
  for (const item of examples) {
    const line = lineFor(item), route = routeResearch(line,evidenceFor(item,line),at)!;
    assert.ok(route, item.id);
    assert.deepEqual(route.sources.map((source) => source.id),item.researchPlan.sources,item.id);
    for (const [tier, kinds] of Object.entries({REQUIRED:item.researchPlan.required,
      IMPORTANT:item.researchPlan.important,OPTIONAL:item.researchPlan.optional})) {
      assert.deepEqual(route.policy.fields.filter((field) => field.tier === tier).map((field) => field.kind),
        kinds,item.id);
    }
    for (const [kind, ttl] of Object.entries(item.researchPlan.ttlHours)) {
      assert.equal(route.policy.fields.find((field) => field.kind === kind)?.ttlHours,ttl,item.id);
    }
    assert.equal(route.modelVersion,item.modelVersion,item.id);
    assert.equal(route.status,item.expectedBehavior.status,item.id);
    for (const kind of Object.keys(item.evidenceFound)) {
      assert.ok(route.evidence.some((finding) => finding.kind === kind),`${item.id}: ${kind}`);
    }
    for (const kind of item.evidenceMissing) {
      assert.ok(route.missing.includes(kind),`${item.id}: ${kind}`);
      assert.ok(!route.evidence.some((finding) => finding.kind === kind));
    }
    for (const component of Object.keys(item.componentEffects)) {
      // Fixture-specific composite fantasy effects belong to the fantasy layer, not the router.
      if (component === 'fantasy' || component === 'matchup') continue;
      assert.ok(route.policy.fields.some((field) => field.components.includes(component)) ||
        ['game_environment','environment','stability','style_matchup'].includes(component),
      `${item.id}: unmapped component ${component}`);
    }
    assert.ok(item.expectedBehavior.note.length > 20);
    assert.ok(route.sources.every((source) => source.reason.includes(route.policy.version)));
  }
});

test('fixtures never turn an unspecified metric into observed evidence', () => {
  const item=example('mlb-hitter-fantasy'), route=routed(item.id);
  assert.ok(route.missing.includes('metric:contact_quality'));
  assert.ok(route.evidence.every((finding) => Object.hasOwn(item.evidenceFound,finding.kind)));
  assert.equal(route.status,'DOWNGRADED');
  assert.equal(route.reasonCode,'IMPORTANT_EVIDENCE_MISSING');
  assert.equal(routed('darts-first-leg').status,'PASS');
  assert.equal(routed('darts-first-leg').reasonCode,'REQUIRED_EVIDENCE_MISSING');
});

test('A: official OUT overrides newer lower-priority historical active claim', () => {
  const item=example('wnba-pra'),line=lineFor(item), base=evidenceFor(item,line);
  const official=evidenceSchema.parse({...base.find((finding) => finding.kind === 'status:player_active')!,
    id:'official-out',sourceName:'WNBA_INJURY',numeric:{value:0}});
  const older=evidenceSchema.parse({...official,id:'historical-active',sourceName:'BASKETBALL_GAME_LOG',
    sourceType:'PUBLIC',retrievedAt:'2030-09-24T12:01:00Z',numeric:{value:1}});
  const route=routeResearch(line,[...base.filter((finding) => finding.kind !== 'status:player_active'),
    official,older],new Date('2030-09-24T12:02:00Z'))!;
  assert.equal(route.status,'PASS');
  assert.equal(route.reasonCode,'NEGATIVE_REQUIRED_STATUS');
  assert.equal(route.effects.find((effect) => effect.kind === 'status:player_active')?.evidenceId,'official-out');
});

test('B/C: stale line role and missing goalie confirmation cannot be presented as current', () => {
  const item=example('nhl-sog'),line=lineFor(item);
  const evidence=evidenceFor(item,line).map((finding) => finding.kind === 'status:line_confirmed'
    ? {...finding,retrievedAt:'2030-09-23T18:00:00Z'} : finding);
  const route=routeResearch(line,evidence,at)!;
  assert.equal(route.status,'PASS');
  assert.ok(route.stale.includes('status:line_confirmed'));
  assert.equal(route.effects.find((effect) => effect.kind === 'status:line_confirmed')?.state,'STALE');
  const goalie=routed('nhl-goalie-saves');
  const missing=routeResearch(lineFor(example('nhl-goalie-saves')),
    goalie.evidence.filter((finding) => finding.kind !== 'status:starting_goalie'),at)!;
  assert.equal(missing.status,'PASS');
});

test('D/E: important gaps downgrade; optional xG gap does not cause severe penalty', () => {
  assert.equal(routed('mlb-hitter-fantasy').status,'DOWNGRADED');
  const item=example('nhl-sog'),line=lineFor(item);
  const all=routeResearch(line,evidenceFor(item,line),at)!;
  const noOptional=routeResearch(line,evidenceFor(item,line).filter((finding) =>
    finding.kind !== 'metric:expected_goals'),at)!;
  assert.equal(all.status,noOptional.status);
  assert.ok(noOptional.missing.includes('metric:expected_goals'));
});

test('F/G: ITF routing fails over to ITF; absent serve metrics remain absent', () => {
  const item=example('tennis-total-games'),line=lineFor(item,{league:'ITF 100'});
  const evidence=evidenceFor(item,line).filter((finding) => finding.kind !== 'metric:serve_hold_environment');
  const route=routeResearch(line,evidence,at)!;
  assert.equal(route.sources[0].id,'ITF');
  assert.ok(!route.sources.some((source) => source.id === 'ATP_WTA'));
  assert.ok(route.missing.includes('metric:serve_hold_environment'));
  assert.ok(!route.evidence.some((finding) => finding.kind === 'metric:serve_hold_environment'));
});

test('H: AI recommendation cannot override deterministic missing-input PASS', () => {
  const item=example('cs2-kills'),line=lineFor(item);
  const ai=evidenceSchema.parse({id:'ai-opinion',entityType:'PLAYER',entityId:line.playerId,
    eventId:line.eventId,market:line.market,kind:'summary:recommendation',
    finding:'Synthetic AI summary: strong MORE',sourceName:'AI',sourceUrl:null,
    sourceType:'AI_STRUCTURED',retrievedAt:at.toISOString(),expiresAt:'2030-09-25T00:00:00Z',
    quality:'LOW',confidence:.3});
  const result=evaluateBoard(boardSchema.parse({provider:'prizepicks',fetchedAt:at.toISOString(),
    lines:[line]}),[ai],createGkrRegistry(marketDefinitions.map((model) => model.version)),at);
  assert.equal(result.analyses[0].direction,'PASS');
});

test('I/J: CS2 midpoint danger and alternate threshold are evaluated independently', () => {
  const item=example('cs2-kills'), regular=lineFor(item,{availableDirections:['MORE']});
  const goblin=lineFor(item,{id:'cs2-goblin',threshold:28.5,lineType:'GOBLIN',
    availableDirections:['MORE']});
  const demon=lineFor(item,{id:'cs2-demon',threshold:33.5,lineType:'DEMON',
    availableDirections:['MORE']});
  const module=createGkrRegistry().resolve(regular)!;
  const evidence=module.requiredEvidenceKinds.map((kind,index) => evidenceSchema.parse({
    id:`cs2-${index}`,entityType:'PLAYER',entityId:regular.playerId,eventId:regular.eventId,
    market:regular.market,kind,finding:'Synthetic test input.',sourceName:'ESPORTS_EVENT',
    sourceUrl:null,sourceType:'OFFICIAL',retrievedAt:at.toISOString(),
    expiresAt:'2030-09-25T00:00:00Z',quality:'HIGH',confidence:1,
    numeric:kind.startsWith('projection:') ? {value:31,baseline:2} :
      {value:kind.startsWith('status:') ? 1 : 1.15,baseline:1}}));
  const result=evaluateBoard(boardSchema.parse({provider:'prizepicks',fetchedAt:at.toISOString(),
    lines:[regular,goblin,demon]}),evidence,
    createGkrRegistry(marketDefinitions.map((model) => model.version)),at);
  assert.equal(result.analyses[0].dangerZone,true);
  assert.equal(result.analyses[1].direction,'MORE');
  assert.equal(result.rankedLineIds[0],goblin.id);
});

test('fantasy pathways use supplied event scoring and CS2 headshot rate is not KPR', () => {
  const expected={single:3,double:5,triple:8,home_run:10,run:2,rbi:2,
    walk:2,hit_by_pitch:2,stolen_base:5};
  assert.deepEqual(fantasyRules('MLB','batter')?.points,expected);
  assert.deepEqual(fantasyRules('KBO','batter')?.points,expected);
  assert.deepEqual(fantasyRules('KBO','pitcher')?.points,
    {win:6,quality_start:4,earned_run:-3,strikeout:3,out:1});
  assert.equal(scoreFantasyStats(fantasyRules('TENNIS','player')!,{match_played:1,
    game_won:12,game_lost:8,set_won:2,ace:3,double_fault:2}),20.5);
  assert.equal(scoreFantasyStats(fantasyRules('MLB','batter')!,
    {home_run:1,run:1,rbi:1}),14);
  assert.ok(14.5/27 > .43);
  assert.ok(routed('cs2-headshots').policy.fields.some((field) =>
    field.kind === 'metric:historical_hs_pct'));
});
