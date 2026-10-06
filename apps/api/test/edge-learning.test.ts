import assert from 'node:assert/strict';
import test from 'node:test';
import { bookWeight, learnBookWeights, setLearnedBookWeights } from '@crowniq/edge';
import { scoreEvent } from '../src/edge/book-weights.js';
import type { SnapshotRow } from '../src/edge/snapshots.js';

// Synthetic prices only.
test('book weights: a book far from the close loses weight, shrunk toward its prior; learned weights reach pricing', () => {
  const scores = [
    ...Array.from({ length: 400 }, (_, i) => ({ book: 'fanduel', sport: 'NBA', market: 'player_points', errorSd: (i % 2 ? 1 : -1) * .2 })),
    ...Array.from({ length: 400 }, (_, i) => ({ book: 'hardrock', sport: 'NBA', market: 'player_points', errorSd: (i % 2 ? 1 : -1) * .6 })),
  ];
  const learned = learnBookWeights(scores);
  const fanduel = learned.get('fanduel|NBA')!, hardrock = learned.get('hardrock|NBA')!;
  assert.ok(fanduel.weight > fanduel.prior && hardrock.weight < hardrock.prior);
  assert.ok(learned.has('fanduel|NBA:player_points'), 'a market with 300+ scores gets its own weight');
  assert.equal(learnBookWeights(scores.slice(0, 20)).size, 0, 'too few scores');
  setLearnedBookWeights(new Map([['hardrock|NBA', .2]]));
  try {
    assert.equal(bookWeight('hardrock', 'NBA', 'player_points'), .2);
    assert.equal(bookWeight('hardrock', 'NFL', 'player_rush_yds'), .5, 'the prior elsewhere');
  } finally { setLearnedBookWeights(new Map()); }
});

test('book weights: scoring compares each book’s price 3 hours out with the other books’ close', () => {
  const start = '2030-01-11T00:00:00.000Z', t0 = Date.parse(start);
  const row = (book: string, hoursBefore: number, number: number, side: 'MORE' | 'LESS'): SnapshotRow => ({
    observedAt: new Date(t0 - hoursBefore * 3600_000).toISOString(), source: 'sharpapi', platform: book, eventKey: 'e',
    playerKey: 'NBA|alpha guard', market: 'player_points', number, side, price: 1.91, startTime: start });
  const both = (book: string, hoursBefore: number, number: number) => [row(book, hoursBefore, number, 'MORE'), row(book, hoursBefore, number, 'LESS')];
  // Everyone closes at 24.5; DraftKings sat at 21.5 three hours out, the others already at 24.5.
  const rows = [...both('draftkings', 6, 21.5), ...both('fanduel', 6, 24.5), ...both('betrivers', 6, 24.5), ...both('hardrock', 6, 24.5),
    ...both('draftkings', 1, 24.5)].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const scores = scoreEvent(rows);
  const dk = scores.find((score) => score.book === 'draftkings')!, fd = scores.find((score) => score.book === 'fanduel')!;
  assert.ok(dk.errorSd < -.4, `DraftKings ${dk.errorSd}`);
  assert.ok(Math.abs(fd.errorSd) < .01);
});

test('Kelly: a game’s bets are scaled together to 6% of bankroll', async () => {
  const { capGameKelly } = await import('../src/edge/service.js');
  const pick = (id: string, eventId: string, kelly: number) => ({ lineId: id, eventId, kelly, rating: 'VALUE', warnings: [] as string[] });
  const picks = [pick('a', 'g1', .02), pick('b', 'g1', .02), pick('c', 'g1', .02), pick('d', 'g1', .02), pick('e', 'g2', .02)];
  capGameKelly(picks as never);
  assert.ok(Math.abs(picks.filter((item) => item.eventId === 'g1').reduce((sum, item) => sum + item.kelly, 0) - .06) < 1e-3);
  assert.equal(picks[4]!.kelly, .02);
  assert.match(picks[0]!.warnings[0]!, /cap is 6% per game/);
});
