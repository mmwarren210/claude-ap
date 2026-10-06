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

test('freshness: an old book price counts less than a fresh one', () => {
  const fresh = { ...quote('fanduel', 1.6, 2.4), observedAt: now.toISOString() };
  const stale = { ...quote('draftkings', 2.4, 1.6), observedAt: new Date(now.getTime() - 12 * 3600_000).toISOString() };
  const pick = priceBoard({ lines: [line('l1', 24.5)], quotes: [fresh, stale], now }).picks[0]!;
  assert.equal(pick.side, 'MORE', 'the fresh FanDuel over outweighs the 12-hour-old DraftKings under');
});

// Spec §4 payout layers, with hand-computed numbers.
import { evaluateSlip, generateEntries, parlayEntries, describeEntry, entriesFromTables as tables } from '../src/index.js';
import type { EdgePick } from '@crowniq/contracts';

const leg = (id: string, probability: number, extra: Partial<EdgePick> = {}): EdgePick => ({ platform: 'underdog', key: id, lineId: id,
  oppositeLineId: null, sport: 'NBA', league: 'NBA', eventId: 'e-' + id, eventName: 'A @ B', eventStartTime: start, playerId: 'p-' + id,
  playerName: id, market: 'player_points', threshold: 20.5, lineType: 'REGULAR', side: 'MORE', probability, pushProbability: 0,
  oppositeProbability: 1 - probability, breakEven: .5, edge: .05, requiredPayoutFactor: 1, edgeScore: 60, rating: 'VALUE', tier: 'MARKET',
  projection: { mean: 22, median: 22, sd: 6, family: 'NEGBIN' }, lineGap: 1, fairLine: 21.5,
  sources: { market: null, stats: null, ladder: null }, reasons: [], warnings: [], calibrated: false, modelVersion: 'EDGE-1.0', ...extra });

test('Underdog 3-pick Standard with mixed multipliers: 6.5x times each pick’s multiplier', () => {
  const standard3 = describeEntry(tables({ POWER: { 3: { 3: 6.5 } } })[0]!);
  const slip = evaluateSlip(standard3, [leg('a', .6, { payoutMultiplier: 1.05 }), leg('b', .55, { payoutMultiplier: .9 }), leg('c', .58)]);
  // 0.6 × 0.55 × 0.58 = 0.1914 all hit; pays 6.5 × 1.05 × 0.9 = 6.1425 → 1.1757 back per $1.
  assert.ok(Math.abs(slip.expectedReturn - .1914 * 6.1425) < 1e-3);
});

test('Hard Rock: each side against its own odds; the best rung of a ladder is the one with the highest EV', () => {
  const ladder = [24.5, 26.5, 28.5].map((threshold, index) => line('hr' + index, threshold));
  const odds: Record<string, number> = { hr0: 1.6, hr1: 2.1, hr2: 2.9 };
  const result = priceBoard({ lines: ladder, quotes: [quote('fanduel', 1.9, 1.9)], now,
    sidePayout: (item, side) => side === 'MORE' ? { kind: 'ODDS', decimal: odds[item.id]! } : { kind: 'ODDS', decimal: 1.9 } });
  for (const pick of result.picks) {
    const decimal = pick.side === 'MORE' ? odds[pick.lineId]! : 1.9;
    assert.ok(Math.abs(pick.breakEven - 1 / decimal) < 1e-3, 'break-even is 1 / odds');
    assert.ok(Math.abs(pick.ev! - (pick.probability * decimal - 1)) < 1e-3, 'EV = p × odds − 1');
    assert.ok(pick.kelly! >= 0 && pick.kelly! <= .02, 'quarter Kelly, capped at 2%');
  }
});

test('DK Pick’em gimme and unconfirmed payouts: a chance, never an edge', () => {
  const gimme = priceBoard({ lines: [line('g', 24.5)], quotes: [quote('fanduel', 1.6, 2.4)], now,
    sidePayout: () => ({ kind: 'ENTRY', multiplier: 1, blocked: 'promo' }) }).picks[0]!;
  assert.equal(gimme.edge, null);
  assert.ok(gimme.warnings.includes('promo'));
  const unconfirmed = priceBoard({ lines: [line('u', 24.5)], quotes: [quote('fanduel', 1.6, 2.4)], now,
    sidePayout: () => ({ kind: 'ENTRY', multiplier: null }) }).picks[0]!;
  assert.equal(unconfirmed.edge, null);
});

test('sportsbook parlays: all legs must hit and pay the product of the odds; one game is allowed', () => {
  const [two] = parlayEntries(8).map(describeEntry);
  const slip = evaluateSlip(two!, [leg('a', .55, { payoutMultiplier: 2 }), leg('b', .5, { payoutMultiplier: 2.2, eventId: 'e-a' })], { minEvents: 1 });
  assert.ok(Math.abs(slip.expectedReturn - .55 * .5 * 4.4) < 1e-6);
  assert.ok(!slip.warnings.some((warning) => warning.includes('two teams')));
  const built = generateEntries([leg('a', .55, { payoutMultiplier: 2 }), leg('b', .5, { payoutMultiplier: 2.2 })], two!,
    { nowMs: now.getTime(), minEvents: 1 });
  assert.equal(built.length, 1);
});

test('an edge too big to be real is held for review, never ranked', () => {
  const pick = priceBoard({ lines: [line('r', 24.5)], quotes: [quote('fanduel', 1.15, 6)], now,
    sidePayout: () => ({ kind: 'ODDS', decimal: 3 }) }).picks[0]!;
  assert.equal(pick.rating, 'NONE');
  assert.ok(pick.warnings.some((warning) => warning.startsWith('Held for review')));
});

test('a sportsbook bet no other book prices is shown but not ranked', () => {
  const values = [31, 28, 30, 35, 27, 29, 33, 30, 26, 32];
  const pick = priceBoard({ lines: [line('m', 24.5)], now, values: () => values,
    sidePayout: () => ({ kind: 'ODDS', decimal: 1.9 }) }).picks[0]!;
  assert.equal(pick.tier, 'MODEL');
  assert.equal(pick.rating, 'NONE');
  assert.ok(pick.warnings.some((warning) => warning.startsWith('No other sportsbook')));
});
