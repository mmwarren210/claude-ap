import assert from 'node:assert/strict';
import test from 'node:test';
import type { Analysis, PropLine } from '@crowniq/contracts';
import { fixtureAnalysis, fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { bookPicks, impliedChance } from '../src/book-picks.js';
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
  assert.equal(asked.length, 3, 'only lines with a PrizePicks match are scored');
  assert.ok(asked.every((line) => line.availableDirections.length === 2 && line.lineType === 'REGULAR'));
  assert.equal(picks.length, 1, 'PASS left out; one pick per player and stat');
  const [pick] = picks;
  assert.deepEqual([pick!.line, pick!.side, pick!.gkr.score, pick!.american, pick!.fairChance], [235.5, 'MORE', 88, -125, 0.55]);
  assert.deepEqual(pick!.otherBook, { book: 'hardrock', american: -120 });
  assert.deepEqual(pick!.prizePicks, { line: 240.5, lineType: 'REGULAR', sides: ['MORE', 'LESS'],
    gkr: { direction: 'MORE', score: 85, reasonCode: null } });
  assert.equal(impliedChance(-125), 0.5556);
  assert.equal(impliedChance(150), 0.4);
  assert.equal(bookPicks('draftkings', prices, board, new Map(), score, new Date('2030-09-26T00:00:00Z')).length, 0, 'started games drop');
});
