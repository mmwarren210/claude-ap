import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeNflPassingSelection, snapshotSelection } from '../src/index.js';
import { fixtureAnalysis, fixtureLine, now } from './fixtures.js';

const after = new Date('2030-09-25T06:00:00.000Z');
const source = { sourceName: 'Synthetic box-score fixture',
  sourceUrl: 'https://example.org/test-only',
  eventId: 'test-event', playerId: 'test-player-1', market: 'passing_yards' as const,
  status: 'FINAL' as const, completedAt: '2030-09-25T04:00:00.000Z',
  retrievedAt: '2030-09-25T05:00:00.000Z' };

test('grades the saved exact MORE/LESS threshold including equality and legitimate zero', () => {
  const line = fixtureLine();
  const more = snapshotSelection(line, fixtureAnalysis(line, 'MORE'), [], now);
  const less = snapshotSelection(line, fixtureAnalysis(line, 'LESS'), [], now);
  assert.equal(gradeNflPassingSelection(more, { ...source, observedValue: 270 }, after).grade, 'WIN');
  assert.equal(gradeNflPassingSelection(less, { ...source, observedValue: 270 }, after).grade, 'LOSS');
  const wholeLine = fixtureLine({ threshold: 240 });
  assert.equal(gradeNflPassingSelection(snapshotSelection(wholeLine,
    fixtureAnalysis(wholeLine), [], now), { ...source, observedValue: 240 }, after).grade, 'PUSH');
  const attempts = fixtureLine({ market: 'player_pass_attempts', threshold: 0.5 });
  const saved = snapshotSelection(attempts, fixtureAnalysis(attempts, 'LESS'), [], now);
  const graded = gradeNflPassingSelection(saved, { ...source,
    market: 'player_pass_attempts', observedValue: 0 }, after);
  assert.equal(graded.grade, 'WIN');
  assert.equal(graded.gradeDetail?.observedValue, 0);
  assert.equal(graded.line.threshold, 0.5);
  assert.equal(graded.modelVersion, 'test-v1');
});

test('DNP/void stays distinct from zero; identity, timing and repeated grades are rejected', () => {
  const line = fixtureLine();
  const saved = snapshotSelection(line, fixtureAnalysis(line), [], now);
  const voided = gradeNflPassingSelection(saved,
    { ...source, status: 'DNP', observedValue: null }, after);
  assert.equal(voided.grade, 'DNP_VOID');
  assert.equal(voided.gradeDetail?.status, 'DNP');
  assert.throws(() => gradeNflPassingSelection(saved,
    { ...source, playerId: 'other-qb', observedValue: 400 }, after), /RESULT_IDENTITY_MISMATCH/);
  assert.throws(() => gradeNflPassingSelection(saved,
    { ...source, observedValue: 400, completedAt: now.toISOString() }, after), /RESULT_TIME_INVALID/);
  assert.throws(() => gradeNflPassingSelection(saved,
    { ...source, observedValue: 400 }, now), /RESULT_TIME_INVALID/);
  assert.throws(() => gradeNflPassingSelection(voided,
    { ...source, observedValue: 400 }, after), /SELECTION_ALREADY_GRADED/);
});
