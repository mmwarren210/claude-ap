import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarketQuote, PropLine } from '@crowniq/contracts';
import { edgeBoardResponseSchema, edgePickSchema } from '@crowniq/contracts';
import {
  applyCalibration, backtestProjection, breakEven, buildSlips, cdf, conditionalOver, defaultEntries,
  describeEntry, devigPower, evaluateSlip, fitCalibration, fitMean, fitPlatt, forecastReport,
  makeDistribution, outcomeAt, parseEntries, priceBoard, profileFor, projectFromRows, sigmoid, logit,
  edgeLine, generateEntries, inChoice,
} from '../src/index.js';
import type { StatRow } from '../src/index.js';

const now = new Date('2026-10-05T12:00:00Z');
const start = '2026-10-05T23:00:00Z';
const close = (actual: number, expected: number, tolerance = 1e-3) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);

function line(id: string, threshold: number, direction: 'MORE' | 'LESS', options: Partial<PropLine> = {}): PropLine {
  return { id, provider: 'prizepicks', sourceLineId: id, sourceLineIdIsSynthetic: false, sport: 'NBA',
    league: 'NBA', eventId: 'e1', eventName: 'Away @ Home', eventStartTime: start, playerId: 'p1',
    playerName: 'Test Player', team: null, opponent: null, market: 'player_points', threshold,
    availableDirections: [direction], lineType: 'REGULAR', fetchedAt: now.toISOString(), ...options };
}
function quote(bookmaker: string, point: number, overPrice: number | null, underPrice: number | null,
  options: Partial<MarketQuote> = {}): MarketQuote {
  return { bookmaker, sport: 'NBA', eventId: 'e1', sourceMarketKey: 'player_points', market: 'player_points',
    playerName: 'Test Player', point, overPrice, underPrice, fetchedAt: now.toISOString(), ...options };
}

// Deterministic PRNG so synthetic samples are reproducible.
function rng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}
function poissonSample(random: () => number, mean: number) {
  let k = 0, p = 1; const limit = Math.exp(-mean);
  do { k++; p *= random(); } while (p > limit);
  return k - 1;
}

test('count distributions sum to one and handle integer pushes', () => {
  const poisson = makeDistribution('POISSON', 1, 1);
  close(outcomeAt(poisson, .5).over, 1 - Math.exp(-1), 1e-9);
  const nb = makeDistribution('NEGBIN', 6, 12);
  close(cdf(nb, 200), 1, 1e-9);
  const atFive = outcomeAt(nb, 5);
  close(atFive.over + atFive.under + atFive.push, 1, 1e-9);
  assert.ok(atFive.push > .05);
  // An under-dispersed request falls back to Poisson rather than an invalid NB.
  assert.equal(makeDistribution('NEGBIN', 4, 3).family, 'POISSON');
});

test('mean fitting reproduces the target price at the quoted line', () => {
  for (const [sport, market, line, target] of [['NBA', 'player_points', 24.5, .58], ['NFL', 'passing_yards', 245.5, .44],
    ['MLB', 'batter_hits', .5, .66], ['NFL', 'player_receptions', 4.5, .52]] as const) {
    const profile = profileFor(sport, market);
    const mean = fitMean(profile.family, profile.variance, line, target, profile.discrete);
    const variance = profile.variance.phi * mean + profile.variance.psi * mean * mean;
    const dist = makeDistribution(profile.family, mean, Math.max(variance, profile.variance.floor ?? 0), profile.discrete);
    close(conditionalOver(dist, line), target, 2e-3);
  }
});

test('power de-vig removes the margin and keeps favourites ordered', () => {
  close(devigPower(1.909, 1.909), .5, 1e-9);
  const favourite = devigPower(1.714, 2.15);
  assert.ok(favourite > .55 && favourite < .58);
  close(favourite + devigPower(2.15, 1.714), 1, 1e-9);
});

test('payout break-evens match the entry math', () => {
  close(breakEven(defaultEntries[0]), Math.sqrt(1 / 3), 1e-6);
  const flex6 = defaultEntries.find((entry) => entry.type === 'FLEX' && entry.size === 6)!;
  assert.ok(breakEven(flex6) > .54 && breakEven(flex6) < .545);
  const parsed = parseEntries('POWER2=3;FLEX6=25/2/0.4');
  assert.deepEqual(parsed[1].payouts, { 6: 25, 5: 2, 4: .4 });
  assert.throws(() => parseEntries('POWER2=3/1'), /INVALID_EDGE_PAYOUTS/);
});

test('sharp consensus above the PrizePicks line produces a MORE edge', () => {
  const result = priceBoard({ now, lines: [line('more', 24.5, 'MORE'), line('less', 24.5, 'LESS')],
    quotes: [quote('pinnacle', 26.5, 1.87, 1.95), quote('fanduel', 26.5, 1.83, 1.95), quote('draftkings', 25.5, 1.65, 2.2)] });
  assert.equal(result.picks.length, 1);
  const pick = edgePickSchema.parse(result.picks[0]);
  assert.equal(pick.side, 'MORE');
  assert.equal(pick.lineId, 'more');
  assert.equal(pick.oppositeLineId, 'less');
  assert.equal(pick.tier, 'SHARP');
  assert.ok(pick.probability > .57 && pick.probability < .66, String(pick.probability));
  assert.ok(pick.edge! > .03);
  assert.ok(['STRONG', 'ELITE', 'VALUE'].includes(pick.rating));
  assert.ok(pick.lineGap! > 2);
  assert.equal(pick.sources.market!.books.length, 3);
});

test('books below the line flip the pick to LESS; agreement with PrizePicks shows no edge', () => {
  const low = priceBoard({ now, lines: [line('more', 24.5, 'MORE'), line('less', 24.5, 'LESS')],
    quotes: [quote('pinnacle', 22.5, 1.91, 1.91), quote('fanduel', 22.5, 1.87, 1.95)] }).picks[0];
  assert.equal(low.side, 'LESS');
  assert.ok(low.edge! > 0);
  const flat = priceBoard({ now, lines: [line('more', 24.5, 'MORE'), line('less', 24.5, 'LESS')],
    quotes: [quote('pinnacle', 24.5, 1.91, 1.91), quote('fanduel', 24.5, 1.91, 1.91)] }).picks[0];
  close(flat.probability, .5, .02);
  assert.equal(flat.rating, 'NONE');
});

test('goblins and demons are priced on the same distribution with an unknown payout factor', () => {
  const result = priceBoard({ now, lines: [line('reg', 24.5, 'MORE'), line('reg-l', 24.5, 'LESS'),
    line('gob', 19.5, 'MORE', { lineType: 'GOBLIN' }), line('dem', 31.5, 'MORE', { lineType: 'DEMON' })],
  quotes: [quote('pinnacle', 24.5, 1.91, 1.91)] });
  const goblin = result.picks.find((pick) => pick.lineId === 'gob')!;
  const demon = result.picks.find((pick) => pick.lineId === 'dem')!;
  assert.ok(goblin.probability > .75);
  assert.ok(demon.probability < .25);
  assert.equal(goblin.edge, null);
  assert.equal(goblin.rating, 'NONE');
  close(goblin.requiredPayoutFactor, goblin.breakEven / goblin.probability, 2e-3);
  assert.ok(goblin.warnings.some((warning) => warning.includes('payout factor')));
  const verified = priceBoard({ now, lines: [line('gob', 19.5, 'MORE', { lineType: 'GOBLIN' }), line('reg', 24.5, 'MORE')],
    quotes: [quote('pinnacle', 24.5, 1.91, 1.91)], alternateFactors: { GOBLIN: .8 } });
  assert.notEqual(verified.picks.find((pick) => pick.lineId === 'gob')!.edge, null);
});

test('regular lines with no independent information stay unpriced; started events are skipped', () => {
  const result = priceBoard({ now, lines: [line('reg', 24.5, 'MORE'),
    line('gone', 10.5, 'MORE', { eventId: 'e0', eventStartTime: '2026-10-05T11:00:00Z' })] });
  assert.equal(result.picks.length, 0);
  assert.equal(result.unpriced, 1);
});

function nbaRows(count: number, points: (index: number) => number, minutes = 34): StatRow[] {
  return Array.from({ length: count }, (_, index) => ({
    occurredAt: new Date(Date.parse('2026-10-04T00:00:00Z') - index * 2 * 86400_000).toISOString(),
    metrics: { pts: points(index), minutes, rebounds: 6, assists: 4 } }));
}

test('stats projection drops DNP games and weights opportunity changes', () => {
  const profile = profileFor('NBA', 'player_points');
  const rows = [...nbaRows(12, () => 20), { occurredAt: '2026-10-03T00:00:00Z', metrics: { pts: 0, minutes: 0 } }];
  const projection = projectFromRows(rows, profile.stat!, profile, start)!;
  assert.equal(projection.samples, 12);
  close(projection.mean, 20, 1e-6);
  // Minutes jump in the most recent games should raise the projection immediately.
  const roleChange = nbaRows(15, (index) => index < 4 ? 30 : 20).map((row, index) =>
    ({ ...row, metrics: { ...row.metrics, minutes: index < 4 ? 36 : 24 } }));
  const moved = projectFromRows(roleChange, profile.stat!, profile, start)!;
  assert.ok(moved.mean > 25, String(moved.mean));
});

test('model-only pricing uses history and is labelled with lower confidence', () => {
  const rows = nbaRows(20, (index) => 28 + (index % 3) - 1);
  const result = priceBoard({ now, lines: [line('more', 22.5, 'MORE'), line('less', 22.5, 'LESS')],
    history: () => rows });
  const pick = result.picks[0];
  assert.equal(pick.tier, 'MODEL');
  assert.equal(pick.side, 'MORE');
  assert.ok(pick.sources.stats!.samples === 20);
  close(pick.sources.stats!.hitRateAtLine!, 1);
  assert.ok(pick.warnings.some((warning) => warning.includes('model-only')));
  // The PrizePicks line itself anchors the estimate, so model-only edges are shrunk.
  assert.ok(pick.probability < .9);
});

test('slip builder respects player and game limits and computes exact EV', () => {
  const lines: PropLine[] = [], quotes: MarketQuote[] = [];
  for (let index = 0; index < 6; index++) {
    const event = 'e' + (index % 3), player = 'Player ' + index;
    for (const direction of ['MORE', 'LESS'] as const) lines.push(line(`l${index}${direction}`, 20.5, direction,
      { eventId: event, playerId: 'p' + index, playerName: player }));
    quotes.push(quote('pinnacle', 22.5, 1.87, 1.95, { eventId: event, playerName: player }),
      quote('fanduel', 22.5, 1.87, 1.95, { eventId: event, playerName: player }));
  }
  const result = priceBoard({ now, lines, quotes });
  const slips = buildSlips(result.picks, result.entries);
  assert.ok(slips.length > 0);
  for (const slip of slips) {
    assert.equal(new Set(slip.legs.map((leg) => leg.playerName)).size, slip.legs.length);
    assert.ok(new Set(slip.legs.map((leg) => leg.eventId)).size >= 2);
    const perEvent = new Map<string, number>();
    for (const leg of slip.legs) perEvent.set(leg.eventId, (perEvent.get(leg.eventId) ?? 0) + 1);
    assert.ok(Math.max(...perEvent.values()) <= 2);
    assert.ok(slip.expectedProfit > 0);
  }
  const power2 = describeEntry(defaultEntries[0]);
  const evaluated = evaluateSlip(power2, result.picks.slice(0, 2));
  close(evaluated.expectedReturn, result.picks[0].probability * result.picks[1].probability * 3, 1e-3);
  close(evaluated.hitDistribution.reduce((a, b) => a + b, 0), 1, 1e-3);
  edgeBoardResponseSchema.shape.slips.parse(slips);
});

test('Platt calibration shrinks an over-confident forecaster', () => {
  const random = rng(7), rows = [];
  for (let index = 0; index < 4000; index++) {
    const truth = .4 + random() * .2; // true probabilities 40–60%
    const stated = sigmoid(logit(truth) * 2.5); // over-confident by 2.5×
    rows.push({ probability: stated, hit: random() < truth, sport: 'NBA' });
  }
  const params = fitPlatt(rows);
  assert.ok(params.b < .6 && params.b > .25, JSON.stringify(params));
  const model = fitCalibration(rows);
  assert.ok(Math.abs(applyCalibration(model, 'NBA', .7) - .5) < Math.abs(.7 - .5));
  const report = forecastReport(rows);
  assert.equal(report.graded, 4000);
  assert.ok(report.bins.length > 3);
  // Too few rows leaves forecasts untouched.
  close(applyCalibration(fitCalibration(rows.slice(0, 20)), 'NBA', .7), .7, 1e-12);
});

test('walk-forward backtest: count model beats the old mean/SD normal on low-count stats', () => {
  const random = rng(11), profile = profileFor('MLB', 'batter_hits');
  const rows: StatRow[] = Array.from({ length: 160 }, (_, index) => {
    const pas = 4 + (random() < .3 ? 1 : 0);
    return { occurredAt: new Date(Date.parse('2026-04-01T00:00:00Z') + index * 86400_000).toISOString(),
      metrics: { hits: poissonSample(random, .27 * pas), plate_appearances: pas } };
  });
  const result = backtestProjection(rows, profile.stat!, profile)!;
  assert.ok(result.games > 100);
  assert.ok(result.edge.logScore > result.baseline.logScore, JSON.stringify(result));
  assert.ok(result.edge.brierAtMedian < result.baseline.brierAtMedian, JSON.stringify(result));
});

test('Edge sets its own line at the 50/50 point of its distribution', () => {
  const result = priceBoard({ now, lines: [line('more', 24.5, 'MORE'), line('less', 24.5, 'LESS')],
    quotes: [quote('pinnacle', 27.5, 1.91, 1.91), quote('fanduel', 27.5, 1.91, 1.91)] });
  const pick = result.picks[0];
  assert.ok(pick.fairLine >= 26.5 && pick.fairLine <= 28.5, String(pick.fairLine));
  assert.equal(pick.fairLine % 1, .5);
  const dist = makeDistribution('NEGBIN', 6.2, 9);
  assert.ok(Math.abs(conditionalOver(dist, edgeLine(dist)) - .5) < .12);
  assert.equal(edgeLine(makeDistribution('NORMAL', 18.37, 30, false)), 18.5);
});

test('lines Edge cannot read are returned with a reason instead of disappearing', () => {
  const result = priceBoard({ now, lines: [line('reg', 24.5, 'MORE'),
    line('alt', 30.5, 'MORE', { playerId: 'p2', playerName: 'Lone Alternate', lineType: 'DEMON' })] });
  assert.deepEqual(result.unpricedLines.map((item) => [item.line.id, item.reason]),
    [['reg', 'NO_INDEPENDENT_READ'], ['alt', 'NO_DATA']]);
  assert.ok(result.unpricedLines.every((item) => item.note.length > 20));
});

test('Edge Gen builds distinct entries within filters', () => {
  const lines: PropLine[] = [], quotes: MarketQuote[] = [];
  for (let index = 0; index < 12; index++) {
    const event = 'e' + (index % 4), player = 'Gen Player ' + index;
    const sport = index < 8 ? 'NBA' : 'NFL';
    for (const direction of ['MORE', 'LESS'] as const) lines.push(line(`g${index}${direction}`, 20.5, direction,
      { eventId: event, playerId: 'gp' + index, playerName: player, sport }));
    quotes.push(quote('pinnacle', 22.5 + (index % 3) * .5, 1.87, 1.95, { eventId: event, playerName: player, sport }),
      quote('fanduel', 22.5, 1.87, 1.95, { eventId: event, playerName: player, sport }));
  }
  const result = priceBoard({ now, lines, quotes });
  const power3 = result.entries.find((entry) => entry.type === 'POWER' && entry.size === 3)!;
  const slips = generateEntries(result.picks, power3, { count: 4, nowMs: now.getTime() });
  assert.ok(slips.length >= 3);
  const used = slips.flatMap((slip) => slip.legs.map((leg) => leg.lineId));
  assert.equal(new Set(used).size, used.length, 'no leg reused when maxLegUses is 1');
  assert.ok(slips.every((slip) => slip.expectedProfit > 0 && new Set(slip.legs.map((leg) => leg.eventId)).size >= 2));
  const nflOnly = generateEntries(result.picks, power3, { count: 2, sport: 'NFL', nowMs: now.getTime() });
  assert.ok(nflOnly.every((slip) => slip.legs.every((leg) => leg.sport === 'NFL')));
  // Several sports and stats at once (comma-separated).
  const sports = [...new Set(result.picks.map((pick) => pick.sport))].join(',');
  assert.equal(generateEntries(result.picks, power3, { count: 2, sport: sports, nowMs: now.getTime() }).length,
    generateEntries(result.picks, power3, { count: 2, nowMs: now.getTime() }).length);
  assert.equal(generateEntries(result.picks, power3, { count: 2, market: 'no_such_stat,other', nowMs: now.getTime() }).length, 0);
  assert.ok(inChoice('NFL,NBA', 'NBA') && !inChoice('NFL,NBA', 'MLB') && inChoice(undefined, 'MLB'));
  assert.equal(generateEntries(result.picks, power3, { from: Date.parse('2026-10-07T00:00:00Z'), nowMs: now.getTime() }).length, 0);
});
