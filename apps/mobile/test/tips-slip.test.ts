import assert from 'node:assert/strict';
import test from 'node:test';
import { americanOdds, decimalOdds, slipSummary, slipText } from '../src/tips-slip.js';

const leg = (id: string, chance: number, price: number | null, event: string | null = id) => ({ id, label: id, chance, price, fairOdds: -100, event });

test('tips slip: a parlay multiplies the odds and the chances; singles add up', () => {
  assert.equal(decimalOdds(-200), 1.5); assert.equal(decimalOdds(150), 2.5); assert.equal(americanOdds(3.75), 275);
  const legs = [leg('a', .7, -200), leg('b', .45, 150)];
  const parlay = slipSummary(legs, 'PARLAY', 10);
  assert.deepEqual([parlay.payout, parlay.chance, parlay.odds, parlay.expectedProfit], [37.5, .315, 275, 1.81]);
  const singles = slipSummary(legs, 'SINGLES', 10);
  assert.deepEqual([singles.risk, singles.payout, singles.expectedProfit], [20, 40, 1.75]);
  assert.equal(slipSummary([leg('a', .5, null), leg('b', .5, -110, 'a')], 'PARLAY', 10).unpriced, 1);
  assert.equal(slipSummary([leg('a', .5, -110, 'g'), leg('b', .5, -110, 'g')], 'PARLAY', 10).sameGame, true);
  assert.match(slipText(legs, parlay), /Parlay \+275 · \$10 to win \$27\.5/);
});
