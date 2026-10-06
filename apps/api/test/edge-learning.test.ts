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

test('free-history grading: one tennis match in the window; esports maps 1+2 sum the first two maps; ambiguity stays pending', async () => {
  const { freeHistoryActual } = await import('../src/edge/service.js');
  const start = '2030-10-07T15:00:00Z';
  const match = (date: string, value: number) => ({ date, value });
  assert.equal(freeHistoryActual({ eventStartTime: start, market: 'total_games_won' },
    { values: [match('2030-10-07T15:10:00Z', 11), match('2030-10-03T12:00:00Z', 8)], perMap: false }), 11);
  assert.equal(freeHistoryActual({ eventStartTime: start, market: 'aces' }, { values: [match('2030-10-01T12:00:00Z', 5)], perMap: false }), null,
    'no match in the window: pending');
  // Esports maps: oldest first, two maps of one series summed.
  const maps = [match('2030-10-07T17:40:00Z', 9), match('2030-10-07T15:05:00Z', 7), match('2030-10-07T16:20:00Z', 12)];
  assert.equal(freeHistoryActual({ eventStartTime: start, market: 'maps_1_2_kills' }, { values: maps, perMap: true }), 19);
  assert.equal(freeHistoryActual({ eventStartTime: start, market: 'maps_1_3_kills' }, { values: maps, perMap: true }), 28);
  assert.equal(freeHistoryActual({ eventStartTime: start, market: 'maps_1_3_kills' }, { values: maps.slice(0, 2), perMap: true }), null,
    'a 2–0 series has no map 3: pending');
  assert.equal(freeHistoryActual({ eventStartTime: start, market: 'maps_1_2_kills' },
    { values: [...maps, match('2030-10-08T02:00:00Z', 4)], perMap: true }), null, 'two series that day: pending');
});

test('Edge results worker grades tennis and esports picks from free history', async () => {
  const { EdgeResultsWorker } = await import('../src/edge/service.js');
  const { EdgeLedger } = await import('../src/edge/ledger.js');
  let now = new Date('2030-10-07T12:00:00Z');
  const clock = () => now;
  const pick = { platform: 'prizepicks', key: 'k', lineId: 'l', oppositeLineId: null, sport: 'TENNIS', league: 'TENNIS', eventId: 'e',
    eventName: 'A vs B', eventStartTime: '2030-10-07T15:00:00Z', playerId: 'p', playerName: 'Iga Swiatek', team: null, market: 'total_games_won',
    threshold: 10.5, lineType: 'REGULAR', side: 'MORE', probability: .6, pushProbability: 0, oppositeProbability: .4, breakEven: .55, edge: .05,
    requiredPayoutFactor: 1, edgeScore: 60, rating: 'VALUE', tier: 'MARKET', projection: { mean: 11, median: 11, sd: 2, family: 'NORMAL' },
    lineGap: 0, fairLine: 11, sources: { market: null, stats: null, ladder: null }, reasons: [], warnings: [], calibrated: false, modelVersion: 'x' };
  // Record before the start, then grade after.
  const early = new EdgeLedger(null, clock);
  await early.record([pick as never], () => ({ team: null, home: null, away: null }));
  now = new Date('2030-10-08T12:00:00Z');
  const worker = new EdgeResultsWorker(early, null, null, clock,
    async () => ({ values: [{ date: '2030-10-07T15:20:00Z', value: 12 }], perMap: false, source: 'ESPN tennis scoreboards' }));
  assert.equal((await worker.runOnce())!.graded, 1);
  const report = await early.report();
  assert.equal(report.recent[0]!.outcome, 'WIN');
  assert.equal(report.recent[0]!.resultSource, 'ESPN tennis scoreboards');
});
