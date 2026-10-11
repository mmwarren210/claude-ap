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

test('end-of-trial poll: opens in the last day, works after the pass ends, adds 7 days once', async () => {
  let now = new Date('2026-10-11T12:00:00Z');
  const ledger = new ProductLedger(join(await mkdtemp(join(tmpdir(), 'poll-')), 'ledger.json'), 'CROWN_STRONG', () => now);
  const [key] = await ledger.issueTrialKeys(1);
  const device = 'device-pollpollpollpoll';
  const session = await ledger.trialLogin(key, device);
  const accountId = (await ledger.authenticate(session.token))!.accountId;
  assert.equal((await ledger.trialPollStatus(accountId)).eligible, false, 'not in the first day');
  await assert.rejects(ledger.answerTrialPoll({ accountId }, { recommend: 'YES', liked: [], improve: null }), /POLL_NOT_OPEN/);
  now = new Date('2026-10-13T20:00:00Z'); // the pass ended at 12:00
  await assert.rejects(ledger.trialLogin(key, device), /GUEST_PASS_EXPIRED/);
  const renewed = await ledger.answerTrialPoll({ code: key, deviceId: device }, { recommend: 'YES', liked: ['Vetted'], improve: 'More sports',
    plan: 'MONTH', price: '$21–30' });
  assert.ok(renewed.guestExpiresAt?.startsWith('2026-10-20T20:00'));
  assert.ok(await ledger.authenticate(renewed.token));
  await assert.rejects(ledger.answerTrialPoll({ code: key, deviceId: device }, { recommend: 'NO', liked: [], improve: null }), /POLL_ALREADY_ANSWERED/);
  const results = await ledger.trialPollResults();
  assert.equal(results.answered, 1); assert.equal(results.recommend.YES, 1); assert.equal(results.liked.Vetted, 1);
  assert.equal(results.plans.MONTH, 1); assert.equal(results.prices['MONTH $21–30'], 1);
  await assert.rejects(ledger.answerTrialPoll({ code: key, deviceId: 'someone-elses-device-x' }, { recommend: 'YES', liked: [], improve: null }), /TRIAL_NOT_FOUND/);
});

test('Trial users lists every trial account: on trial, ended and signed up, with key number and poll', async () => {
  let now = new Date('2026-10-11T12:00:00Z');
  const ledger = new ProductLedger(join(await mkdtemp(join(tmpdir(), 'trials-')), 'ledger.json'), 'CROWN_STRONG', () => now);
  const [first, second] = await ledger.issueTrialKeys(2);
  await ledger.trialLogin(first, 'device-aaaaaaaaaaaaaaaa');
  await ledger.trialLogin(second, 'device-bbbbbbbbbbbbbbbb');
  now = new Date('2026-10-14T00:00:00Z');
  await ledger.register('b@example.com', 'a-good-password-1', 'Bee', { code: second, deviceId: 'device-bbbbbbbbbbbbbbbb' });
  const trials = await ledger.trialUsers();
  assert.equal(trials.length, 2);
  assert.deepEqual(trials.map((trial) => [trial.keyNumber, trial.status]).sort(), [[1, 'ENDED'], [2, 'SIGNED_UP']]);
  assert.equal((await ledger.members()).length, 1, 'the member list still drops the ended trial');
});

test('payments: "I have paid" gives a trial 24 hours once; a member key turns the trial into a paid member; keys work once', async () => {
  let now = new Date('2026-10-11T12:00:00Z');
  const ledger = new ProductLedger(join(await mkdtemp(join(tmpdir(), 'pay-')), 'ledger.json'), 'CROWN_STRONG', () => now);
  const [trialKey] = await ledger.issueTrialKeys(1);
  const device = 'device-paypaypaypaypay';
  const session = await ledger.trialLogin(trialKey, device);
  const accountId = (await ledger.authenticate(session.token))!.accountId;
  const first = await ledger.requestPayment(accountId, 'MONTH', 'Cash App');
  assert.equal(first.graced, true);
  assert.ok(first.guestExpiresAt?.startsWith('2026-10-14T12:00'), 'two days plus 24 hours');
  assert.equal((await ledger.requestPayment(accountId, 'MONTH', 'Cash App')).graced, false, 'only once');
  assert.equal((await ledger.payments()).requests.length, 2);
  const key = await ledger.issueMemberKey('MONTH');
  await assert.rejects(ledger.register('x@example.com', 'a-good-password-1', 'Payer', { code: 'trial', deviceId: device }, 'CIQM-NOPE-NOPE-NOPE'), /MEMBER_KEY_INVALID/);
  const member = await ledger.register('x@example.com', 'a-good-password-1', 'Payer', { code: 'trial', deviceId: device }, key);
  assert.equal(member.profile.plan, 'FREE');
  assert.equal((await ledger.trialUsers())[0].status, 'SIGNED_UP');
  assert.deepEqual((await ledger.payments()).keys.map((item) => item.used), [true]);
  const renewal = await ledger.issueMemberKey('MONTH');
  now = new Date('2026-10-20T12:00:00Z');
  const renewed = await ledger.redeemMemberKey(accountId, renewal);
  assert.ok(renewed.paid?.until?.startsWith('2026-12-10'), 'a renewal adds 30 days to what was left');
  now = new Date('2026-12-08T12:00:00Z');
  const plan = await ledger.subscription(accountId);
  assert.equal(plan?.plan, 'MONTH'); assert.equal(plan?.daysLeft, 2, 'the renewal alert shows from 3 days before');
  await assert.rejects(ledger.redeemMemberKey(accountId, renewal), /MEMBER_KEY_INVALID/);
});
