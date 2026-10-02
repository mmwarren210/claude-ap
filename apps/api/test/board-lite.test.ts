import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisSchema, boardResponseSchema } from '@crowniq/contracts';
import { fixtureAnalysis, fixtureLine, now } from '../../../packages/engine/test/fixtures.js';
import { liteBoard } from '../src/board-lite.js';

test('the lite board keeps upcoming games, full scored analyses and slim PASS analyses', () => {
  const upcoming = fixtureLine({ id: 'up', sourceLineId: 'up', playerId: 'p-up' });
  const pass = fixtureLine({ id: 'pass', sourceLineId: 'pass', playerId: 'p-pass' });
  const started = fixtureLine({ id: 'gone', sourceLineId: 'gone', playerId: 'p-gone', eventStartTime: '2030-09-24T11:00:00.000Z' });
  const passAnalysis = analysisSchema.parse({ ...fixtureAnalysis(pass), direction: 'PASS', score: null, scoreBand: 'PASS',
    reasonCode: 'INSUFFICIENT_EDGE', evidenceIds: ['a', 'b'], opposingFactors: ['x'], rationale: 'r'.repeat(400),
    evidenceExpiresAt: '2030-09-24T13:00:00.000Z',
    contextBreakdown: [{ name: 'expected_attempts', contribution: 10, explanation: 'Observed 1 versus reference 1; weight 25.' }] });
  const full = boardResponseSchema.parse({ board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines: [upcoming, pass, started] },
    analyses: [fixtureAnalysis(upcoming), passAnalysis, fixtureAnalysis(started)], rankedLineIds: ['up', 'gone'],
    builtAt: now.toISOString(), playerMedia: { 'p-up': { photoUrl: 'https://example.org/up.png', source: 'Fixture' },
      'p-gone': { photoUrl: 'https://example.org/gone.png', source: 'Fixture' } } });
  const lite = boardResponseSchema.parse(liteBoard(full, now));
  assert.deepEqual(lite.board.lines.map((line) => line.id), ['up', 'pass']);
  assert.deepEqual(lite.rankedLineIds, ['up']);
  assert.deepEqual(Object.keys(lite.playerMedia ?? {}), ['p-up']);
  assert.deepEqual(lite.analyses[0], full.analyses[0], 'scored analyses are untouched');
  const slim = lite.analyses[1];
  assert.deepEqual([slim.reasonCode, slim.scoreBand, slim.evidenceExpiresAt, slim.evidenceIds, slim.opposingFactors, slim.contextBreakdown],
    ['INSUFFICIENT_EDGE', 'PASS', '2030-09-24T13:00:00.000Z', [], [], undefined]);
  assert.equal(slim.rationale.length, 160);
  assert.ok(JSON.stringify(lite).length < JSON.stringify(full).length);
});
