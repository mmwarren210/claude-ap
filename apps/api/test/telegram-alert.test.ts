import assert from 'node:assert/strict';
import test from 'node:test';
import { alertOwner, captureAlertFetch, resetAlerts } from '../src/telegram-alert.js';

test('owner alerts go to Telegram once per kind per cooldown, and do nothing without a bot', async () => {
  const sent: { url: string; body: string }[] = [];
  captureAlertFetch((async (url: string, init: RequestInit) => { sent.push({ url, body: String(init.body) }); return new Response('{}'); }) as unknown as typeof fetch);
  resetAlerts();
  assert.equal(await alertOwner('memory', 'x', 0, {}), false, 'no bot set up: nothing sent');
  const env = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '42' };
  assert.equal(await alertOwner('memory', 'memory at 4400 MB', 1000, env), true);
  assert.match(sent[0]!.url, /bottok\/sendMessage$/);
  assert.deepEqual(JSON.parse(sent[0]!.body), { chat_id: '42', text: 'CrownIQ: memory at 4400 MB' });
  assert.equal(await alertOwner('memory', 'again', 60_000, env), false, 'same kind within 3 hours: held');
  assert.equal(await alertOwner('lag', 'froze', 60_000, env), true, 'a different kind still goes');
  assert.equal(await alertOwner('memory', 'later', 1000 + 3 * 3600_000, env), true, 'after the cooldown it goes again');
  assert.equal(sent.length, 3);
});
