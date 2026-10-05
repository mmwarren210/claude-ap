import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { HistoryReads, historyRead } from '../src/history-read.js';

const line = (threshold: number, lineType: 'REGULAR' | 'GOBLIN' | 'DEMON' = 'REGULAR', sides: ('MORE' | 'LESS')[] = ['MORE', 'LESS']) =>
  ({ threshold, lineType, availableDirections: sides });

test('History Read: over rate and average decide; books blend in; Goblins need more; too little history is no read', () => {
  const values = [7, 6, 8, 4, 7, 9, 6, 7, 5, 8];
  const read = historyRead(line(5.5), values, null, 'CrownIQ history')!;
  assert.deepEqual([read.direction, read.over, read.games, read.average], ['MORE', 8, 10, 6.7]);
  assert.equal(read.score, 75, '(8+1)/(10+2)');
  assert.equal(read.text, 'Over in 8 of last 10 · avg 6.7 vs 5.5');
  const withBooks = historyRead(line(5.5), values, 0.45, 'CrownIQ history')!;
  assert.equal(withBooks.score, 60, 'averaged with the books’ 45%');
  assert.match(withBooks.text, /books 45% over/);
  assert.equal(historyRead(line(5.5, 'GOBLIN', ['MORE']), values, null, 'h')!.direction, 'MORE', '75% clears the Goblin bar of 72%');
  const goblinLean = historyRead(line(5.5, 'GOBLIN', ['MORE']), [7, 6, 8, 4, 7, 9, 6, 3, 5, 8], null, 'h')!;
  assert.deepEqual([goblinLean.direction, goblinLean.lean], ['MORE', true], '67% misses the Goblin bar but leans');
  const regularLean = historyRead(line(5.5), [7, 6, 4, 4, 7, 9, 6, 3, 5, 8], null, 'h')!;
  assert.deepEqual([regularLean.direction, regularLean.lean, regularLean.score], ['MORE', true, 58], '58% leans MORE');
  assert.equal(historyRead(line(5.5), values, null, 'h')!.lean, undefined, 'a play is not a lean');
  const low = historyRead(line(8.5), values, null, 'h')!;
  assert.deepEqual([low.direction, low.score], ['LESS', 83]);
  assert.equal(historyRead(line(8.5, 'REGULAR', ['MORE']), values, null, 'h')!.direction, 'PASS', 'LESS only where the line offers it');
  assert.equal(historyRead(line(6.5), [7, 6, 7, 6, 7, 6], null, 'h')!.direction, 'PASS', 'a coin flip is no edge');
  assert.equal(historyRead(line(5.5), [7, 6, 8, 4], null, 'h'), null, 'fewer than five games');
});

test('History Reads look each player and stat up once, skip started games, and leave out lines with no history', async () => {
  let lookups = 0;
  const reads = new HistoryReads(async (item) => { lookups++; return item.playerId === 'known' ? { values: [3, 4, 5, 4, 6, 5], source: 'h' } : null; },
    () => new Date('2030-09-24T12:00:00Z'));
  const lines = [fixtureLine({ id: 'a', playerId: 'known', threshold: 2.5, eventStartTime: '2030-09-24T20:00:00Z', availableDirections: ['MORE', 'LESS'] }),
    fixtureLine({ id: 'b', playerId: 'known', threshold: 3.5, eventStartTime: '2030-09-24T20:00:00Z', availableDirections: ['MORE', 'LESS'] }),
    fixtureLine({ id: 'c', playerId: 'unknown', eventStartTime: '2030-09-24T20:00:00Z' }),
    fixtureLine({ id: 'd', playerId: 'known', eventStartTime: '2030-09-24T10:00:00Z' })];
  const out = await reads.readsFor(lines);
  assert.deepEqual([...out.keys()], ['a', 'b']);
  assert.equal(lookups, 2, 'one lookup per player and stat');
  assert.equal(out.get('a')?.direction, 'MORE');
});
