import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapInterval, calibrationBuckets, evaluate, meanInterval, wilson } from '../src/index.js';

test('Wilson interval and mean interval', () => {
  const interval = wilson(55, 100)!;
  assert.ok(Math.abs(interval.value - .55) < 1e-9);
  assert.ok(interval.low > .45 && interval.low < .46 && interval.high > .64 && interval.high < .65);
  assert.equal(wilson(0, 0), null);
  const mean = meanInterval([1, 2, 3])!;
  assert.equal(mean.value, 2);
  assert.ok(mean.low < 2 && mean.high > 2);
});

test('bootstrap is deterministic and brackets the mean', () => {
  const values = Array.from({ length: 200 }, (_, index) => index % 2 ? 1 : -1);
  const a = bootstrapInterval(values)!, b = bootstrapInterval(values)!;
  assert.deepEqual(a, b);
  assert.ok(a.low < 0 && a.high > 0);
});

test('evaluate: CLV against the break-even when shown, beat-the-close, ROI per $1, calibration', () => {
  const picks = [
    { hit: true, firstProbability: .56, closeProbability: .6, breakEven: .542 },
    { hit: false, firstProbability: .58, closeProbability: .55, breakEven: .542 },
    { hit: true, firstProbability: .5, closeProbability: .52, breakEven: 1 / 2.1, decimal: 2.1 },
  ];
  const result = evaluate(picks);
  assert.equal(result.graded, 3);
  assert.ok(Math.abs(result.clv!.value - ((.6 - .542) + (.55 - .542) + (.52 * 2.1 - 1)) / 3) < 1e-9);
  assert.ok(Math.abs(result.beatClose! - 2 / 3) < 1e-9);
  assert.ok(Math.abs(result.roi!.value - ((1 / .542 - 1) - 1 + 1.1) / 3) < 1e-9);
  assert.equal(calibrationBuckets(picks).reduce((sum, bucket) => sum + bucket.n, 0), 3);
  assert.equal(result.maxCalibrationGap, null, 'no bucket has 50 picks yet');
});
