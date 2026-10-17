import assert from 'node:assert/strict';
import test from 'node:test';
import { cdf, makeDistribution, median } from '../src/distributions.js';
import type { Distribution, Family } from '../src/distributions.js';

const linearMedian = (dist: Distribution) => {
  const sd = Math.sqrt(dist.variance); let k = Math.max(0, Math.floor(dist.mean - 6 * sd));
  while (cdf(dist,k) < .5 && k < dist.mean + 12 * sd + 50) k++;
  return k;
};
test('bounded integer median matches the previous algorithm over real stat ranges', () => {
  for (const family of ['NORMAL','POISSON','NEGBIN'] as Family[])
    for (const mean of [.01,.5,1,2.5,5,13,30,80,300,1000]) for (const spread of [1,2,5]) {
      const dist = makeDistribution(family,mean,Math.max(1,mean * spread),true);
      assert.equal(median(dist),linearMedian(dist),JSON.stringify(dist));
    }
});
test('large finite ranges finish, and non-advancing or non-finite integer ranges fail instead of hanging', () => {
  assert.equal(median({family:'NORMAL',mean:1e8,variance:1e16,discrete:true}),1e8);
  assert.throws(()=>median({family:'NORMAL',mean:1e20,variance:1e24,discrete:true}),/INVALID_MEDIAN_RANGE/);
  assert.throws(()=>median({family:'NORMAL',mean:100,variance:Infinity,discrete:true}),/INVALID_MEDIAN_RANGE/);
});
