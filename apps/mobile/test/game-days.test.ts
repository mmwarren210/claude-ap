import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chosenDay, dayKey, dayLabel, gameDays, onDay } from '../src/game-days.js';

const at = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h).toISOString();
const now = new Date(2026, 9, 5, 10).getTime();

test('game days: upcoming local days, soonest first', () => {
  const starts = [at(2026, 10, 9, 19), at(2026, 10, 5, 8), at(2026, 10, 5, 19), at(2026, 10, 6, 13), at(2026, 10, 9, 20)];
  assert.deepEqual(gameDays(starts, now), ['2026-10-05', '2026-10-06', '2026-10-09']);
});

test('game days: defaults to today, else the soonest day; ALL means every day', () => {
  assert.equal(chosenDay(null, ['2026-10-05', '2026-10-09'], now), '2026-10-05');
  assert.equal(chosenDay(null, ['2026-10-09'], now), '2026-10-09');
  assert.equal(chosenDay('2026-10-09', ['2026-10-05', '2026-10-09'], now), '2026-10-09');
  assert.equal(chosenDay('2026-10-07', ['2026-10-05'], now), '2026-10-05');
  assert.equal(chosenDay('ALL', ['2026-10-05'], now), null);
  assert.equal(chosenDay(null, [], now), null);
});

test('game days: labels and filter', () => {
  assert.equal(dayLabel('2026-10-05', now), 'Today');
  assert.equal(dayLabel('2026-10-06', now), 'Tomorrow');
  assert.match(dayLabel('2026-10-09', now), /Fri.*Oct.*9/);
  assert.equal(onDay('2026-10-09', at(2026, 10, 9, 23)), true);
  assert.equal(onDay('2026-10-09', at(2026, 10, 5, 19)), false);
  assert.equal(onDay(null, at(2026, 10, 5, 19)), true);
  assert.equal(dayKey(at(2026, 10, 9, 23)), '2026-10-09');
});
