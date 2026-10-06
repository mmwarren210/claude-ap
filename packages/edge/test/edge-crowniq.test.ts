import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarketQuote, PropLine } from '@crowniq/contracts';
import { DEFAULT_PAYOUTS } from '@crowniq/contracts';
import { breakEven, entriesFromTables, priceBoard, profileFor, projectFromValues } from '../src/index.js';

const now = new Date('2026-10-05T12:00:00Z'), start = '2026-10-05T23:00:00Z';
const line = (id: string, threshold: number, options: Partial<PropLine> = {}): PropLine => ({ id, provider: 'prizepicks',
  sourceLineId: id, sourceLineIdIsSynthetic: false, sport: 'NBA', league: 'NBA', eventId: 'e1', eventName: 'A @ B',
  eventStartTime: start, playerId: 'p1', playerName: 'Test Player', team: null, opponent: null, market: 'player_points',
  threshold, availableDirections: ['MORE', 'LESS'], lineType: 'REGULAR', fetchedAt: now.toISOString(), ...options });
const quote = (bookmaker: string, overPrice: number, underPrice: number): MarketQuote => ({ bookmaker, sport: 'NBA',
  eventId: 'e1', sourceMarketKey: 'player_points', market: 'player_points', playerName: 'Test Player', point: 24.5,
  overPrice, underPrice, fetchedAt: now.toISOString() });

test('entries come from the app payout charts (PrizePicks Power 2–6, Flex 2–6)', () => {
  const entries = entriesFromTables(DEFAULT_PAYOUTS.prizepicks);
  assert.equal(entries.length, 10);
  const flex6 = entries.find((entry) => entry.type === 'FLEX' && entry.size === 6)!;
  assert.deepEqual(flex6.payouts, { 6: 25, 5: 2, 4: 0.4 });
  assert.ok(Math.abs(breakEven(entries.find((entry) => entry.type === 'POWER' && entry.size === 2)!) - Math.sqrt(1 / 3)) < 1e-6);
});

test('leave-one-out: the platform being priced never confirms its own price', () => {
  const lines = [line('l1', 24.5)];
  const withBook = priceBoard({ lines, quotes: [quote('draftkings', 1.6, 2.4)], now });
  const without = priceBoard({ lines, quotes: [quote('draftkings', 1.6, 2.4)], now, excludeBooks: ['draftkings'] });
  assert.equal(withBook.picks[0]!.tier, 'MARKET');
  assert.equal(without.picks.length, 0);
  assert.equal(without.unpricedLines[0]!.reason, 'NO_INDEPENDENT_READ');
});

test('No read names the exact missing inputs', () => {
  const result = priceBoard({ lines: [line('g1', 30.5, { lineType: 'GOBLIN', availableDirections: ['MORE'] })], now,
    values: () => [20, 22] });
  assert.equal(result.unpricedLines[0]!.reason, 'NO_DATA');
  assert.equal(result.unpricedLines[0]!.note,
    'No read: no sportsbook price for this player and stat; only 2 games of history (needs 5); no regular PrizePicks line to anchor it.');
});

test('history values alone give a model read, with the platform on the pick', () => {
  const values = [31, 28, 30, 35, 27, 29, 33, 30, 26, 32];
  const projection = projectFromValues(values, profileFor('NBA', 'player_points'))!;
  assert.ok(projection.mean > 28 && projection.mean < 32);
  const result = priceBoard({ lines: [line('l1', 24.5)], now, values: () => values, platform: 'prizepicks' });
  assert.equal(result.picks[0]!.tier, 'MODEL');
  assert.equal(result.picks[0]!.side, 'MORE');
  assert.equal(result.picks[0]!.platform, 'prizepicks');
});

test('board market keys reach the right profile', () => {
  assert.equal(profileFor('NHL', 'saves'), profileFor('NHL', 'player_total_saves'));
  assert.equal(profileFor('MLB', 'pitching_outs'), profileFor('MLB', 'pitcher_outs'));
});
