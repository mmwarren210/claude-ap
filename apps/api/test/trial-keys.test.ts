import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProductLedger } from '../src/product-ledger.js';

test('trial keys: single use, 2 days from first use, off the member list after, upgrade takes a seat', async () => {
  let now = new Date('2026-10-11T12:00:00Z');
  const ledger = new ProductLedger(join(await mkdtemp(join(tmpdir(), 'trial-')), 'ledger.json'), 'CROWN_STRONG', () => now);
  const [key, other] = await ledger.issueTrialKeys(2);
  assert.match(key, /^CIQ-/);
  const device = 'device-aaaaaaaaaaaaaaaa';
  const session = await ledger.trialLogin(key, device);
  assert.ok(session.guestExpiresAt?.startsWith('2026-10-13T12:00'));
  // Same device, other key: its own trial back, no second one.
  assert.equal((await ledger.trialLogin(other, device)).trialNote, undefined);
  assert.equal((await ledger.membership()).trials.used, 1);
  // Someone else clicks the used key: they get the next one.
  assert.match((await ledger.trialLogin(key, 'device-bbbbbbbbbbbbbbbb')).trialNote ?? '', /#1 was already used.*#2/);
  await assert.rejects(ledger.trialLogin(key, 'device-cccccccccccccccc'), /TRIALS_ALL_USED/);
  assert.equal((await ledger.membership()).trials.used, 2);
  assert.equal((await ledger.membership()).members.used, 0);
  now = new Date('2026-10-14T00:00:00Z');
  await assert.rejects(ledger.trialLogin(key, device), /GUEST_PASS_EXPIRED/);
  assert.equal((await ledger.members()).length, 0);
  const member = await ledger.register('t@example.com', 'a-good-password-1', 'Tester', { code: key, deviceId: device });
  assert.equal(member.profile.plan, 'FREE');
  assert.equal((await ledger.membership()).members.used, 1);
  assert.equal((await ledger.members()).length, 1);
  assert.equal(await ledger.isTrialKey('nope'), false);
  assert.ok(other);
});
