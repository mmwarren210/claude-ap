import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoardResponse, PropLine } from '@crowniq/contracts';
import { DEFAULT_PAYOUTS } from '@crowniq/contracts';
import type { FairPrice } from '../src/context/sharp-props.js';
import { MovementTracker } from '../src/edge/movement.js';
import { EdgeService } from '../src/edge/service.js';

const start = '2030-01-11T00:00:00Z';
const price = (book: string, line: number, fairOver = .5): FairPrice => ({ book, sport: 'NBA', player: 'Alpha Guard',
  market: 'player_points', line, fairOver, overAmerican: -110, underAmerican: -110, startTime: start, home: 'Home A', away: 'Away A' });

test('movement: three books moving the same way in one refresh is steam; a single book is a move', () => {
  const tracker = new MovementTracker();
  const t0 = Date.parse('2030-01-10T12:00:00Z'), t1 = t0 + 15 * 60_000;
  tracker.observe(['draftkings', 'fanduel', 'hardrock'].map((book) => price(book, 20.5)), t0);
  assert.equal(tracker.summary('NBA', 'Alpha Guard', 'player_points', t1), null, 'no history yet');
  assert.equal(tracker.observe(['draftkings', 'fanduel', 'hardrock'].map((book) => price(book, 23.5)), t1), 3);
  const moved = tracker.summary('NBA', 'Alpha Guard', 'player_points', t1 + 60_000)!;
  assert.deepEqual([moved.direction, moved.books, moved.steam], ['UP', 3, true]);
  const lone = new MovementTracker();
  lone.observe([price('draftkings', 20.5)], t0);
  lone.observe([price('draftkings', 23.5)], t1);
  assert.equal(lone.summary('NBA', 'Alpha Guard', 'player_points', t1)!.steam, false);
});

test('stale: books moved past the app after its number last changed, toward the pick; injured players never ranked; alerts once per hour', async () => {
  let now = new Date('2030-01-10T12:20:00Z');
  const line = (id: string, player: string): PropLine => ({ id, provider: 'prizepicks', sourceLineId: id, sourceLineIdIsSynthetic: false,
    sport: 'NBA', league: 'NBA', eventId: 'g', eventName: 'A @ H', eventStartTime: start, playerId: id, playerName: player, team: null,
    opponent: null, homeTeam: 'Home A', awayTeam: 'Away A', market: 'player_points', threshold: 20.5, availableDirections: ['MORE', 'LESS'],
    lineType: 'REGULAR', fetchedAt: start });
  const board = { board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines: [line('a', 'Alpha Guard'), line('b', 'Bravo Wing'),
    line('c', 'Charlie Big')] }, analyses: [], builtAt: now.toISOString() } as unknown as BoardResponse;
  const prices = ['Alpha Guard', 'Bravo Wing', 'Charlie Big'].flatMap((player) => ['draftkings', 'fanduel', 'hardrock']
    .map((book) => ({ ...price(book, 24.5), player })));
  const movement = new MovementTracker();
  const t0 = Date.parse('2030-01-10T11:45:00Z');
  movement.observe(prices.map((item) => ({ ...item, line: 20.5 })), t0);
  movement.observe(prices, t0 + 15 * 60_000);
  const service = new EdgeService({ board: () => board, payouts: DEFAULT_PAYOUTS, clock: () => now, movement,
    sharp: { prices: async () => prices, pickem: async () => [] },
    // The app's number last changed at 11:30, before the books moved at 12:00.
    snapshots: { lastChange: () => Date.parse('2030-01-10T11:30:00Z') },
    injuries: async () => [{ player: 'Charlie Big', team: 'Home A', status: 'Out', league: 'NBA' }] });
  const snapshot = (await service.snapshot('prizepicks'))!;
  const alpha = snapshot.response.picks.find((pick) => pick.playerName === 'Alpha Guard')!;
  assert.equal(alpha.side, 'MORE');
  assert.deepEqual(alpha.stale, { minutesAgo: 20, books: 3, direction: 'UP' });
  assert.equal(alpha.steam, true);
  assert.ok(alpha.reasons[0]!.startsWith('Books moved up 20 min ago'));
  assert.ok(alpha.rank! > 0);
  const charlie = snapshot.response.picks.find((pick) => pick.playerName === 'Charlie Big')!;
  assert.equal(charlie.rating, 'NONE');
  assert.equal(charlie.injury, 'Out (Home A)');
  assert.ok(snapshot.response.picks.indexOf(alpha) < snapshot.response.picks.indexOf(charlie), 'ranked picks first');
  const alerts = service.alertList('prizepicks', now.getTime());
  assert.equal(alerts.filter((alert) => alert.playerName === 'Alpha Guard').length, 1);
  assert.ok(!alerts.some((alert) => alert.playerName === 'Charlie Big'));
  now = new Date('2030-01-10T12:30:00Z');
  await service.snapshot('prizepicks');
  assert.equal(service.alertList('prizepicks', now.getTime()).filter((alert) => alert.playerName === 'Alpha Guard').length, 1,
    'one alert per player per hour');
});
