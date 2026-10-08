import assert from 'node:assert/strict';
import test from 'node:test';
import { EdgeResultsWorker } from '../src/edge/service.js';
import type { EdgeLedger } from '../src/edge/ledger.js';

test('a grading run stuck on a source that never answers stops blocking later runs after 30 minutes', async () => {
  let calls = 0, clock = new Date('2030-10-08T12:00:00Z');
  const ledger = { awaitingResults: () => { calls++; return calls === 1 ? new Promise(() => undefined) : Promise.resolve([]); },
    grade: async () => ({ graded: 0 }) } as unknown as EdgeLedger;
  const worker = new EdgeResultsWorker(ledger, null, null, () => clock);
  void worker.runOnce();
  await worker.runOnce();
  assert.equal(calls, 1, 'within 30 minutes the stuck run still holds');
  clock = new Date(clock.getTime() + 31 * 60_000);
  await worker.runOnce();
  assert.ok(calls >= 2, 'after 30 minutes a new run starts');
});
