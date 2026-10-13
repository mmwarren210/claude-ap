import assert from 'node:assert/strict';
import test from 'node:test';
import { gameOf, gradeFromBoxScores, marketKeysFor } from '../src/tip-box-grade.js';
import type { PropLineHistory } from '../src/propline-history.js';
import type { Tip } from '../src/tips.js';

const tip = (over: Partial<Tip>): Tip => ({ id: 't1', text: '', sport: 'MLB', league: 'MLB', selection: 'Jacob Misiorowski', opponent: 'Dodgers',
  market: 'PLAYER_PROP', line: 7.5, side: 'UNDER', stat: 'Pitcher Strikeouts', odds: null, eventDate: '2026-10-11', status: 'PENDING',
  gradedAt: null, gradedBy: null, result: null, market_read: null, createdAt: '2026-10-11T19:43:00.000Z', ...over } as unknown as Tip);
const games = [
  { at: '2026-10-08T23:00:00.000Z', opponent: null, home: 'Brewers', away: 'Cubs', stats: { strikeouts: 11, outs: 18, pitcher_started: 1 } },
  { at: '2026-10-12T00:00:00.000Z', opponent: null, home: 'Brewers', away: 'Dodgers', stats: { strikeouts: 6, outs: 17, pitcher_started: 1 } }];
const history = (found: unknown) => ({ gamesFor: async () => found }) as unknown as PropLineHistory;

test('a Vetted player prop grades from the player’s box score on the pick’s date', async () => {
  assert.ok(marketKeysFor('Pitcher Strikeouts').includes('pitcher_strikeouts'));
  assert.equal(gameOf(tip({}) as never, games)?.at, '2026-10-12T00:00:00.000Z', 'an evening game lands on the next UTC day');
  const [graded] = await gradeFromBoxScores([tip({})], history(games), new Date('2026-10-12T14:00:00Z'));
  assert.equal(graded?.status, 'WON', '6 strikeouts, UNDER 7.5');
  assert.match(graded!.result, /had 6 pitcher strikeouts/);
  const [push] = await gradeFromBoxScores([tip({ line: 6, side: 'OVER' })], history(games), new Date('2026-10-12T14:00:00Z'));
  assert.equal(push?.status, 'PUSH');
});

test('no game yet stays pending; no game three days later is VOID; a moneyline is left for the web grader', async () => {
  const now = new Date('2026-10-12T14:00:00Z');
  assert.deepEqual(await gradeFromBoxScores([tip({ eventDate: '2026-10-13' })], history(games), now), []);
  const [voided] = await gradeFromBoxScores([tip({ eventDate: '2026-10-01' })], history(games), now);
  assert.equal(voided?.status, 'VOID');
  assert.deepEqual(await gradeFromBoxScores([tip({ market: 'MONEYLINE' })], history(games), now), []);
  assert.deepEqual(await gradeFromBoxScores([tip({ stat: 'Fantasy Score' })], history(games), now), [], 'no box-score stat for it');
});

test('a player log cached before the game finished is asked again', async () => {
  // The first answer is a copy from before Sunday night's start; asking again (fresh) brings the game.
  const asked: (number | undefined)[] = [];
  const stale = { gamesFor: async (_line: unknown, _wait: number, freshSince?: number) => { asked.push(freshSince); return freshSince ? games : games.slice(0, 1); } } as unknown as PropLineHistory;
  const now = new Date('2026-10-12T17:30:00Z');
  const [graded] = await gradeFromBoxScores([tip({ eventDate: null })], stale, now);
  assert.equal(graded?.status, 'WON');
  assert.deepEqual(asked, [undefined, now.getTime() - 2 * 3600_000]);
});

test('code check: a namesake on another team, or a tip with no team at all, is never graded from the box score', async () => {
  const now = new Date('2026-10-12T14:00:00Z');
  assert.deepEqual(await gradeFromBoxScores([tip({ opponent: 'Cubs' })], history(games), now), [], 'that game was against the Dodgers');
  assert.deepEqual(await gradeFromBoxScores([tip({ opponent: null })], history(games), now), [], 'no team: the web grader decides');
  assert.deepEqual(await gradeFromBoxScores([tip({ opponent: null, eventDate: '2026-10-01' })], history(games), now), [], 'and no VOID');
  const [byEvent] = await gradeFromBoxScores([tip({ opponent: null, analysis: { event: 'Dodgers @ Brewers' } } as never)], history(games), now);
  assert.equal(byEvent?.status, 'WON', 'the read\'s game names both teams');
});

test('code check: a game known not to have finished is not asked about', async () => {
  let asked = 0;
  const counting = { gamesFor: async () => { asked++; return games; } } as unknown as PropLineHistory;
  await gradeFromBoxScores([tip({ analysis: { start: '2026-10-12T23:00:00Z' } } as never)], counting, new Date('2026-10-12T14:00:00Z'));
  assert.equal(asked, 0);
});
