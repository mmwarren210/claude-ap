import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoardResponse } from '@crowniq/contracts';
import { boardForModel, cardModel, gkr2Note, gkr2Rankings } from '../src/gkr2.js';
import type { Gkr2Read } from '../src/gkr2.js';

const line = (id: string) => ({ id, playerId: 'p' + id, playerName: 'P ' + id, sport: 'NHL', league: 'NHL', eventId: 'e', eventName: 'A @ B',
  eventStartTime: '2030-01-01T00:00:00Z', team: null, opponent: null, market: 'points', threshold: 0.5, lineType: 'REGULAR' });
const analysis = (lineId: string, direction: string, score: number | null) => ({ lineId, direction, score, scoreBand: score ? 'PLAYABLE' : 'PASS',
  evidenceQuality: 'MEDIUM' });
const board = { board: { lines: [line('a'), line('b'), line('c')] }, analyses: [analysis('a', 'MORE', 82), analysis('b', 'PASS', null),
  analysis('c', 'LESS', 75)], rankedLineIds: ['a'], builtAt: 'x' } as unknown as BoardResponse;
const reads = new Map<string, Gkr2Read>([['a', { direction: 'LESS', score: 81, why: 'They take opposite sides.' }],
  ['b', { direction: 'MORE', score: 90, why: 'GKR passes on this line.' }]]);

test('GKR 2 mode puts GKR 2\'s sides and scores on the board and ranks by them; GKR mode is untouched', () => {
  assert.equal(boardForModel(board, 'GKR', reads), board);
  const two = boardForModel(board, 'GKR2', reads);
  assert.deepEqual(two.analyses.map((item) => [item.direction, item.score]), [['LESS', 81], ['MORE', 90], ['PASS', null]]);
  assert.deepEqual(two.rankedLineIds, ['b', 'a']);
  assert.equal(two.analyses[1]!.scoreBand, 'CROWN_STRONG');
});

test('Both keeps GKR\'s plays and fills lines GKR passes with GKR 2 (labeled), with why they differ', () => {
  const both = boardForModel(board, 'BOTH', reads);
  assert.deepEqual(both.analyses.map((item) => [item.direction, item.score]), [['MORE', 82], ['MORE', 90], ['LESS', 75]]);
  assert.equal(cardModel('BOTH', board.analyses[0], reads.get('a')), 'GKR');
  assert.equal(cardModel('BOTH', board.analyses[1], reads.get('b')), 'GKR2');
  assert.match(gkr2Note(reads.get('a'), 'GKR')!, /GKR 2 \(Beta\) LESS 81\. They take opposite sides/);
});

test('GKR 2\'s Top Picks are its 80+ plays, best first', () => {
  assert.deepEqual(gkr2Rankings(board, reads, 0).map((card) => [card.lineId, card.rank, card.direction]), [['b', 1, 'MORE'], ['a', 2, 'LESS']]);
});

test('All agree keeps only Streaks and Ladders picks every model backs on the same side', async () => {
  const { allAgree } = await import('../src/gkr2.js');
  const reads = { gkr: { side: 'MORE', score: 80 }, gkr2: { side: 'MORE', score: 85 }, gkrPlus: { side: 'MORE', probability: .8 } };
  assert.equal(allAgree({ side: 'MORE', reads } as never), true);
  assert.equal(allAgree({ side: 'MORE', reads: { ...reads, gkr2: { side: 'LESS', score: 70 } } } as never), false);
  assert.equal(allAgree({ side: 'MORE', reads: { ...reads, gkr: null } } as never), false);
});
