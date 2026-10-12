import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProductLedger } from '../src/product-ledger.js';
import { buildServer } from '../src/server.js';

/** A trial's login (owner, 2026-10-12: a new trial needs one), unique per device. */
const signup = (device: string) => ({ username: `T_${device.replace(/[^A-Za-z0-9]/g, '').slice(-12)}`, email: `${device}@example.com`, password: 'trial-password-1' });


test('trial keys: single use, 2 days from first use, off the member list after, upgrade takes a seat', async () => {
  let now = new Date('2026-10-11T12:00:00Z');
  const ledger = new ProductLedger(join(await mkdtemp(join(tmpdir(), 'trial-')), 'ledger.json'), 'CROWN_STRONG', () => now);
  const [key, other] = await ledger.issueTrialKeys(2);
  assert.match(key, /^CIQ-/);
  const device = 'device-aaaaaaaaaaaaaaaa';
  const session = await ledger.trialLogin(key, device, signup(device));
  assert.ok(session.guestExpiresAt?.startsWith('2026-10-13T12:00'));
  // Same device, other key: its own trial back, no second one.
  assert.equal((await ledger.trialLogin(other, device, signup(device))).trialNote, undefined);
  assert.equal((await ledger.membership()).trials.used, 1);
  // Someone else clicks the used key: they get the next one.
  assert.equal((await ledger.trialLogin(key, 'device-bbbbbbbbbbbbbbbb', signup('device-bbbbbbbbbbbbbbbb'))).trialNote, 'Enjoy your 2 days!');
  await assert.rejects(ledger.trialLogin(key, 'device-cccccccccccccccc', signup('device-cccccccccccccccc')), /TRIALS_ALL_USED/);
  assert.equal((await ledger.membership()).trials.used, 2);
  assert.equal((await ledger.membership()).members.used, 0);
  now = new Date('2026-10-14T00:00:00Z');
  await assert.rejects(ledger.trialLogin(key, device, signup(device)), /GUEST_PASS_EXPIRED/);
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
  const session = await ledger.trialLogin(key, device, signup(device));
  const accountId = (await ledger.authenticate(session.token))!.accountId;
  assert.equal((await ledger.trialPollStatus(accountId)).eligible, false, 'not in the first day');
  await assert.rejects(ledger.answerTrialPoll({ accountId }, { recommend: 'YES', liked: [], improve: null }), /POLL_NOT_OPEN/);
  now = new Date('2026-10-13T20:00:00Z'); // the pass ended at 12:00
  await assert.rejects(ledger.trialLogin(key, device, signup(device)), /GUEST_PASS_EXPIRED/);
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
  await ledger.trialLogin(first, 'device-aaaaaaaaaaaaaaaa', signup('device-aaaaaaaaaaaaaaaa'));
  await ledger.trialLogin(second, 'device-bbbbbbbbbbbbbbbb', signup('device-bbbbbbbbbbbbbbbb'));
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
  const session = await ledger.trialLogin(trialKey, device, signup(device));
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
  assert.ok(renewed.paid?.until?.startsWith('2026-12-12'), 'a renewal adds 31 days to what was left');
  now = new Date('2026-12-10T12:00:00Z');
  const plan = await ledger.subscription(accountId);
  assert.equal(plan?.plan, 'MONTH'); assert.equal(plan?.daysLeft, 2, 'the renewal alert shows from 3 days before');
  await assert.rejects(ledger.redeemMemberKey(accountId, renewal), /MEMBER_KEY_INVALID/);
});

test('owner approves in the app: waiting request, time added at once (31-day months), stacks on what is left', async () => {
  let now = new Date('2026-10-11T12:00:00Z');
  const ledger = new ProductLedger(join(await mkdtemp(join(tmpdir(), 'grant-')), 'ledger.json'), 'CROWN_STRONG', () => now);
  const [trialKey] = await ledger.issueTrialKeys(1);
  const session = await ledger.trialLogin(trialKey, 'device-grantgrantgrant1', signup('device-grantgrantgrant1'));
  const user = (await ledger.authenticate(session.token))!;
  await ledger.requestPayment(user.accountId, 'MONTH', 'Zelle');
  const row = (await ledger.members()).find((item) => item.publicId === user.publicId)!;
  assert.equal(row.waiting?.plan, 'MONTH');
  const granted = await ledger.grantPlan(user.publicId, 'MONTH');
  assert.ok(granted.paid?.until?.startsWith('2026-11-11T12:00'), '31 days');
  assert.equal((await ledger.members()).find((item) => item.publicId === user.publicId)!.waiting, null);
  assert.equal(await ledger.pendingPayment(user.accountId), null);
  now = new Date('2026-10-20T12:00:00Z');
  assert.ok(await ledger.authenticate(session.token), 'still signed in after the trial would have ended');
  now = new Date('2026-11-01T12:00:00Z');
  const stacked = await ledger.grantPlan(user.publicId, 'QUARTER');
  assert.ok(stacked.paid?.until?.startsWith('2027-02-12T12:00'), '93 more days on top of what was left');
  assert.ok(stacked.paid);
});

test('a new trial needs a login; the same person signs in on another device without using a second pass', async () => {
  let now = new Date('2026-10-12T12:00:00Z');
  const ledger = new ProductLedger(join(await mkdtemp(join(tmpdir(), 'trial-login-')), 'ledger.json'), 'CROWN_STRONG', () => now);
  const [key] = await ledger.issueTrialKeys(3);
  await assert.rejects(ledger.trialLogin(key, 'phone-aaaaaaaaaaaaaaaa'), /LOGIN_REQUIRED/);
  assert.equal((await ledger.membership()).trials.used, 0, 'no pass is used without a login');
  const login = { username: 'Jordan_23', email: 'Jordan@Example.com', password: 'trial-password-1' };
  const phone = await ledger.trialLogin(key, 'phone-aaaaaaaaaaaaaaaa', login);
  assert.equal(phone.profile.username, 'Jordan_23');
  assert.equal(phone.profile.plan, 'GUEST');
  // The same phone reopens its trial with no login needed.
  assert.equal((await ledger.trialLogin(key, 'phone-aaaaaaaaaaaaaaaa')).profile.publicId, phone.profile.publicId);
  // A laptop: signing in with the trial's login reaches the same account, same end time, and no second pass.
  const laptop = await ledger.login('jordan@example.com', 'trial-password-1');
  assert.equal(laptop.profile.publicId, phone.profile.publicId);
  assert.equal(laptop.guestExpiresAt, phone.guestExpiresAt);
  assert.equal((await ledger.login('Jordan_23', 'trial-password-1')).profile.publicId, phone.profile.publicId);
  assert.equal((await ledger.authenticate(laptop.token))?.plan, 'GUEST');
  assert.equal((await ledger.membership()).trials.used, 1);
  // Names and emails stay unique.
  await assert.rejects(ledger.trialLogin(key, 'phone-bbbbbbbbbbbbbbbb', { ...login, username: 'Other_1' }), /EMAIL_TAKEN/);
  await assert.rejects(ledger.trialLogin(key, 'phone-bbbbbbbbbbbbbbbb', { ...login, email: 'other@example.com' }), /USERNAME_TAKEN/);
  assert.equal((await ledger.membership()).trials.used, 1);
  // When the pass ends, its login says so instead of signing in.
  now = new Date('2026-10-14T12:00:01Z');
  await assert.rejects(ledger.login('jordan@example.com', 'trial-password-1'), /GUEST_PASS_EXPIRED/);
});

test('a completed survey earns a free week of membership, from any device with the trial login, once', async () => {
  let now = new Date('2026-10-12T12:00:00Z');
  const product = new ProductLedger(join(await mkdtemp(join(tmpdir(), 'free-week-')), 'ledger.json'), 'CROWN_STRONG', () => now);
  const [key] = await product.issueTrialKeys(1);
  await product.trialLogin(key, 'phone-freeweekfreeweek', { username: 'Sam_7', email: 'sam@example.com', password: 'trial-password-1' });
  const app = buildServer({ product, requireProfiles: true, clock: () => now });
  try {
    now = new Date('2026-10-14T13:00:00Z'); // the pass ended at 12:00
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { login: 'sam@example.com', password: 'trial-password-1' } });
    assert.equal(login.statusCode, 403);
    assert.equal(login.json().code, 'GUEST_PASS_EXPIRED', 'the survey is still open');
    const answers = { recommend: 'YES', liked: ['Vetted'], improve: 'More NHL props and faster loading please', plan: 'MONTH', price: '$21–30' };
    const survey = (body: object) => app.inject({ method: 'POST', url: '/v1/auth/trial-poll', payload: body });
    // Only a complete survey counts: something liked, a real written answer, the plan and its price.
    for (const missing of [{ liked: [] }, { improve: 'ok' }, { improve: 'aaaaaaaaaaaaaaaaaaaa' }, { price: null }])
      assert.equal((await survey({ login: 'Sam_7', password: 'trial-password-1', answers: { ...answers, ...missing } })).statusCode, 400);
    assert.equal((await survey({ login: 'Sam_7', password: 'wrong-password-123', answers })).statusCode, 404);
    const done = await survey({ login: 'Sam_7', password: 'trial-password-1', answers });
    assert.equal(done.statusCode, 200);
    assert.ok(done.json().freeWeekUntil.startsWith('2026-10-21T13:00'), 'a week from now, since the pass already ended');
    const token = done.json().token as string;
    const subscription = await product.subscription((await product.authenticate(token))!.accountId);
    assert.deepEqual([subscription?.plan, subscription?.free, subscription?.daysLeft], ['WEEK', true, 7]);
    assert.equal((await survey({ login: 'Sam_7', password: 'trial-password-1', answers })).statusCode, 409, 'one free week per account');
    // "I wouldn't subscribe" needs no price.
    assert.notEqual((await survey({ login: 'Sam_7', password: 'trial-password-1', answers: { ...answers, plan: 'NONE', price: null } })).statusCode, 400);
    // Signing in works through the free week, then says the free time is over.
    assert.equal((await product.login('Sam_7', 'trial-password-1')).profile.plan, 'GUEST');
    now = new Date('2026-10-21T13:00:01Z');
    const over = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { login: 'Sam_7', password: 'trial-password-1' } });
    assert.equal(over.json().code, 'PLAN_ENDED');
  } finally { await app.close(); }
});
