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
  // Same game, both overs on volume stats: the +0.05 game-total prior lifts the all-hit chance a little.
  assert.ok(Math.abs(slip.independentExpectedReturn! - .55 * .5 * 4.4) < 1e-6);
  assert.ok(slip.expectedReturn > slip.independentExpectedReturn! && slip.expectedReturn < slip.independentExpectedReturn! * 1.05);
  assert.match(slip.correlationNote!, /Same game total: \+\d\.\d% EV vs independent/);
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

test('freshness: a quote from before the books’ latest move counts 4× less', () => {
  const t = now.getTime();
  const before = { ...quote('draftkings', 2.4, 1.6), observedAt: new Date(t - 40 * 60_000).toISOString() };
  const after = { ...quote('fanduel', 1.6, 2.4), observedAt: new Date(t - 10 * 60_000).toISOString() };
  const plain = priceBoard({ lines: [line('l1', 24.5)], quotes: [before, after], now }).picks[0]!;
  const moved = priceBoard({ lines: [line('l1', 24.5)], quotes: [before, after], now, lastMoveAt: () => t - 20 * 60_000 }).picks[0]!;
  const over = (pick: typeof plain) => pick.side === 'MORE' ? pick.probability : 1 - pick.probability;
  assert.ok(over(moved) > over(plain) + .01, 'the post-move FanDuel over dominates once the older DraftKings under is discounted');
});

test('a yardage rung far from any other book’s number is shown but not ranked (skew guard)', () => {
  const yards = (id: string, threshold: number) => line(id, threshold, { sport: 'NFL', league: 'NFL', market: 'player_reception_yds' });
  const q = (point: number): MarketQuote => ({ ...quote('fanduel', 1.91, 1.91), sport: 'NFL', market: 'player_reception_yds', point,
    sourceMarketKey: 'player_reception_yds' });
  // Books price 60.5; Hard Rock's 92.5 rung (about 0.9 SD up) offers the under at 1.35.
  const priced = priceBoard({ lines: [yards('far', 92.5)], quotes: [q(60.5), { ...q(60.5), bookmaker: 'betrivers' }], now,
    sidePayout: (_line, side) => ({ kind: 'ODDS', decimal: side === 'LESS' ? 1.35 : 3 }) });
  const far = priced.picks[0]!;
  assert.equal(far.side, 'LESS');
  assert.ok(far.ev! > 0, 'the normal says the under is +EV');
  assert.equal(far.rating, 'NONE', 'but it is not ranked');
  assert.ok(far.warnings.some((warning) => warning.includes('yardage rung')));
});

test('Goblin/Demon factors from distance to the regular line stay at or under the factors PrizePicks paid', async () => {
  const { alternateFactorFor, conditionalOver, fitMean, makeDistribution, varianceAt } = await import('../src/index.js');
  const chance = (sport: string, market: string, regular: number, alt: number) => {
    const profile = profileFor(sport, market), mean = fitMean(profile.family, profile.variance, regular, .5, profile.discrete);
    return conditionalOver(makeDistribution(profile.family, mean, varianceAt(profile.variance, mean), profile.discrete), alt);
  };
  // Owner's screenshots (2026-10-06): Stokes rebounds regular 7 (Goblin 4.5 paid 0.67x, Demon 12.5 paid 5.4x); Jeanjean total
  // games regular 20.5 (Demons 21.5 and 25.5 paid 1.154x and 1.43x).
  const seen: [string, string, number, number, 'GOBLIN' | 'DEMON', number][] = [['WNBA', 'player_rebounds', 7, 4.5, 'GOBLIN', .667],
    ['WNBA', 'player_rebounds', 7, 12.5, 'DEMON', 5.4], ['TENNIS', 'total_games', 20.5, 21.5, 'DEMON', 1.154], ['TENNIS', 'total_games', 20.5, 25.5, 'DEMON', 1.43]];
  for (const [sport, market, regular, alt, type, paid] of seen) {
    const factor = alternateFactorFor(type, chance(sport, market, regular, alt), type === 'GOBLIN' ? .95 : .25, undefined)!;
    assert.ok(factor <= paid + .02, `${market} ${alt}: ${factor} vs ${paid}`);
    assert.ok(type === 'GOBLIN' ? factor < 1 && factor > .55 : factor >= 1);
  }
  assert.equal(alternateFactorFor('GOBLIN', null, .95, .65), .65, 'no regular on the board: the flat fallback');
});

test('a 1st-period line (sport OTHER) on the same game and stat never takes the full-game book price', () => {
  const firstPeriod = line('p1', 24.5, { sport: 'OTHER' as PropLine['sport'], league: 'NHL1P', lineType: 'DEMON', availableDirections: ['MORE'] });
  const result = priceBoard({ lines: [line('full', 24.5), firstPeriod], quotes: [quote('fanduel', 1.6, 2.4), quote('betrivers', 1.62, 2.35)], now });
  assert.ok(result.picks.some((pick) => pick.lineId === 'full' && pick.sources.market));
  assert.ok(!result.picks.some((pick) => pick.lineId === 'p1' && pick.sources.market), 'no full-game price on the 1st-period line');
});

test('market audit: PrizePicks short labels reach their real models, and odd stats get the right shape', async () => {
  const { profileKey, varianceAt } = await import('../src/index.js');
  assert.equal(profileKey('WNBA', '3ptm'), 'WNBA:player_threes');
  assert.equal(profileKey('WNBA', 'pra'), 'WNBA:player_points_rebounds_assists');
  assert.equal(profileKey('TENNIS', 'total_games_won'), 'TENNIS:games_won');
  assert.equal(profileKey('MLB', 'po'), 'MLB:pitcher_outs');
  assert.equal(profileKey('NCAAFB', 'recs'), 'NFL:player_receptions');
  const plusMinus = profileFor('NHL', 'plus_minus');
  assert.equal(plusMinus.family, 'NORMAL', 'plus/minus can go negative');
  assert.ok(Math.sqrt(varianceAt(profileFor('NHL', 'player_time_on_ice').variance, 21)) < 3.5);
  assert.ok(Math.sqrt(varianceAt(profileFor('NFL', 'player_completion_percentage').variance, 65)) < 10);
});

test('plus/minus is priced and shown but never ranked', () => {
  const values = [2, 1, 0, 3, 1, 2, 0, 1, 2, 1];
  const pick = priceBoard({ lines: [line('pm', .5, { sport: 'NHL', league: 'NHL', market: 'plus_minus', lineType: 'DEMON', availableDirections: ['MORE'] })],
    now, values: () => values, alternateFactors: { DEMON: 1.05 } }).picks[0]!;
  assert.equal(pick.rating, 'NONE');
  assert.ok(pick.warnings.some((warning) => warning.startsWith('Plus/minus isn’t ranked')));
});
