import assert from 'node:assert/strict';
import test from 'node:test';
import type { Evidence } from '@crowniq/contracts';
import { boardSchema, evidenceSchema } from '@crowniq/contracts';
import { auditCrown, buildAutoCrown, chooseSecondLookWatchlist, collectResearch, evaluateBoard,
  ModelRegistry } from '../src/index.js';
import type { ModelModule } from '../src/index.js';
import { fixtureAnalysis, fixtureAssessment, fixtureLine, now } from './fixtures.js';

function registryWith(assess: ModelModule['assess'], requiredEvidenceKinds: string[] = []): ModelRegistry {
  const registry = new ModelRegistry();
  registry.register({ sport: 'NFL', market: 'passing_yards', version: 'nfl-passing-v1',
    requiredEvidenceKinds, assess });
  return registry;
}

function board(lines: ReturnType<typeof fixtureLine>[]) {
  return boardSchema.parse({ provider: 'prizepicks', fetchedAt: now.toISOString(), lines });
}

test('scores use explicit components and each serious candidate gets all three passes', () => {
  const phases: string[] = [];
  const model = registryWith(({ phase }) => {
    phases.push(phase);
    const result = fixtureAssessment(phase, 'MORE');
    return { ...result, scoreComponents: [
      { name: 'opportunity', contribution: 60, explanation: 'Synthetic test input.' },
      { name: 'risk_penalty', contribution: -13, explanation: 'Synthetic test penalty.' },
    ] };
  });
  const result = evaluateBoard(board([fixtureLine()]), [], model, now);
  assert.deepEqual(phases, ['INITIAL', 'ADVERSARIAL', 'FINAL']);
  assert.equal(result.analyses[0].score, 47);
  assert.equal(result.analyses[0].scoreBreakdown.length, 2);
  assert.equal(result.analyses[0].modelVersion, 'nfl-passing-v1');
});

test('primary rankings exclude LEAN and WEAK while keeping their analyses', () => {
  const weak = fixtureLine({ id: 'weak-line', sourceLineId: 'weak-source', playerId: 'weak-player' });
  const lean = fixtureLine({ id: 'lean-line', sourceLineId: 'lean-source', playerId: 'lean-player' });
  const playable = fixtureLine({ id: 'playable-line', sourceLineId: 'playable-source', playerId: 'playable-player' });
  const model = registryWith(({ phase, line }) => fixtureAssessment(phase, 'MORE',
    line.id === 'weak-line' ? 70 : line.id === 'lean-line' ? 76 : 82));
  const result = evaluateBoard(board([weak, lean, playable]), [], model, now);
  assert.deepEqual(result.analyses.map((item) => item.scoreBand), ['WEAK', 'LEAN', 'PLAYABLE']);
  assert.deepEqual(result.rankedLineIds, [playable.id]);
});

test('Second Look watchlist keeps only audited LEAN/WEAK and deduplicates each player', () => {
  const aRegular=fixtureLine({id:'a-regular',sourceLineId:'a-regular',playerId:'player-a',threshold:240.5});
  const aGoblin=fixtureLine({id:'a-goblin',sourceLineId:'a-goblin',playerId:'player-a',
    threshold:220.5,lineType:'GOBLIN'});
  const b=fixtureLine({id:'b',sourceLineId:'b',playerId:'player-b'});
  const primary=fixtureLine({id:'primary',sourceLineId:'primary',playerId:'player-c'});
  const standard=fixtureLine({id:'standard',sourceLineId:'standard',playerId:'player-d'});
  const audit={initialReasonCode:'STALE_OR_MISSING_EVIDENCE',initialDataConfidence:40,
    evidenceAdded:1,performedAt:now.toISOString()};
  const analyses=[
    {...fixtureAnalysis(aRegular,'MORE',75),scoreBand:'LEAN' as const,
      reviewStatus:'SECOND_LOOK' as const,secondLook:audit},
    {...fixtureAnalysis(aGoblin,'MORE',78),scoreBand:'LEAN' as const,
      reviewStatus:'SECOND_LOOK' as const,secondLook:audit},
    {...fixtureAnalysis(b,'LESS',70),scoreBand:'WEAK' as const,
      reviewStatus:'SECOND_LOOK' as const,secondLook:audit},
    {...fixtureAnalysis(primary,'MORE',82),scoreBand:'PLAYABLE' as const,
      reviewStatus:'SECOND_LOOK' as const,secondLook:audit},
    {...fixtureAnalysis(standard,'MORE',77),scoreBand:'LEAN' as const,
      reviewStatus:'STANDARD' as const},
  ];
  assert.deepEqual(chooseSecondLookWatchlist([aRegular,aGoblin,b,primary,standard],analyses),
    ['a-goblin','b']);
});

test('MORE ladder evaluates every threshold and chooses the stronger lower line', () => {
  const regular = fixtureLine();
  const goblin = fixtureLine({ id: 'test-line-2', sourceLineId: 'fixture-2', threshold: 220.5, lineType: 'GOBLIN' });
  const model = registryWith(({ phase, line }) => fixtureAssessment(phase, line.threshold < 230 ? 'MORE' : 'PASS', 82));
  const result = evaluateBoard(board([regular, goblin]), [], model, now);
  assert.equal(result.analyses.length, 2);
  assert.equal(result.analyses[0].direction, 'PASS');
  assert.deepEqual(result.rankedLineIds, [goblin.id]);
});

test('LESS ladder chooses the higher line on equal model value', () => {
  const regular = fixtureLine();
  const demon = fixtureLine({ id: 'test-line-3', sourceLineId: 'fixture-3', threshold: 260.5, lineType: 'DEMON' });
  const model = registryWith(({ phase }) => fixtureAssessment(phase, 'LESS', 82));
  const result = evaluateBoard(board([regular, demon]), [], model, now);
  assert.equal(result.analyses.length, 2);
  assert.deepEqual(result.rankedLineIds, [demon.id]);
});

test('adversarial final PASS is honored, and unavailable directions cannot be forced', () => {
  const model = registryWith(({ phase }) => fixtureAssessment(phase, phase === 'FINAL' ? 'PASS' : 'LESS'));
  const result = evaluateBoard(board([fixtureLine()]), [], model, now);
  assert.equal(result.analyses[0].direction, 'PASS');
  assert.equal(result.analyses[0].assessments.length, 3);
  assert.deepEqual(result.rankedLineIds, []);
  const wrongDirection = registryWith(({ phase }) => fixtureAssessment(phase, 'LESS'));
  const unavailable = evaluateBoard(board([fixtureLine({ availableDirections: ['MORE'] })]), [], wrongDirection, now);
  assert.equal(unavailable.analyses[0].reasonCode, 'DIRECTION_UNAVAILABLE');
});

test('stale evidence causes PASS; a current matching finding enables evaluation', () => {
  const line = fixtureLine();
  const model = registryWith(({ phase }) => fixtureAssessment(phase, 'MORE'), ['injury_status']);
  const evidence: Evidence = evidenceSchema.parse({ id: 'finding-1', entityType: 'PLAYER',
    entityId: line.playerId, eventId: line.eventId, market: line.market, kind: 'injury_status',
    finding: 'Available for the test game.', sourceName: 'Fixture feed', sourceUrl: null,
    sourceType: 'OFFICIAL', retrievedAt: '2030-09-24T10:00:00.000Z',
    expiresAt: '2030-09-24T11:00:00.000Z', quality: 'HIGH', confidence: 0.9 });
  assert.equal(evaluateBoard(board([line]), [evidence], model, now).analyses[0].reasonCode,
    'STALE_OR_MISSING_EVIDENCE');
  const fresh = { ...evidence, expiresAt: '2030-09-24T13:00:00.000Z' };
  assert.equal(evaluateBoard(board([line]), [fresh], model, now).analyses[0].evidenceQuality, 'HIGH');
});

test('unsupported markets and model exceptions PASS without removing other board lines', () => {
  const unsupported = fixtureLine({ id: 'unsupported', market: 'unknown_market' });
  const faulty = registryWith(() => { throw new Error('Fixture model failure'); });
  const result = evaluateBoard(board([unsupported, fixtureLine()]), [], faulty, now);
  assert.equal(result.analyses.length, 2);
  assert.deepEqual(result.analyses.map((a) => a.reasonCode), ['MODEL_SUPPORT_INCOMPLETE', 'MODEL_EVALUATION_FAILED']);
});

test('unclassified alternate cannot be ranked even when a model supports the market', () => {
  const model = registryWith(({ phase }) => fixtureAssessment(phase, 'MORE'));
  const line = fixtureLine({ lineType: 'UNKNOWN_ALTERNATE' });
  const result = evaluateBoard(board([line]), [], model, now);
  assert.equal(result.analyses[0].reasonCode, 'UNCLASSIFIED_ALTERNATE');
  assert.deepEqual(result.rankedLineIds, []);
});

test('AI research failure degrades to missing evidence', async () => {
  const result = await collectResearch(board([fixtureLine()]), {
    id: 'fixture-research', research: async () => { throw new Error('Fixture AI outage'); },
  });
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(result.evidence, []);
});

test('Crowns reject duplicate players, Apex teammates and missing correlation audit', () => {
  const line1 = fixtureLine();
  const line2 = fixtureLine({ id: 'test-line-2', playerId: line1.playerId, market: 'pass_attempts' });
  const picks = [line1, line2].map((line) => ({ line, analysis: fixtureAnalysis(line) }));
  assert.ok(auditCrown(picks, 2, () => []).includes('DUPLICATE_PLAYER'));
  assert.deepEqual(buildAutoCrown(picks, 2).issues, ['CORRELATION_AUDIT_UNAVAILABLE']);
  const apex1 = fixtureLine({ id: 'a1', sport: 'APEX', team: 'APEX_A', playerId: 'apex-1' });
  const apex2 = fixtureLine({ id: 'a2', sport: 'APEX', team: 'APEX_A', playerId: 'apex-2' });
  assert.ok(auditCrown([apex1, apex2].map((line) => ({ line, analysis: fixtureAnalysis(line) })),
    2, () => []).includes('APEX_SAME_TEAM'));
});

test('auto Crown only returns a complete audited combination', () => {
  const a = fixtureLine();
  const duplicate = fixtureLine({ id: 'duplicate', threshold: 220.5 });
  const b = fixtureLine({ id: 'another-player', playerId: 'test-player-2' });
  const candidates = [a, duplicate, b].map((line) => ({ line, analysis: fixtureAnalysis(line) }));
  assert.deepEqual(buildAutoCrown(candidates, 2, () => []).picks?.map((pick) => pick.line.id), [a.id, b.id]);
  const partial = buildAutoCrown(candidates.slice(0, 2), 2, () => []);
  assert.deepEqual(partial.picks?.map((pick) => pick.line.id), [a.id]);
  assert.ok(partial.issues.includes('INSUFFICIENT_QUALIFIED_PICKS'));
});

test('conservative correlation policy limits one game and same-team QB stacks', async () => {
  const { conservativeCorrelationPolicy } = await import('../src/correlation.js');
  const pick = (eventId: string, market: string, team: string, direction: 'MORE' | 'LESS') => ({
    line: { eventId, market, team } as never, analysis: { direction } as never });
  assert.deepEqual(conservativeCorrelationPolicy([pick('a', 'passing_yards', 'BUF', 'MORE'),
    pick('b', 'player_points', 'LAL', 'MORE')]), []);
  assert.deepEqual(conservativeCorrelationPolicy([pick('a', 'player_points', 'X', 'MORE'),
    pick('a', 'player_rebounds', 'Y', 'MORE'), pick('a', 'player_assists', 'Z', 'MORE')]), ['SAME_EVENT_CONCENTRATION']);
  assert.deepEqual(conservativeCorrelationPolicy([pick('a', 'passing_yards', 'BUF', 'MORE'),
    pick('a', 'player_reception_yds', 'BUF', 'MORE')]), ['QB_RECEIVER_STACK']);
  // Opposite directions, or an opposing receiver, are not a stack.
  assert.deepEqual(conservativeCorrelationPolicy([pick('a', 'passing_yards', 'BUF', 'MORE'),
    pick('a', 'player_reception_yds', 'BUF', 'LESS')]), []);
  assert.deepEqual(conservativeCorrelationPolicy([pick('a', 'passing_yards', 'BUF', 'MORE'),
    pick('a', 'player_reception_yds', 'MIA', 'MORE')]), []);
});
