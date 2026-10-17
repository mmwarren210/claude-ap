import assert from 'node:assert/strict';
import test from 'node:test';
import { throttledSave } from '../src/throttled-save.js';

test('a big store saves at once the first time, then at most once per window, with the latest data', async () => {
  let now = 0, saves = 0;
  const saver = throttledSave(async () => { saves++; }, 60_000, () => now);
  await saver.save();
  assert.equal(saves, 1, 'first save goes straight out');
  now = 1000; await saver.save(); now = 2000; await saver.save();
  assert.equal(saves, 1, 'saves inside the window wait');
  await saver.flush();
  assert.equal(saves, 2, 'one catch-up save covers them all');
  now = 70_000; await saver.save();
  assert.equal(saves, 3, 'after the window a save goes straight out again');
});

test('board rebuilds after pushed line moves come at most once per window', async () => {
  let now = 0, rebuilds = 0;
  const saver = throttledSave(async () => { rebuilds++; }, 5 * 60_000, () => now);
  for (let second = 0; second < 120; second += 5) { now = second * 1000; await saver.save(); }
  assert.equal(rebuilds, 1, 'two minutes of pushes: one rebuild now, the rest wait for the window');
  await saver.flush();
  assert.equal(rebuilds, 2);
});
