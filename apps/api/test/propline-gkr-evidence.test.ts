import assert from 'node:assert/strict';
import test from 'node:test';
import { PropLineGkrEvidence } from '../src/propline-gkr-evidence.js';
import type { PropLineHistory } from '../src/propline-history.js';

const target = { eventId: 'e', eventName: 'A @ B', eventStartTime: '2030-10-12T00:00:00Z', league: 'NFL', playerId: 'p', playerName: 'Test QB',
  team: null, opponent: null, market: 'passing_yards', sport: 'NFL', threshold: 240.5 } as never;

test('PropLine box scores become GKR evidence for approved stats only, never for a player still loading', async () => {
  let answer: unknown = { values: [250, 231, 270, 244, 262, 238], source: 'PropLine box scores' };
  const history = { values: async () => answer } as unknown as PropLineHistory;
  const adapter = new PropLineGkrEvidence(history, ['NFL:passing_yards'], () => new Date('2030-10-11T00:00:00Z'));
  const evidence = await adapter.research([target]);
  assert.ok(evidence.length > 0, 'six games give evidence');
  assert.ok(evidence.every((item) => JSON.stringify(item).includes('PropLine')));
  assert.equal((await adapter.research([{ ...(target as object), market: 'player_rush_yds' } as never])).length, 0, 'unapproved stat');
  answer = 'PENDING';
  assert.equal((await adapter.research([target])).length, 0);
  assert.equal(adapter.getHealth().noSources, 1);
});
