import assert from 'node:assert/strict';
import test from 'node:test';
import type { Analysis, PropLine } from '@crowniq/contracts';
import { fixtureAnalysis, fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { bookLadder, bookLines, bookPicks, impliedChance, mainLines } from '../src/book-picks.js';
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
  assert.deepEqual([pick!.line, pick!.side, pick!.gkr!.score, pick!.american, pick!.fairChance], [245.5, 'MORE', 82, 100, 0.48]);
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

test('DraftKings picks point to an easier Hard Rock number: lower for Over, the easiest one not pricey', () => {
  const board = [fixtureLine({ id: 'pp-a', playerId: 'a', playerName: 'Jose Allen', threshold: 250.5 })];
  const prices = [price('draftkings', 'Jose Allen', 250.5, 0.5, -110, -110),
    price('hardrock', 'Jose Allen', 235.5, 0.65, -170, 140), price('hardrock', 'Jose Allen', 240.5, 0.6, -140, 115),
    price('hardrock', 'Jose Allen', 245.5, 0.55, -120, 100), price('hardrock', 'Jose Allen', 255.5, 0.45, 110, -135)];
  const more = (lines: readonly PropLine[]) => lines.map((item) => fixtureAnalysis(item, 'MORE', 85));
  const [pick] = bookPicks('draftkings', prices, board, new Map(), more, now);
  assert.deepEqual(pick!.altLine, { book: 'hardrock', line: 240.5, american: -140 }, '235.5 at -170 needs 63%: pricey');
  const less = (lines: readonly PropLine[]) => lines.map((item) => fixtureAnalysis(item, 'LESS', 85));
  assert.deepEqual(bookPicks('draftkings', prices, board, new Map(), less, now)[0]!.altLine,
    { book: 'hardrock', line: 255.5, american: -135 }, 'Under: a higher number');
});

test('book picks without GKR: the History Read at the book number, then Value against the other book, even off PrizePicks', () => {
  const board = [fixtureLine({ id: 'pp-b', playerId: 'b', playerName: 'Bo Pass', threshold: 200.5 })];
  const prices = [price('draftkings', 'Bo Pass', 199.5, 0.5, -110, -110),
    price('draftkings', 'Val Edge', 50.5, 0.47, 120, -145), price('hardrock', 'Val Edge', 50.5, 0.52, -108, -112),
    price('draftkings', 'Even Steven', 30.5, 0.5, -110, -110), price('hardrock', 'Even Steven', 30.5, 0.5, -110, -110)];
  const pass = (lines: readonly PropLine[]): Analysis[] => lines.map((line) => ({ ...fixtureAnalysis(line), direction: 'PASS', score: null }));
  const boLine = bookLines('draftkings', prices, board, now).find((item) => item.price.player === 'Bo Pass')!.line;
  const history = new Map([[boLine.id, { side: 'LESS' as const, score: 64, note: 'History: Over in 3 of last 10' }]]);
  const lineIds = new Map<string, PropLine>();
  const picks = bookPicks('draftkings', prices, board, new Map(), pass, now, undefined, lineIds, history);
  const bo = picks.find((pick) => pick.playerName === 'Bo Pass'), val = picks.find((pick) => pick.playerName === 'Val Edge');
  assert.ok(bo, `history pick keyed by the line id; ids: ${[...lineIds.keys()].join(', ')}`);
  assert.deepEqual([bo!.by, bo!.side, bo!.score, bo!.gkr], ['HISTORY', 'LESS', 64, null]);
  assert.deepEqual([val!.by, val!.side, val!.score, val!.prizePicks], ['VALUE', 'MORE', 52, null],
    'DraftKings +120 needs 45%; Hard Rock’s fair Over is 52%; Val Edge isn’t on PrizePicks');
  assert.ok(!picks.some((pick) => pick.playerName === 'Even Steven'), 'no edge, no history: no pick');
  assert.deepEqual(picks.map((pick) => pick.by), ['HISTORY', 'VALUE'], 'History before Value');
});

test('a pricey pick points to a harder number at a fairer price: higher for Over, lower for Under', () => {
  const board = [fixtureLine({ id: 'pp-a', playerId: 'a', playerName: 'Jose Allen', threshold: 240.5 })];
  const prices = [price('draftkings', 'Jose Allen', 240.5, 0.5, -170, 135), price('hardrock', 'Jose Allen', 245.5, 0.47, -115, -105),
    price('hardrock', 'Jose Allen', 260.5, 0.3, 140, -170)];
  const more = (lines: readonly PropLine[]): Analysis[] => lines.map((line) => fixtureAnalysis(line, 'MORE', 85));
  const [pick] = bookPicks('draftkings', prices, board, new Map(), more, now);
  assert.equal(pick!.pricey, true, '-170 needs 63%');
  assert.deepEqual(pick!.fairerLine, { book: 'hardrock', line: 245.5, american: -115 }, 'the nearest higher number under 60%');
  const cheap = bookPicks('draftkings', [price('draftkings', 'Jose Allen', 240.5, 0.5, -110, -110)], board, new Map(), more, now);
  assert.equal(cheap[0]!.fairerLine, null, 'not pricey: nothing to point to');
});

test('over-only book props (no under) become History picks on More only; no fair chance is made up', () => {
  const offer = (line: number, priceValue: number) => ({ book: 'draftkings', sport: 'NFL' as const, player: 'Shot Taker', market: 'passing_yards',
    line, price: priceValue, american: priceValue > 0.5 ? -150 : 110, startTime: '2030-09-25T00:00:00Z', home: null, away: null });
  const offers = [offer(1.5, 0.48), offer(2.5, 0.3)];
  const pass = (lines: readonly PropLine[]): Analysis[] => lines.map((line) => ({ ...fixtureAnalysis(line), direction: 'PASS', score: null }));
  const lines = bookLines('draftkings', [], [], now, offers);
  assert.equal(lines.length, 1, 'one per player and stat: the number priced closest to even');
  assert.deepEqual([lines[0]!.line.threshold, lines[0]!.line.availableDirections], [1.5, ['MORE']]);
  const history = new Map([[lines[0]!.line.id, { side: 'MORE' as const, score: 63, note: 'History: Over in 7 of last 10' }]]);
  const [pick] = bookPicks('draftkings', [], [], new Map(), pass, now, undefined, undefined, history, offers);
  assert.deepEqual([pick!.by, pick!.side, pick!.line, pick!.american, pick!.fairChance], ['HISTORY', 'MORE', 1.5, 110, null]);
});
