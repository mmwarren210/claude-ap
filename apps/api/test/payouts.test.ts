import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bestBreakEven, breakEven, DEFAULT_PAYOUTS, entryBreakEvens, entryReturn, mergePayouts } from '@crowniq/contracts';
import { ProductLedger } from '../src/product-ledger.js';
import { buildServer } from '../src/server.js';

test('break-evens follow from each payout table', () => {
  // All-or-nothing: the chance whose power of the leg count returns the stake.
  assert.equal(breakEven({ 2: 3 }, 2), Math.round(Math.sqrt(1 / 3) * 10_000) / 10_000);
  assert.equal(breakEven({ 6: 40 }, 6), Math.round((1 / 40) ** (1 / 6) * 10_000) / 10_000);
  // PrizePicks 6-pick Flex is the 54.2% bar the +EV page has always used.
  assert.equal(breakEven(DEFAULT_PAYOUTS.prizepicks.FLEX[6], 6), 0.5421);
  const flex = DEFAULT_PAYOUTS.underdog.FLEX[6]!, p = breakEven(flex, 6)!;
  assert.ok(Math.abs(entryReturn(flex, 6, p) - 1) < 0.001);
  // An entry that can never pay back has no break-even.
  assert.equal(breakEven({ 3: 0.9 }, 3), null);
  assert.equal(breakEven(undefined, 3), null);
});

test('each app lists its entries easiest first; Pick6 has no Flex', () => {
  for (const app of ['prizepicks', 'underdog', 'pick6'] as const) {
    const entries = entryBreakEvens(DEFAULT_PAYOUTS[app]);
    assert.deepEqual(entries.map((entry) => entry.breakEven), [...entries.map((entry) => entry.breakEven)].sort((a, b) => a - b));
  }
  assert.ok(entryBreakEvens(DEFAULT_PAYOUTS.pick6).every((entry) => entry.mode === 'POWER'));
  assert.deepEqual(bestBreakEven(DEFAULT_PAYOUTS.prizepicks), { mode: 'FLEX', legs: 6, breakEven: 0.5421, fullHit: 25 });
});

test('a payout override changes only the entries it names, and a bad one is ignored', () => {
  const merged = mergePayouts({ pick6: { POWER: { 3: { 3: 6 }, 2: {} } } });
  assert.deepEqual(merged.pick6.POWER, { 3: { 3: 6 }, 4: { 4: 10 }, 5: { 5: 12 }, 6: { 6: 37.5, 5: 1.5 }, 7: { 7: 40, 6: 2 }, 8: { 8: 80, 7: 3, 6: 1 } });
  assert.deepEqual(merged.pick6.FLEX, DEFAULT_PAYOUTS.pick6.FLEX);
  assert.deepEqual(merged.underdog, DEFAULT_PAYOUTS.underdog);
  assert.equal(mergePayouts({ pick6: { POWER: { 3: { 3: -1 } } } }), DEFAULT_PAYOUTS);
  assert.equal(mergePayouts('nonsense'), DEFAULT_PAYOUTS);
  assert.equal(mergePayouts(null), DEFAULT_PAYOUTS);
});

test('/v1/payouts serves each app table and break-evens', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-payouts-'));
  const payouts = mergePayouts({ pick6: { POWER: { 2: { 2: 3.5 }, 3: {}, 4: {}, 5: {}, 6: {}, 7: {}, 8: {} } } });
  const app = buildServer({ product: new ProductLedger(join(folder, 'ledger.json')), payouts });
  try {
    const response = await app.inject('/v1/payouts');
    assert.equal(response.statusCode, 200);
    const body = response.json() as { payouts: typeof payouts; breakEvens: Record<string, { mode: string; legs: number; breakEven: number }[]> };
    assert.deepEqual(body.payouts.pick6.POWER, { 2: { 2: 3.5 } });
    assert.deepEqual(body.breakEvens.pick6, [{ mode: 'POWER', legs: 2, breakEven: breakEven({ 2: 3.5 }, 2), fullHit: 3.5 }]);
    assert.equal(body.breakEvens.prizepicks![0]!.breakEven, 0.5421);
  } finally { await app.close(); await rm(folder, { recursive: true, force: true }); }
});
