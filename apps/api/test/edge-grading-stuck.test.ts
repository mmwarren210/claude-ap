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

const awaiting = (sports: string[]) => sports.map((sport, index) => ({ sport, playerName: `P${index}`, market: 'kills',
  eventId: `e${index}`, playerId: `p${index}` }));

test('free-history grading leaves a stalling source for the next run and keeps grading the others', async () => {
  let clock = new Date('2030-10-08T12:00:00Z');
  const picks = awaiting(['DOTA', 'DOTA', 'DOTA', 'DOTA', 'DOTA', 'TENNIS', 'TENNIS']);
  const ledger = { awaitingResults: async () => picks, grade: async () => ({ graded: 0 }) } as unknown as EdgeLedger;
  const asked: string[] = [];
  const worker = new EdgeResultsWorker(ledger, null, null, () => clock, async (sport) => {
    asked.push(sport);
    if (sport === 'DOTA') clock = new Date(clock.getTime() + 60_000);
    return null;
  });
  await worker.runOnce();
  assert.deepEqual(asked, ['DOTA', 'DOTA', 'DOTA', 'TENNIS', 'TENNIS']);
});

test('free-history grading stops at its time budget', async () => {
  let clock = new Date('2030-10-08T12:00:00Z');
  const ledger = { awaitingResults: async () => awaiting(['TENNIS', 'DOTA', 'TENNIS', 'DOTA', 'TENNIS', 'DOTA', 'TENNIS', 'DOTA']), grade: async () => ({ graded: 0 }) } as unknown as EdgeLedger;
  let asked = 0;
  const worker = new EdgeResultsWorker(ledger, null, null, () => clock, async () => {
    asked++; clock = new Date(clock.getTime() + 2 * 60_000); return null;
  });
  const result = await worker.runOnce();
  assert.equal(asked, 3, 'lookups stop once 5 minutes have gone by');
  assert.equal(result?.error, null);
});
