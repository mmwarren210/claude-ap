import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAILY_REPORTS, FeedbackStore } from '../src/feedback.js';

test('testers report bugs and ideas; review, replies and patch notes reach them; a daily limit holds', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-feedback-'));
  try {
    let clock = new Date('2030-10-05T12:00:00Z');
    const file = join(folder, 'feedback.json');
    const store = new FeedbackStore(file, () => clock);
    const ann = { accountId: 'a1', username: 'Ann' }, bo = { accountId: 'b2', username: 'Bo' };
    const bug = await store.submit(ann, 'BUG', '  The Crown tab freezes  ', 'Crown');
    const idea = await store.submit(bo, 'SUGGESTION', 'Add an NBA filter', null);
    assert.equal(bug.text, 'The Crown tab freezes');
    assert.deepEqual((await store.mine('a1')).map((item) => item.id), [bug.id], 'each tester sees only their own');
    assert.ok(!('accountId' in (await store.mine('a1'))[0]), 'no account ids leave the store');
    assert.deepEqual(await store.summary(), { new: 2, bugs: 1, suggestions: 1, total: 2, updates: 0 });
    await store.review(idea.id, 'DECLINED', 'Already there: use the sport chips.');
    const note = await store.postUpdate('Patch 1.1', 'Crown tab no longer freezes.', [bug.id, '00000000-0000-4000-8000-000000000000']);
    assert.deepEqual(note.feedbackIds, [bug.id], 'unknown ids are dropped');
    const reread = new FeedbackStore(file, () => clock);
    const [annItem] = await reread.mine('a1'), [boItem] = await reread.mine('b2');
    assert.deepEqual([annItem.status, annItem.updateId], ['FIXED', note.id]);
    assert.deepEqual([boItem.status, boItem.reply], ['DECLINED', 'Already there: use the sport chips.']);
    assert.equal((await reread.updates())[0].title, 'Patch 1.1');
    for (let index = 1; index < DAILY_REPORTS; index++) await reread.submit(ann, 'BUG', `Report number ${index}`, null);
    await assert.rejects(reread.submit(ann, 'BUG', 'One too many', null), /DAILY_LIMIT/);
    clock = new Date('2030-10-06T12:00:01Z');
    assert.ok(await reread.submit(ann, 'BUG', 'A new day', null), 'the limit is per 24 hours');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
