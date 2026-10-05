import assert from 'node:assert/strict';
import test from 'node:test';
import { probeOddsApi, summarizeBooks } from '../src/edge/odds-api-probe.js';

test('edge probe: counts lines and multipliers per DFS book', () => {
  const books = [{ key: 'underdog', markets: [{ key: 'player_receptions', outcomes: [
    { name: 'Over', description: 'A', point: 4.5, multiplier: 1.03 }, { name: 'Under', description: 'A', point: 4.5, multiplier: null }] }] }];
  assert.deepEqual(summarizeBooks(books, ['underdog', 'pick6']), [
    { key: 'underdog', outcomes: 2, withPoint: 2, withMultiplier: 1, multipliers: [1.03] },
    { key: 'pick6', outcomes: 0, withPoint: 0, withMultiplier: 0, multipliers: [] }]);
});

test('edge probe: one events call and one odds call per sport, credits read from headers', async () => {
  const calls: string[] = [];
  const fake = (async (input: URL) => {
    calls.push(input.pathname + '?' + [...input.searchParams.keys()].filter((key) => key !== 'apiKey').join(','));
    if (input.pathname.endsWith('/events')) return new Response(JSON.stringify([{ id: 'e1', commence_time: '2026-10-06T23:00:00Z' }]));
    return new Response(JSON.stringify({ bookmakers: [] }), { headers: { 'x-requests-last': '1', 'x-requests-remaining': '99' } });
  }) as unknown as typeof fetch;
  const results = await probeOddsApi('k', fake, () => Date.parse('2026-10-05T20:00:00Z'));
  assert.equal(calls.length, 4);
  assert.equal(results[0]!.creditsLast, 1);
  assert.equal(results[0]!.creditsRemaining, 99);
  assert.ok(calls[1]!.includes('bookmakers') && calls[1]!.includes('includeMultipliers'));
});
