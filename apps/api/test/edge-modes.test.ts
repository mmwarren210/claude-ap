import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgePick } from '@crowniq/contracts';
import { modePicks } from '../src/edge/routes.js';

const now = Date.parse('2026-10-13T16:00:00Z'); // noon Eastern
const pick = (over: Partial<EdgePick>): EdgePick => ({ lineId: 'l', playerId: 'p', playerName: 'P', side: 'MORE', probability: .75,
  lineType: 'REGULAR', tier: 'SHARP', eventStartTime: '2026-10-13T23:00:00Z', ...over } as EdgePick);

test('Streaks and Ladders keep only the day\'s backed 70%+ picks, one per player, surest first', () => {
  const picks = [pick({ lineId: 'a', playerId: '1', probability: .72 }), pick({ lineId: 'b', playerId: '1', probability: .81 }),
    pick({ lineId: 'c', playerId: '2', probability: .69 }), pick({ lineId: 'd', playerId: '3', side: 'LESS', probability: .78 }),
    pick({ lineId: 'e', playerId: '4', tier: 'LADDER', probability: .9 }), pick({ lineId: 'f', playerId: '5', eventStartTime: '2026-10-14T23:00:00Z' }),
    pick({ lineId: 'g', playerId: '6', lineType: 'GOBLIN', probability: .9 }), pick({ lineId: 'h', playerId: '7', eventStartTime: '2026-10-13T15:00:00Z' })];
  assert.deepEqual(modePicks(picks, 'streaks', now).map((item) => item.lineId), ['b', 'd']);
  assert.deepEqual(modePicks(picks, 'ladders', now).map((item) => item.lineId), ['b'], 'Ladders are More only');
});
