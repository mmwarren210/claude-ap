import assert from 'node:assert/strict';
import test from 'node:test';
import type { Evidence, PropLine } from '@crowniq/contracts';
import { boardSchema, evidenceSchema } from '@crowniq/contracts';
import { auditCrown, buildAutoCrown, createGkrRegistry, evaluateBoard, fantasyDistribution,
  fantasyRules, marketDefinitions, prizepicksFantasyRegistryV1, reviewManualCrown,
  scoreBand, scoreFantasyStats, snapshotSelection, statHistoryReadyVersions, statHistoryV2Versions, lessAwareDefinition, lessAwareVersion,
  flipsForLess, reliabilityFactors } from '../src/index.js';
import { fixtureAnalysis, fixtureLine, now } from './fixtures.js';

// Every player, number, scenario, and outcome here is a fabricated test fixture.
function finding(line: PropLine, kind: string, value?: number, baseline?: number): Evidence {
  return evidenceSchema.parse({ id: `${line.id}:${kind}`, entityType: 'PLAYER',
    entityId: line.playerId, eventId: line.eventId, market: line.market, kind,
    finding: 'Synthetic test input.', sourceName: 'Synthetic official fixture',
    sourceUrl: null, sourceType: 'OFFICIAL', retrievedAt: now.toISOString(),
    expiresAt: '2030-09-24T15:00:00.000Z', quality: 'HIGH', confidence: 1,
    ...(value === undefined ? {} : { numeric: { value, ...(baseline === undefined ? {} : { baseline }) } }),
  });
}

function inputs(line: PropLine, factorRatio = 1.12, midpoint = 300, sd = 20): Evidence[] {
  const module = createGkrRegistry().resolve(line)!;
  return module.requiredEvidenceKinds.map((kind) => kind.startsWith('metric:')
    ? finding(line, kind, factorRatio, 1)
    : kind.startsWith('projection:') ? finding(line, kind, midpoint, sd)
      : finding(line, kind, 1));
}

function run(lines: PropLine[], evidence: Evidence[]) {
  return evaluateBoard(boardSchema.parse({ provider: 'prizepicks', fetchedAt: now.toISOString(), lines }),
    evidence, createGkrRegistry(marketDefinitions.map((item) => item.version)), now);
}

test('109 versioned market definitions have auditable weights and never score missing live inputs', () => {
  const registry = createGkrRegistry();
  assert.equal(marketDefinitions.length, 109);
  for (const definition of marketDefinitions) {
    assert.equal(definition.factors.reduce((sum, [, weight]) => sum + weight, 0), 100);
    assert.equal(registry.resolve({ sport: definition.sport, market: definition.market })?.version,
      definition.version);
  }
  const line = fixtureLine();
  const analysis = run([line], []).analyses[0];
  assert.equal(analysis.direction, 'PASS');
  assert.equal(analysis.reasonCode, 'STALE_OR_MISSING_EVIDENCE');
  assert.equal(analysis.modelVersion, 'GKR-NFL-PASSING-YARDS-1.2');
  assert.equal(evaluateBoard(boardSchema.parse({provider:'prizepicks',fetchedAt:now.toISOString(),
    lines:[line]}), inputs(line), registry, now).analyses[0].reasonCode,
  'MODEL_CALIBRATION_UNAPPROVED');
});

test('stat-history preset expands model-ready coverage without removing hard status gates',()=>{
  assert.equal(statHistoryReadyVersions.length,20);
  assert.equal(new Set(statHistoryReadyVersions).size,20);
  const ready=marketDefinitions.filter((definition)=>statHistoryReadyVersions.includes(definition.version));
  assert.deepEqual([...new Set(ready.map((definition)=>definition.sport))].sort(),['MLB','NBA','NFL']);
  assert.ok(ready.every((definition)=>definition.partialCoverageNormalization===true));
  const requirements=createGkrRegistry(statHistoryReadyVersions).requirements();
  assert.equal(Object.values(requirements).filter((item)=>item.approved).length,20);

  const nba=fixtureLine({sport:'NBA',market:'player_points_rebounds_assists',
    threshold:30,availableDirections:['MORE']});
  const nbaEvidence=inputs(nba,1.2,42,5).filter((item)=>item.kind!=='status:player_available');
  assert.equal(run([nba],nbaEvidence).analyses[0].reasonCode,'STALE_OR_MISSING_EVIDENCE');

  const mlb=fixtureLine({sport:'MLB',market:'pitcher_strikeouts',
    threshold:5.5,availableDirections:['MORE']});
  const mlbEvidence=inputs(mlb,1.2,8,1.5).filter((item)=>item.kind!=='status:starting_pitcher');
  assert.equal(run([mlb],mlbEvidence).analyses[0].reasonCode,'STALE_OR_MISSING_EVIDENCE');
});

test('stat-history set 2 is opt-in, keeps every hard status gate, and scores only with them', () => {
  assert.equal(statHistoryV2Versions.length, 46, '36 stats, 10 under a second key');
  assert.ok(statHistoryV2Versions.every((version) => /-SH2-\d+\.\d+$/.test(version)));
  assert.ok(!statHistoryV2Versions.some((version) => statHistoryReadyVersions.includes(version)), 'not in the v1 preset');
  const set2 = marketDefinitions.filter((definition) => statHistoryV2Versions.includes(definition.version));
  assert.ok(set2.every((definition) => (definition.hardCriticalKinds ?? []).length > 0));
  assert.equal(createGkrRegistry().requirements()['MLB:batter_total_bases'].approved, false, 'off unless approved');
  const tb = fixtureLine({ sport: 'MLB', market: 'batter_total_bases', threshold: 1.5, availableDirections: ['MORE', 'LESS'] });
  const withoutLineup = inputs(tb, 1.2, 2.4, 0.8).filter((item) => item.kind !== 'status:starting_lineup');
  assert.equal(run([tb], withoutLineup).analyses[0].reasonCode, 'STALE_OR_MISSING_EVIDENCE');
  const scored = run([tb], inputs(tb, 1.2, 2.4, 0.8)).analyses[0];
  assert.equal(scored.modelVersion, 'GKR-MLB-BATTER-TOTAL-BASES-SH2-1.0');
  assert.notEqual(scored.reasonCode, 'STALE_OR_MISSING_EVIDENCE');
  assert.notEqual(scored.reasonCode, 'MODEL_CALIBRATION_UNAPPROVED');
});

test('approved modules can score sufficiently covered attributed factors without fabricating missing ones', () => {
  const line=fixtureLine({threshold:240,availableDirections:['MORE']});
  const all=inputs(line,1.2,310,20);
  const keep=new Set(['metric:expected_attempts','metric:efficiency_environment',
    'metric:historical_current_form','metric:stability']);
  const partial=all.filter((item)=>!item.kind.startsWith('metric:')||keep.has(item.kind));
  const analysis=run([line],partial).analyses[0];
  assert.equal(analysis.direction,'MORE');
  assert.ok(analysis.contextBreakdown?.filter((item)=>item.contribution===0)
    .some((item)=>item.name==='protection_pressure'));
  assert.ok(analysis.ruleChecks.some((item)=>item.startsWith('MODEL_INPUT_COVERAGE_60')));
  assert.equal(analysis.dataConfidence,60);
  assert.equal(analysis.contextScore,90);
  assert.ok(analysis.contextBreakdown?.some((item)=>item.name==='partial_coverage_adjustment'));
  const below=partial.filter((item)=>item.kind!=='metric:stability');
  const belowAnalysis=run([line],below).analyses[0];
  assert.equal(belowAnalysis.reasonCode,'INSUFFICIENT_MODEL_COVERAGE');
  assert.equal(belowAnalysis.dataConfidence,55);
});

test('score bands are rank labels, and the newest attributed role observation takes precedence', () => {
  assert.deepEqual([67,68,74,80,86,92].map(scoreBand),
    ['PASS','WEAK','LEAN','PLAYABLE','CROWN_STRONG','CROWN_ELITE']);
  const line=fixtureLine({threshold:250,availableDirections:['MORE']});
  const base=inputs(line,1.13,310,20).map((item) =>
    item.kind === 'metric:expected_attempts'
      ? {...item,retrievedAt:'2030-09-24T11:00:00.000Z'} : item);
  const original=run([line],base).analyses[0].contextScore!;
  const older={...finding(line,'metric:expected_attempts',2,1),
    id:'old-role',retrievedAt:'2030-09-24T10:00:00.000Z'};
  const current={...finding(line,'metric:expected_attempts',.8,1),id:'current-role'};
  const revised=run([line],[...base,older,current]).analyses[0].contextScore!;
  assert.ok(revised < original);
});

test('separate context and exact-line scores add up, clamp, and rank only the best threshold', () => {
  const regular = fixtureLine({ threshold: 302.5, availableDirections: ['MORE'] });
  const goblin = fixtureLine({ id: 'goblin', sourceLineId: 'fixture-goblin',
    lineType: 'GOBLIN', threshold: 270.5, availableDirections: ['MORE'] });
  const result = run([regular, goblin], inputs(regular, 1.14, 310, 20));
  assert.equal(result.analyses.length, 2);
  assert.equal(result.analyses[0].direction, 'PASS');
  assert.equal(result.analyses[0].reasonCode, 'DANGER_ZONE_NO_EDGE');
  const strong = result.analyses[1];
  assert.equal(strong.direction, 'MORE');
  assert.equal(strong.assessments.length, 3);
  assert.equal(strong.contextScore, strong.contextBreakdown?.reduce((sum, c) => sum + c.contribution, 0));
  assert.equal(strong.score, strong.scoreBreakdown.reduce((sum, c) => sum + c.contribution, 0));
  assert.ok(strong.score! > 80);
  assert.equal(strong.modelVersion, 'GKR-NFL-PASSING-YARDS-1.2');
  assert.deepEqual(result.rankedLineIds, [goblin.id]);
  const extreme = run([fixtureLine({ threshold: 200 })], inputs(regular, 2, 400, 10)).analyses[0];
  assert.equal(extreme.score, 100);
  assert.ok(extreme.lineAdjustments?.some((item) => item.name === 'score_clamp'));
});

test('Demon tax penalizes exact line without a Goblin label bonus', () => {
  const base = fixtureLine({ threshold: 280, availableDirections: ['MORE'] });
  const demon = fixtureLine({ id: 'demon', lineType: 'DEMON', threshold: 285,
    availableDirections: ['MORE'] });
  const goblin = fixtureLine({ id: 'goblin', lineType: 'GOBLIN', threshold: 270,
    availableDirections: ['MORE'] });
  const assessments = run([base, demon, goblin], inputs(base, 1.13, 310, 20)).analyses;
  assert.ok(assessments[1].lineAdjustments!.find((item) => item.name === 'demon_tax')!.contribution <= -3);
  assert.equal(assessments[2].lineAdjustments!.find((item) => item.name === 'demon_tax')!.contribution, 0);
  assert.ok(assessments[2].score! > assessments[0].score!);
});

test('rank uses exact Line Score before player Context Score', () => {
  const a = fixtureLine({id:'fixture-a',playerId:'a',threshold:298,availableDirections:['MORE']});
  const b = fixtureLine({id:'fixture-b',playerId:'b',threshold:240,availableDirections:['MORE']});
  const results = run([a,b],[...inputs(a,1.2,300,20),...inputs(b,1.14,300,20)]);
  assert.ok(results.analyses[0].contextScore! > results.analyses[1].contextScore!);
  assert.ok(results.analyses[0].score! < results.analyses[1].score!);
  assert.deepEqual(results.rankedLineIds,[b.id,a.id]);
});

test('LESS ladder escalates to a higher playable threshold after a Regular PASS', () => {
  const low = fixtureLine({id:'regular-less',threshold:283,availableDirections:['LESS']});
  const higher = fixtureLine({id:'alternate-less',threshold:345,lineType:'GOBLIN',
    availableDirections:['LESS']});
  const result = run([low,higher], inputs(low,1.14,280,20));
  assert.equal(result.analyses[0].direction,'PASS');
  assert.equal(result.analyses[1].direction,'LESS');
  assert.deepEqual(result.rankedLineIds,[higher.id]);
});

test('adversarial injury and stale critical status produce PASS, and unavailable LESS is never forced', () => {
  const line = fixtureLine({ threshold: 300, availableDirections: ['MORE'] });
  const evidence = inputs(line, 1.15, 270, 12);
  assert.equal(run([line], evidence).analyses[0].reasonCode, 'DIRECTION_UNAVAILABLE');
  const more = fixtureLine({ availableDirections: ['MORE'], threshold: 240 });
  const injured = run([more], [...inputs(more, 1.15, 310, 20), finding(more, 'risk:injury', .9)]).analyses[0];
  assert.equal(injured.assessments.length, 3);
  assert.equal(injured.assessments[0].direction, 'MORE');
  assert.equal(injured.assessments[1].direction, 'PASS');
  assert.equal(injured.reasonCode, 'CRITICAL_UNCERTAINTY');
  const old = inputs(more).map((item) => item.kind === 'status:qb_available'
    ? { ...item, retrievedAt: '2030-09-23T22:00:00.000Z' } : item);
  assert.equal(run([more], old).analyses[0].reasonCode, 'STALE_OR_MISSING_EVIDENCE');
});

test('unsupported, anonymous and AI-only numeric evidence cannot create selections', () => {
  assert.equal(run([fixtureLine({ market: 'missing_market' })], []).analyses[0].reasonCode,
    'MODEL_SUPPORT_INCOMPLETE');
  const line = fixtureLine();
  const aiOnly = inputs(line).map((item) => ({ ...item, sourceType: 'AI_STRUCTURED' as const }));
  assert.equal(run([line], aiOnly).analyses[0].reasonCode, 'CRITICAL_STATUS_UNCONFIRMED');
});

test('fantasy registry scores named statistics across every requested family', () => {
  assert.equal(prizepicksFantasyRegistryV1.length, 19);
  const check = (sport: string, role: string, stats: Record<string, number>, total: number) => {
    const rule = fantasyRules(sport, role)!;
    assert.equal(rule.version, 'prizepicks_fantasy_registry_v1');
    assert.equal(scoreFantasyStats(rule, stats), total);
  };
  check('NFL','offense',{ passing_yards:100, passing_td:1, interception:1 },7);
  check('NCAAFB','kicker',{ fg_50_plus:1, pat_made:2, missed_pat:1 },6);
  check('MLB','batter',{ home_run:1, run:1, rbi:1 },14);
  check('KBO','batter',{ single:1, stolen_base:1 },8);
  check('NPB','pitcher',{ win:1, quality_start:1, earned_run:2, strikeout:5, out:18 },37);
  check('NBA','player',{ point:10, rebound:2, assist:3 },16.9);
  check('WNBA','player',{ point:1, block:1, steal:1 },7);
  check('BIG3','player',{ point:2, turnover:1 },1);
  check('TENNIS','player',{ match_played:1, game_won:12, game_lost:10, set_won:2,
    set_lost:1, ace:4, double_fault:1 },16.5);
  check('MMA','fighter',{ significant_strike:10, takedown:1, round_2_win:1 },50);
  check('SOCCER','outfield',{ goal:1, assist:1, yellow_card:1 },14);
  check('SOCCER','goalkeeper',{ starting_score:1, save:5, goal_conceded:2 },11);
  check('NHL','skater',{ goal:1, assist:1, shot_on_goal:3 },13);
  check('NHL','goalie',{ win:1, save:10, goal_against:2 },6);
  assert.throws(() => scoreFantasyStats(fantasyRules('MLB','batter')!, { invented_stat:1 }));
});

test('joint fantasy scenarios retain correlated home-run consequences', () => {
  const batter = fantasyRules('MLB','batter')!;
  const distribution = fantasyDistribution(batter, [
    { probability:.5, stats:{ home_run:1, run:1, rbi:1 } },
    { probability:.5, stats:{ walk:1 } },
  ]);
  assert.deepEqual(distribution.outcomes.map((item) => item.points), [14,2]);
  assert.equal(distribution.midpoint, 8);
  assert.equal(distribution.standardDeviation, 6);
  assert.throws(() => fantasyDistribution(batter, [{probability:.7,stats:{walk:1}}]));
});

test('fantasy market uses supplied joint scenarios and passes without them', () => {
  const line = fixtureLine({id:'fixture-fantasy',sport:'MLB',market:'batter_fantasy_score',
    threshold:10,availableDirections:['MORE']});
  const evidence = inputs(line,1.2);
  assert.equal(run([line],evidence).analyses[0].reasonCode,'MISSING_DISTRIBUTION');
  const joint = evidence.map((item) => item.kind === 'fantasy_scenarios'
    ? { ...item,scenarios:[{probability:.5,stats:{home_run:1,run:1,rbi:1}},
      {probability:.5,stats:{home_run:1,run:2,rbi:2}}] } : item);
  assert.equal(run([line],joint).analyses[0].direction,'MORE');
});

test('walks 0.5 needs at-least-one probability, and inflated CS2 headshots can favor LESS', () => {
  const walk = fixtureLine({sport:'MLB',market:'batter_walks',threshold:.5,
    availableDirections:['MORE']});
  const walkEvidence=inputs(walk,1.2,1.3,.3);
  assert.equal(run([walk],walkEvidence).analyses[0].reasonCode,'MISSING_WALK_PROBABILITY');
  assert.equal(run([walk],[...walkEvidence,finding(walk,'metric:walk_probability',.8)]).analyses[0]
    .direction,'MORE');

  const hs=fixtureLine({sport:'CS2',market:'headshots',threshold:20,availableDirections:['LESS']});
  const e=inputs(hs,1.2,14,3).map((item) => item.kind === 'metric:expected_kills'
    ? {...item,numeric:{value:30,baseline:25}} : item.kind === 'metric:historical_hs_pct'
      ? {...item,numeric:{value:.4,baseline:.3}} : item);
  assert.equal(run([hs],e).analyses[0].direction,'LESS');
  const overOnly={...hs,availableDirections:['MORE' as const]};
  assert.equal(run([overOnly],e).analyses[0].reasonCode,'DIRECTION_UNAVAILABLE');
});

test('market-specific status gates block rushing script, unconfirmed goalie and tournament round', () => {
  const rb=fixtureLine({sport:'NFL',market:'player_rush_yds',threshold:80,
    availableDirections:['MORE']});
  const rbEvidence=inputs(rb,1.2,120,10).map((item) => item.kind === 'metric:game_script'
    ? {...item,numeric:{value:.8,baseline:1}} : item);
  assert.equal(run([rb],rbEvidence).analyses[0].reasonCode,'RUSH_SCRIPT_UNSUPPORTED');

  const goalie=fixtureLine({sport:'NHL',market:'saves',threshold:25,
    availableDirections:['MORE']});
  const goalieEvidence=inputs(goalie,1.2,33,4).map((item) =>
    item.kind === 'status:starting_goalie' ? {...item,numeric:{value:0}} : item);
  assert.equal(run([goalie],goalieEvidence).analyses[0].reasonCode,
    'CRITICAL_STATUS_UNCONFIRMED');

  const badminton=fixtureLine({sport:'BADMINTON',market:'game_point_totals',
    threshold:74,availableDirections:['MORE']});
  const missingRound=inputs(badminton,1.2,90,5).filter((item) =>
    item.kind !== 'status:tournament_round');
  assert.equal(run([badminton],missingRound).analyses[0].reasonCode,
    'STALE_OR_MISSING_EVIDENCE');
});

test('Crown thresholds, same-player and same-team constraints, and reserve promotion', () => {
  const lines = Array.from({length: 10}, (_, index) => fixtureLine({ id:`candidate-${index}`,
    playerId:`player-${index}`, team:index <= 2 ? 'TEAM_A' : `TEAM_${index}` }));
  const candidates = lines.map((line, index) => ({line,
    analysis:fixtureAnalysis(line, 'MORE', index === 2 ? 79 : 90)}));
  const crown = buildAutoCrown(candidates, 6, () => []);
  assert.equal(crown.picks?.length, 6);
  assert.ok(crown.picks?.every((pick) => pick.analysis.score! >= 80));
  assert.ok(!crown.picks?.some((pick) => pick.line.id === 'candidate-2'));
  assert.ok(crown.picks?.some((pick) => pick.line.id === 'candidate-6'));
  const short = buildAutoCrown(candidates.slice(0, 4), 6, () => []);
  assert.equal(short.picks?.length, 3);
  assert.ok(short.issues.includes('INSUFFICIENT_QUALIFIED_PICKS'));
  assert.ok(auditCrown(candidates.slice(0, 3), 3, () => []).includes('SAME_TEAM_CONCENTRATION'));
  assert.ok(auditCrown([candidates[0], {...candidates[1],line:{...lines[1],playerId:lines[0].playerId}}],
    2, () => []).includes('DUPLICATE_PLAYER'));
  const review=reviewManualCrown([candidates[0],candidates[2]],2,()=>[]);
  assert.deepEqual(review.picks,[candidates[0],candidates[2]]);
  assert.equal(review.strongest?.line.id,'candidate-0');
  assert.equal(review.weakest?.line.id,'candidate-2');
  assert.ok(review.issues.includes('BELOW_CROWN_MINIMUM'));
  const expired={...candidates[0],analysis:{...candidates[0].analysis,
    evidenceExpiresAt:'2030-09-24T11:00:00.000Z'}};
  assert.ok(auditCrown([expired,candidates[1]],2,()=>[],now).includes('STALE_MODEL_EVIDENCE'));
  assert.ok(auditCrown([{...candidates[0],line:{...lines[0],team:null}},candidates[1]],
    2,()=>[]).includes('TEAM_IDENTITY_UNAVAILABLE'));
});

test('saved selection retains the exact line, context, score, evidence, and immutable model version', () => {
  const line=fixtureLine({threshold:240,availableDirections:['MORE']});
  const e=inputs(line,1.2,310,20);
  const analysis=run([line],e).analyses[0];
  const saved=snapshotSelection(line,analysis,e,now);
  assert.equal(saved.line.threshold,240);
  assert.equal(saved.direction,'MORE');
  assert.equal(saved.contextScore,analysis.contextScore);
  assert.equal(saved.dataConfidence,analysis.dataConfidence);
  assert.equal(saved.score,analysis.score);
  assert.equal(saved.modelVersion,'GKR-NFL-PASSING-YARDS-1.2');
  assert.equal(saved.evidenceSnapshot.length,e.length);
  assert.equal(saved.grade,'PENDING');
  assert.throws(() => snapshotSelection(line,{...analysis,direction:'PASS'},e,now));
});

test('web findings are display-only: score, quality and expiry ignore them', () => {
  const line = fixtureLine();
  const evidence = inputs(line);
  const web = evidenceSchema.parse({ id: 'web:fixture', entityType: 'PLAYER', entityId: line.playerId,
    eventId: line.eventId, market: null, kind: 'web:injury', finding: 'Synthetic web claim.',
    sourceName: 'example.org', sourceUrl: 'https://example.org/fixture', sourceType: 'AI_STRUCTURED',
    retrievedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 45 * 60_000).toISOString(),
    quality: 'LOW', confidence: 0.5 });
  const without = run([line], evidence).analyses[0];
  const withWeb = run([line], [...evidence, web]).analyses[0];
  assert.notEqual(without.score, null);
  assert.equal(withWeb.score, without.score);
  assert.equal(withWeb.scoreBand, without.scoreBand);
  assert.equal(withWeb.evidenceQuality, without.evidenceQuality);
  assert.equal(withWeb.evidenceExpiresAt, without.evidenceExpiresAt);
  assert.deepEqual(withWeb.evidenceIds, without.evidenceIds);
  assert.deepEqual(withWeb.contextEvidenceIds, ['web:fixture']);
  assert.equal(without.contextEvidenceIds, undefined);
});

const lessLine = (overrides: Partial<PropLine> = {}) => fixtureLine({ threshold: 300, availableDirections: ['MORE', 'LESS'], ...overrides });
// Output factors move with `ratio`; the stability factor (a reliability read) is held steady.
function trend(line: PropLine, ratio: number, midpoint: number) {
  return inputs(line, ratio, midpoint, 20).map((item) => item.kind === 'metric:stability'
    ? finding(line, 'metric:stability', 1.12, 1) : item);
}
function scoreWith(versions: readonly string[], line: PropLine, evidence: Evidence[]) {
  return evaluateBoard(boardSchema.parse({ provider: 'prizepicks', fetchedAt: now.toISOString(), lines: [line] }),
    evidence, createGkrRegistry(versions), now).analyses[0];
}

test('LESS-aware models are separate versions that run only when approved by exact id', () => {
  const current = new Set(marketDefinitions.map((item) => item.version));
  for (const definition of marketDefinitions) {
    const revised = lessAwareDefinition(definition);
    assert.equal(current.has(revised.version), false, revised.version);
    assert.equal(revised.lessAware, true);
    assert.deepEqual([revised.sport, revised.market, revised.factors], [definition.sport, definition.market, definition.factors]);
  }
  assert.equal(lessAwareVersion('GKR-NBA-PLAYER-POINTS-1.3'), 'GKR-NBA-PLAYER-POINTS-1.4');
  assert.equal(lessAwareVersion('GKR-NFL-PASSING-YARDS-1.9'), 'GKR-NFL-PASSING-YARDS-1.10');
  const line = lessLine();
  assert.equal(createGkrRegistry().resolve(line)?.version, 'GKR-NFL-PASSING-YARDS-1.2');
  assert.equal(createGkrRegistry(['GKR-NFL-PASSING-YARDS-1.2']).resolve(line)?.version, 'GKR-NFL-PASSING-YARDS-1.2');
  assert.equal(createGkrRegistry(['GKR-NFL-PASSING-YARDS-1.3']).resolve(line)?.version, 'GKR-NFL-PASSING-YARDS-1.3');
  assert.equal(createGkrRegistry(['GKR-NFL-PASSING-YARDS-1.2', 'GKR-NFL-PASSING-YARDS-1.3']).resolve(line)?.version,
    'GKR-NFL-PASSING-YARDS-1.3');
  // The stat-history preset keeps approving today's versions.
  assert.equal(statHistoryReadyVersions.some((version) => version.endsWith('PASSING-YARDS-1.3')), false);
  assert.deepEqual([...reliabilityFactors].every((key) => !flipsForLess(key)), true);
  assert.equal(flipsForLess('expected_attempts'), true);
});

test('LESS-aware scoring mirrors MORE, and a rising player hurts a LESS pick', () => {
  const lessAware = ['GKR-NFL-PASSING-YARDS-1.3'];
  const line = lessLine();
  const moreRising = scoreWith(lessAware, line, trend(line, 1.12, 320));
  const lessFalling = scoreWith(lessAware, line, trend(line, 0.88, 280));
  const lessRising = scoreWith(lessAware, line, trend(line, 1.12, 280));
  assert.equal(moreRising.direction, 'MORE');
  assert.equal(lessFalling.direction, 'LESS');
  assert.deepEqual(lessFalling.contextBreakdown?.map((item) => [item.name, item.contribution]),
    moreRising.contextBreakdown?.map((item) => [item.name, item.contribution]));
  assert.equal(lessFalling.contextScore, moreRising.contextScore);
  assert.equal(lessFalling.score, moreRising.score);
  assert.ok(lessRising.contextScore! < lessFalling.contextScore!);
  assert.match(lessFalling.contextBreakdown!.find((item) => item.name === 'expected_attempts')!.explanation,
    /below reference favors LESS/);
});

test('current model versions keep scoring LESS exactly as before', () => {
  // Golden values captured before LESS-aware scoring existed: today's model reads a falling
  // player as weak context, so this LESS line passes. Only an approved 1.3 changes that.
  const line = lessLine();
  const legacy = scoreWith(['GKR-NFL-PASSING-YARDS-1.2'], line, trend(line, 0.88, 280));
  assert.equal(legacy.modelVersion, 'GKR-NFL-PASSING-YARDS-1.2');
  assert.deepEqual([legacy.direction, legacy.contextScore, legacy.score], ['PASS', 28.4, null]);
  const revised = scoreWith(['GKR-NFL-PASSING-YARDS-1.3'], line, trend(line, 0.88, 280));
  assert.equal(revised.direction, 'LESS');
});

test('score components carry structured fields that match their numbers', () => {
  const line = lessLine();
  const analysis = scoreWith(['GKR-NFL-PASSING-YARDS-1.2'], line, trend(line, 1.12, 320));
  assert.equal(analysis.direction, 'MORE');
  for (const component of analysis.contextBreakdown ?? []) {
    assert.ok(component.kind, component.name);
    if (component.kind === 'FACTOR' && component.measured) {
      assert.match(component.explanation, new RegExp(`Observed ${component.observed} versus reference ${component.reference}; weight ${component.weight}`));
    }
  }
  assert.ok((analysis.lineAdjustments ?? []).every((item) => item.kind === 'LINE_ADJUSTMENT' || item.kind === 'CLAMP'));
  const total = [...analysis.contextBreakdown ?? [], ...analysis.lineAdjustments ?? []].reduce((sum, item) => sum + item.contribution, 0);
  assert.equal(Math.round(total * 100) / 100, analysis.score);
});
