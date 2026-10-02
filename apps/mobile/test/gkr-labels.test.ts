import assert from 'node:assert/strict';
import test from 'node:test';
import { marketDefinitions } from '../../../packages/engine/src/models/definitions.js';
import { describeComponent, factorLabels, scoreBreakdown } from '../src/gkr-labels.js';
import type { Analysis } from '@crowniq/contracts';

test('every model factor has a hand-written label', () => {
  const keys = [...new Set(marketDefinitions.flatMap((definition) => definition.factors.map(([key]) => key)))];
  assert.deepEqual(keys.filter((key) => !factorLabels[key]), []);
});

test('rows read the structured fields, and older boards still read from the text', () => {
  const structured = describeComponent({ name: 'target_opportunity_rate', contribution: 18.4,
    explanation: 'Observed 0.29 versus reference 0.25; weight 25.', kind: 'FACTOR', measured: true, weight: 25,
    observed: 0.29, reference: 0.25 });
  assert.deepEqual([structured.label, structured.value, structured.detail],
    ['Targets per snap', '+18.4 of 25', 'Recent 0.29 vs usual 0.25 (+16%)']);
  const legacy = describeComponent({ name: 'target_opportunity_rate', contribution: 18.4,
    explanation: 'Observed 0.29 versus reference 0.25; weight 25.' });
  assert.deepEqual([legacy.value, legacy.detail], [structured.value, structured.detail]);
  const unmeasured = describeComponent({ name: 'coverage_matchup', contribution: 0,
    explanation: 'No current attributed metric supplied; weight 10 contributes zero.', kind: 'FACTOR', measured: false, weight: 10 });
  assert.deepEqual([unmeasured.value, unmeasured.measured], ['Not measured', false]);
  const less = describeComponent({ name: 'expected_minutes', contribution: 20, explanation: 'x', kind: 'FACTOR',
    measured: true, weight: 25, observed: 30, reference: 34, favorsBelowReference: true });
  assert.match(less.detail!, /lower helps this LESS pick/);
});

test('the two groups add up to the score', () => {
  const analysis = { scoreBreakdown: [
    { name: 'expected_attempts', contribution: 20, explanation: 'Observed 1 versus reference 1; weight 25.', kind: 'FACTOR', measured: true, weight: 25, observed: 1, reference: 1 },
    { name: 'partial_coverage_adjustment', contribution: 50, explanation: 'Normalize.', kind: 'COVERAGE' },
    { name: 'threshold_cushion', contribution: 12, explanation: 'Signed margin 3.2 standard deviations.', kind: 'LINE_ADJUSTMENT' },
    { name: 'variance', contribution: 0, explanation: 'cv', kind: 'LINE_ADJUSTMENT' },
    { name: 'score_clamp', contribution: -2, explanation: 'Constrain line score to 0–100.', kind: 'CLAMP' },
  ] } as unknown as Analysis;
  const result = scoreBreakdown(analysis);
  assert.deepEqual(result.context.map((row) => row.label), ['Pass attempts', 'Scaled for unmeasured factors']);
  assert.deepEqual(result.adjustments.map((row) => row.label), ['Room between projection and line', 'Score limit']);
  assert.equal(result.contextTotal + result.adjustmentTotal, 80);
});
