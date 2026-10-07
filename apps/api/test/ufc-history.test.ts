import assert from 'node:assert/strict';
import test from 'node:test';
import { fightsFrom, roundsOf, ufcFantasy, UfcHistory, ufcValue } from '../src/ufc-history.js';

const row = { fullName: 'Yazmin Jauregui', fightHistory: [
  { result: 'win', eventDate: '2026-09-26', method: 'KO/TKO', round: 1, time: '1:02', knockdownsFor: 0, significantStrikesFor: 34,
    takedownsFor: 1, submissionsFor: 0 },
  { result: 'loss', eventDate: '2024-09-14', method: 'SUB', round: 1, time: '3:02', knockdownsFor: 0, significantStrikesFor: 35,
    takedownsFor: 0, submissionsFor: 0 },
  { result: 'win', eventDate: '2023-06-01', method: 'U-DEC', round: 3, time: '5:00', knockdownsFor: 1, significantStrikesFor: 80,
    takedownsFor: 2, submissionsFor: 1 },
  { result: 'nc', eventDate: '2022-01-01', method: 'Overturned', round: 2, time: '1:00', significantStrikesFor: 10 },
] };

test('UFC: PrizePicks’ MMA chart, rounds as a decimal, no-contests left out', () => {
  const fights = fightsFrom(row);
  assert.equal(fights.length, 3);
  // 34 strikes × 0.5 + 1 takedown × 5 + round-1 win 50.
  assert.equal(ufcFantasy(fights[0]!), 17 + 5 + 50);
  assert.equal(ufcFantasy(fights[1]!), 17.5, 'a loss earns no win bonus');
  assert.equal(ufcFantasy(fights[2]!), 40 + 10 + 4 + 10 + 10, 'decision win adds 10');
  assert.equal(roundsOf(fights[0]!), .207);
  assert.equal(roundsOf(fights[2]!), 3);
  assert.equal(ufcValue('total_rounds', fights[1]!), roundsOf(fights[1]!));
  assert.equal(ufcValue('significant_strikes', fights[2]!), 80);
  assert.equal(ufcValue('takedowns', fights[2]!), 2);
});

test('UFC: an unknown fighter is fetched once in the background, then read', async () => {
  let runs = 0;
  const history = new UfcHistory(async (input) => { runs++; assert.deepEqual(input, { lastName: 'Jauregui' }); return [row]; }, null);
  assert.equal(await history.values('Yazmin Jauregui', 'fantasy_score'), null, 'nothing yet: the fetch starts');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual((await history.values('Yazmin Jauregui', 'fantasy_score'))?.values.length, 3);
  assert.equal(runs, 1);
});
