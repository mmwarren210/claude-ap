import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nextSlot, SlotLedger } from '../src/scrapers/slot-ledger.js';

test('next scheduled slot: later today, else tomorrow’s first (Eastern time)', () => {
  // 18:20 ET on Oct 6 (22:20 UTC).
  assert.deepEqual(nextSlot([9, 12, 15, 18], new Date('2030-10-06T22:20:00Z')), { day: '2030-10-07', hour: 9 });
  assert.deepEqual(nextSlot([8, 11, 14, 17, 20], new Date('2030-10-06T22:20:00Z')), { day: '2030-10-06', hour: 20 });
  assert.equal(nextSlot([], new Date()), null);
});

test('a slot claimed ahead (skip next) survives today’s claims and stops that scheduled run', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-slots-'));
  try {
    const ledger = new SlotLedger(join(folder, 'slots.json'));
    assert.equal(await ledger.claim('2030-10-07', '9|zen-studio-prizepicks'), true, 'skip tomorrow 9:00');
    assert.equal(await ledger.claim('2030-10-06', '20|context:injuries'), true, 'a run later today');
    const reread = new SlotLedger(join(folder, 'slots.json'));
    assert.equal(await reread.claim('2030-10-07', '9|zen-studio-prizepicks'), false, 'tomorrow’s 9:00 is already taken, so it is skipped');
    assert.equal(await reread.claim('2030-10-07', '12|zen-studio-prizepicks'), true, 'the run after still happens');
  } finally { await rm(folder, { recursive: true, force: true, maxRetries: 5 }); }
});
