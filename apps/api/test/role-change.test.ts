import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyRead, roleChange, roleShift } from '../src/history-read.js';

test('role change passes a LESS after two big games (Patterson: 7, 3, 0 then 16, 18 vs 16.5)', () => {
  const values = [18, 16, 0, 3, 7, 4, 2, 5, 3, 6];
  assert.match(roleChange(16.5, values, 'LESS') ?? '', /Role change/);
  assert.equal(roleChange(16.5, values, 'MORE'), null);
  assert.equal(roleShift(values), true);
  const read = historyRead({ threshold: 16.5, lineType: 'REGULAR', availableDirections: ['MORE', 'LESS'] }, values, null, 'test');
  assert.equal(read?.direction, 'PASS');
});

test('role change passes a MORE after two tiny games, and ignores normal swings', () => {
  assert.ok(roleChange(60.5, [10, 5, 80, 75, 90, 70, 85], 'MORE'));
  assert.equal(roleChange(16.5, [17, 18, 14, 15, 13, 16, 12], 'LESS'), null);
  assert.equal(roleShift([17, 18, 14, 15, 13, 16, 12]), false);
  assert.equal(roleChange(16.5, [18, 16, 0, 3], 'LESS'), null);
});
