import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLog } from '../src/activity.js';
import { ProductLedger } from '../src/product-ledger.js';
import { buildServer } from '../src/server.js';

test('a beat counts one minute at most every 50 seconds, by Eastern day and tab, and survives a save', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-activity-'));
  let clock = new Date('2030-10-08T16:00:00Z');
  try {
    const log = new ActivityLog(join(folder, 'activity.json'), () => clock);
    assert.equal(await log.beat('a1', 'Member_1', 'edge'), true);
    assert.equal(await log.beat('a1', 'Member_1', 'edge'), false, 'a double beat within 50 s is ignored');
    for (const tab of ['edge', 'gkr-plus', 'edge']) { clock = new Date(clock.getTime() + 60_000); await log.beat('a1', 'Member_1', tab); }
    clock = new Date('2030-10-12T16:00:00Z');
    await log.beat('a1', 'Member_1', 'board');
    await log.flush();
    const [member] = await new ActivityLog(join(folder, 'activity.json'), () => clock).report();
    assert.deepEqual([member!.username, member!.todayMinutes, member!.weekMinutes, member!.totalMinutes], ['Member_1', 1, 5, 5]);
    assert.deepEqual(member!.topTabs[0], { tab: 'edge', minutes: 3 });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('activity routes: members send beats, only the owner reads the report', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-activity-routes-'));
  const product = new ProductLedger(join(folder, 'product.json'));
  const owner = await product.register('owner@example.org', 'long-private-passphrase', 'Owner_1');
  const member = await product.register('member@example.org', 'another-long-passphrase', 'Member_1');
  const app = buildServer({ product, ownerPublicId: owner.profile.publicId, activity: new ActivityLog(null) });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/activity', payload: { tab: 'edge' } })).statusCode, 401);
    assert.deepEqual((await app.inject({ method: 'POST', url: '/v1/activity', headers: auth(member.token), payload: { tab: 'edge' } })).json(), { counted: true });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/owner/activity', headers: auth(member.token) })).statusCode, 404);
    const report = (await app.inject({ method: 'GET', url: '/v1/owner/activity', headers: auth(owner.token) })).json() as
      { members: { username: string; totalMinutes: number }[] };
    assert.deepEqual(report.members.map((row) => [row.username, row.totalMinutes]), [['Member_1', 1]]);
  } finally { await app.close(); await rm(folder, { recursive: true, force: true }); }
});
