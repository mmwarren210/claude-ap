import assert from 'node:assert/strict';
import test from 'node:test';
import { PropLineAccuracy, scoreGame } from '../src/edge/propline-accuracy.js';
import type { PropLineClient } from '../src/scrapers/propline.js';

const results = { status: 'final', bookmakers: [{ key: 'pinnacle', markets: [{ key: 'player_pass_yds', outcomes: [
  { name: 'Over', description: 'Test QB', point: 245.5, price: 2500, actual_value: 280 }] }] }] };
const closing = { bookmakers: ['pinnacle', 'kalshi'].map((key) => ({ key, markets: [{ key: 'player_pass_yds', outcomes: [
  { name: 'Over', description: 'Test QB', point: key === 'pinnacle' ? 250.5 : 230.5, price: -110 },
  { name: 'Under', description: 'Test QB', point: key === 'pinnacle' ? 250.5 : 230.5, price: -110 },
  { name: 'Over', description: 'Test QB', point: 300.5, price: 400 }, { name: 'Under', description: 'Test QB', point: 300.5, price: -600 },
  { name: '250+ Passing Yards', description: 'Test QB', point: null, price: -150 }] }] })) };

test('each book is scored on its closing main line against the actual stat; in-game prices and ladders are ignored', () => {
  const scores = scoreGame('football_nfl', results, closing);
  assert.deepEqual(scores.map((score) => score.book), ['pinnacle', 'kalshi'], 'one main line per book');
  const [pinnacle, kalshi] = scores;
  assert.ok(pinnacle!.errorSd < 0 && kalshi!.errorSd < pinnacle!.errorSd, 'both under 280; Kalshi at 230.5 further off');
  assert.equal(pinnacle!.sport, 'NFL');
  assert.deepEqual(scoreGame('football_nfl', { ...results, status: 'in_progress' }, closing), [], 'unfinished games wait');
});

test('a run scores finished games once, skips upcoming ones and reports accuracy per book', async () => {
  const asked: string[] = [];
  const client = {
    propMarkets: async () => new Map([['football_nfl', ['player_pass_yds']]]),
    get: async (path: string) => { asked.push(path);
      if (path.includes('/scores')) return [{ id: 1, status: 'final' }, { id: 2, status: 'upcoming' }];
      if (path.includes('/results')) return results;
      return closing; },
  } as unknown as PropLineClient;
  const accuracy = new PropLineAccuracy(client, null);
  assert.equal(await accuracy.refresh(), 1);
  assert.equal(await accuracy.refresh(), 0, 'already scored');
  assert.ok(!asked.some((path) => path.includes('/events/2/')));
  const report = await accuracy.report() as { books: Record<string, { props: number }> };
  assert.deepEqual(Object.keys(report.books), ['kalshi|NFL', 'pinnacle|NFL']);
  assert.equal((await accuracy.scores()).length, 2);
});
