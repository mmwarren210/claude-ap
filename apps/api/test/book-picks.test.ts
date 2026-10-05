import assert from 'node:assert/strict';
import test from 'node:test';
import type { Analysis, PropLine } from '@crowniq/contracts';
import { fixtureAnalysis, fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { bookLadder, bookPicks, impliedChance, mainLines } from '../src/book-picks.js';
import type { FairPrice } from '../src/context/sharp-props.js';

const now = new Date('2030-09-24T12:00:00Z');
const price = (book: string, player: string, line: number, fairOver: number, over: number, under: number): FairPrice => ({
  book, sport: 'NFL', player, market: 'passing_yards', line, fairOver, overAmerican: over, underAmerican: under,
  startTime: '2030-09-25T00:00:00Z', home: null, away: null });

test('book picks: GKR side at the book number, no PASS, one per player and stat, with both books prices', () => {
  const board = [fixtureLine({ id: 'pp-a', playerId: 'a', playerName: 'José Allen', threshold: 240.5 }),
    fixtureLine({ id: 'pp-b', playerId: 'b', playerName: 'Bo Pass', threshold: 200.5 })];
  const prices = [price('draftkings', 'Jose Allen', 235.5, 0.55, -125, 105), price('draftkings', 'Jose Allen', 245.5, 0.48, 100, -120),
    price('hardrock', 'Jose Allen', 235.5, 0.54, -120, 100), price('draftkings', 'Bo Pass', 199.5, 0.5, -110, -110),
    price('draftkings', 'Nobody Here', 10.5, 0.5, -110, -110)];
  const asked: PropLine[] = [];
  // GKR: MORE on Allen, higher at the lower number; PASS on Bo Pass.
  const score = (lines: readonly PropLine[]): Analysis[] => lines.map((line) => { asked.push(line);
    return line.playerId === 'b' ? { ...fixtureAnalysis(line), direction: 'PASS', score: null }
      : fixtureAnalysis(line, 'MORE', line.threshold < 240 ? 88 : 82); });
  const picks = bookPicks('draftkings', prices, board, new Map([['pp-a', fixtureAnalysis(board[0]!, 'MORE', 85)]]), score, now);
  assert.equal(asked.length, 2, 'only main lines with a PrizePicks match are scored (DraftKings 245.5 is closer to 50/50)');
  assert.ok(asked.every((line) => line.availableDirections.length === 2 && line.lineType === 'REGULAR'));
  assert.equal(picks.length, 1, 'PASS left out; one pick per player and stat');
  const [pick] = picks;
  assert.deepEqual([pick!.line, pick!.side, pick!.gkr.score, pick!.american, pick!.fairChance], [245.5, 'MORE', 82, 100, 0.48]);
  assert.equal(pick!.otherBook, null, 'Hard Rock has no 245.5');
  assert.deepEqual(pick!.prizePicks, { line: 240.5, lineType: 'REGULAR', sides: ['MORE', 'LESS'],
    gkr: { direction: 'MORE', score: 85, reasonCode: null } });
  assert.equal(pick!.pricey, false, '+100 needs 50%');
  assert.equal(impliedChance(-125), 0.5556);
  assert.ok(impliedChance(-150)! >= 0.6, '-150 is the pricey line');
  assert.equal(impliedChance(150), 0.4);
  assert.equal(bookPicks('draftkings', prices, board, new Map(), score, new Date('2030-09-26T00:00:00Z')).length, 0, 'started games drop');
});

test('main lines and the ladder: Hard Rock alternates for GKR side, easier numbers first, each scored by GKR', () => {
  const line = fixtureLine({ id: 'pp-a', playerId: 'a', playerName: 'Jose Allen', threshold: 240.5 });
  const ladder = [220.5, 225.5, 230.5, 235.5, 240.5, 245.5, 250.5, 255.5, 260.5].map((value, index) =>
    price('hardrock', 'Jose Allen', value, 0.75 - index * 0.05, -300 + index * 50, 200 - index * 40));
  const prices = [...ladder, price('draftkings', 'Jose Allen', 240.5, 0.52, -115, -105)];
  assert.deepEqual(mainLines(prices).map((item) => [item.book, item.line]), [['hardrock', 245.5], ['draftkings', 240.5]]);
  // GKR backs MORE up to 245.5, scoring higher on easier numbers.
  const score = (lines: readonly PropLine[]): Analysis[] => lines.map((item) => item.threshold <= 245.5
    ? fixtureAnalysis(item, 'MORE', 90 - (item.threshold - 220.5)) : { ...fixtureAnalysis(item), direction: 'PASS', score: null });
  const rows = bookLadder(line, 'MORE', prices, score);
  assert.deepEqual([...new Set(rows.map((row) => row.line))], [220.5, 225.5, 230.5, 235.5, 240.5, 245.5, 250.5],
    'four easier, the same number, two harder; 255.5 and 260.5 are left out');
  const at = (book: string, value: number) => rows.find((row) => row.book === book && row.line === value)!;
  assert.deepEqual([at('hardrock', 230.5).gkr, at('hardrock', 230.5).american, at('hardrock', 230.5).pricey], [80, -200, true]);
  assert.equal(at('hardrock', 250.5).gkr, null, 'GKR does not back More at 250.5');
  assert.equal(at('hardrock', 245.5).main, true);
  assert.equal(at('draftkings', 240.5).main, true);
  assert.deepEqual(bookLadder(fixtureLine({ playerName: 'Nobody' }), 'MORE', prices, score), []);
});
