import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgePick } from '@crowniq/contracts';
import { modePicks } from '../src/edge/routes.js';

const now = Date.parse('2026-10-13T16:00:00Z'); // noon Eastern
const pick = (over: Partial<EdgePick>): EdgePick => ({ lineId: 'l', playerId: 'p', playerName: 'P', side: 'MORE', probability: .75,
  lineType: 'REGULAR', tier: 'SHARP', eventStartTime: '2026-10-13T23:00:00Z',
  threshold: 20.5, fairLine: 22.5, edge: .1, sources: { market: { mean: 22.5, weight: .5, books: [] }, stats: null, ladder: null }, ...over } as EdgePick);

test('Streaks and Ladders keep only the day\'s backed 70%+ picks, one per player, surest first', () => {
  const picks = [pick({ lineId: 'a', playerId: '1', probability: .72 }), pick({ lineId: 'b', playerId: '1', probability: .81 }),
    pick({ lineId: 'c', playerId: '2', probability: .69 }), pick({ lineId: 'd', playerId: '3', side: 'LESS', probability: .78 }),
    pick({ lineId: 'e', playerId: '4', tier: 'LADDER', probability: .9 }), pick({ lineId: 'f', playerId: '5', eventStartTime: '2026-10-14T23:00:00Z' }),
    pick({ lineId: 'g', playerId: '6', lineType: 'GOBLIN', probability: .9 }), pick({ lineId: 'h', playerId: '7', eventStartTime: '2026-10-13T15:00:00Z' })];
  assert.deepEqual(modePicks(picks, 'streaks', now).map((item) => item.lineId), ['b', 'd']);
  assert.deepEqual(modePicks(picks, 'ladders', now).map((item) => item.lineId), ['b'], 'Ladders are More only');
});

test('Streaks and Ladders drop picks no sportsbook backs, model-ceiling 99%s, and numbers far off Edge\'s line', () => {
  const picks = [pick({ lineId: 'ok', playerId: '1' }),
    pick({ lineId: 'stats', playerId: '2', sources: { market: null, stats: null, ladder: null } as EdgePick['sources'] }),
    pick({ lineId: 'noedge', playerId: '3', edge: null }), pick({ lineId: 'ceiling', playerId: '4', side: 'LESS', probability: .99 }),
    pick({ lineId: 'far', playerId: '5', threshold: 25.5, fairLine: 38.5, probability: .95 })];
  assert.deepEqual(modePicks(picks, 'streaks', now).map((item) => item.lineId), ['ok']);
});
