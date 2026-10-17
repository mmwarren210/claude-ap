import assert from 'node:assert/strict';
import test from 'node:test';
import { cdf, makeDistribution, median } from '../src/distributions.js';
import type { Distribution } from '../src/distributions.js';

// The step-by-step search median() replaced, kept here to prove the answers did not move.
function walkedMedian(dist: Distribution): number {
  if (!dist.discrete) return dist.mean;
  const sd = Math.sqrt(dist.variance);
  let k = Math.max(0, Math.floor(dist.mean - 6 * sd));
  while (cdf(dist, k) < .5 && k < dist.mean + 12 * sd + 50) k++;
  return k;
}

test('median matches the step-by-step search for ordinary lines', () => {
  const cases: Distribution[] = [];
  for (const mean of [.05, .3, .5, 1, 1.5, 2.5, 4, 7.5, 12, 22, 48.5, 110, 260.5, 900, 4800])
    for (const ratio of [1, 1.3, 2.5, 6]) {
      cases.push(makeDistribution('POISSON', mean, mean));
      cases.push(makeDistribution('NEGBIN', mean, mean * ratio));
      cases.push(makeDistribution('NORMAL', mean, mean * ratio + 4));
      cases.push(makeDistribution('NORMAL', -mean, mean * ratio + 4));
    }
  for (const dist of cases) assert.equal(median(dist), walkedMedian(dist), JSON.stringify(dist));
});

test('median returns at once for a mean so large that k + 1 rounds back to k', () => {
  const started = Date.now();
  const value = median({ family: 'NORMAL', mean: 1e20, variance: 1e24, discrete: true });
  assert.ok(Number.isFinite(value) && value > 9e19);
  assert.ok(median(makeDistribution('NEGBIN', 1e9, 1e12)) > 0);
  assert.ok(Date.now() - started < 1000);
});
