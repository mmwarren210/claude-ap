import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgePick } from '@crowniq/contracts';
import { searchPicks } from '../src/edge/service.js';
import type { EdgeSnapshot } from '../src/edge/service.js';

const now = Date.parse('2030-10-07T17:00:00Z');
const pick = (lineId: string, playerName: string, edge: number | null, start = '2030-10-08T00:00:00Z') =>
  ({ lineId, playerName, edge, probability: .55, eventStartTime: start }) as unknown as EdgePick;

test('player search finds every upcoming line for the name, plays or not, strongest edge first', () => {
  const byLine = new Map([['a', pick('a', 'Jaylen Bonelli', .02)], ['b', pick('b', 'Jaylen Bonelli', null)],
    ['c', pick('c', 'Jaylen Bonelli', .09)], ['d', pick('d', 'Someone Else', .2)],
    ['e', pick('e', 'Jaylen Bonelli', .3, '2030-10-07T16:00:00Z')]]);
  const snapshot = { byLine } as unknown as EdgeSnapshot;
  assert.deepEqual(searchPicks(snapshot, 'bonelli', now, 50).map((item) => item.lineId), ['c', 'a', 'b'], 'started game left out');
  assert.deepEqual(searchPicks(snapshot, 'JAYLEN B', now, 1).map((item) => item.lineId), ['c']);
  assert.equal(searchPicks(snapshot, 'j', now, 50).length, 0, 'one letter is too short to search');
});
