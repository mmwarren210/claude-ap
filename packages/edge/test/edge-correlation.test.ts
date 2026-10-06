import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgePick } from '@crowniq/contracts';
import { describeEntry, entryGrowth, evaluateSlip, generateEntries, hitDistribution, normalCdf, normalQuantile, parlayEntries,
  priorCorrelation, simulateHits, suggestSwap } from '../src/index.js';

// Synthetic legs only.
const start = '2030-01-11T00:00:00Z';
const leg = (id: string, probability: number, extra: Partial<EdgePick> = {}): EdgePick => ({ platform: 'prizepicks', key: id, lineId: id,
  oppositeLineId: null, sport: 'NBA', league: 'NBA', eventId: 'e-' + id, eventName: 'A @ B', eventStartTime: start, playerId: 'p-' + id,
  playerName: id, market: 'player_points', threshold: 20.5, lineType: 'REGULAR', side: 'MORE', probability, pushProbability: 0,
  oppositeProbability: 1 - probability, breakEven: .5, edge: .05, requiredPayoutFactor: 1, edgeScore: 60, rating: 'VALUE', tier: 'MARKET',
  projection: { mean: 22, median: 22, sd: 6, family: 'NEGBIN' }, lineGap: 1, fairLine: 21.5,
  sources: { market: null, stats: null, ladder: null }, reasons: [], warnings: [], calibrated: false, modelVersion: 'EDGE-1.0', ...extra });
const power = (size: number, pays: number) => ({ type: 'POWER' as const, size, payouts: { [size]: pays }, label: `${size}-pick Power`,
  breakEven: Math.pow(1 / pays, 1 / size) });

/** P(X < a, Y < b) for a standard bivariate normal with correlation rho (Simpson's rule). */
function bivariate(a: number, b: number, rho: number): number {
  const steps = 4000, low = -9, h = (a - low) / steps, s = Math.sqrt(1 - rho * rho);
  const f = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * normalCdf((b - rho * x) / s);
  let sum = f(low) + f(a);
  for (let i = 1; i < steps; i++) sum += (i % 2 ? 4 : 2) * f(low + i * h);
  return sum * h / 3;
}

test('the normal quantile inverts the CDF', () => {
  for (const p of [.001, .02, .3, .5, .77, .99]) assert.ok(Math.abs(normalCdf(normalQuantile(p)) - p) < 1e-7);
});

test('simulation matches the independent closed form within 0.5% when correlations are zero', () => {
  const probabilities = [.58, .61, .55, .6, .57];
  const identity = probabilities.map((_, i) => probabilities.map((__, j) => (i === j ? 1 : 0)));
  const simulated = simulateHits(probabilities, identity), exact = hitDistribution(probabilities);
  const payouts = [0, 0, 0, .4, 2, 10];
  const ev = (dist: number[]) => dist.reduce((sum, mass, hits) => sum + mass * payouts[hits]!, 0);
  assert.ok(Math.abs(ev(simulated) / ev(exact) - 1) < .005, `${ev(simulated)} vs ${ev(exact)}`);
  // Different games: evaluateSlip uses the exact closed form itself.
  const slip = evaluateSlip(power(2, 3), [leg('a', .6), leg('b', .58)]);
  assert.equal(slip.correlatedPairs, undefined);
  assert.equal(slip.allHitProbability, Math.round(.6 * .58 * 1e4) / 1e4);
});

test('a QB–receiver stack raises the 2-pick all-hit chance by what a 0.35 correlation implies', () => {
  const qb = leg('qb', .55, { sport: 'NFL', market: 'passing_yards', eventId: 'g', team: 'Kansas City' });
  const wr = leg('wr', .55, { sport: 'NFL', market: 'player_reception_yds', eventId: 'g', team: 'Kansas City' });
  assert.equal(priorCorrelation(qb, wr)!.rho, .35);
  const slip = evaluateSlip(power(2, 3), [qb, wr], { minEvents: 1 });
  const expected = bivariate(normalQuantile(.55), normalQuantile(.55), .35);
  assert.ok(Math.abs(slip.allHitProbability - expected) < .008, `${slip.allHitProbability} vs ${expected}`);
  assert.ok(slip.allHitProbability > .55 * .55 + .04);
  assert.match(slip.correlationNote!, /^QB \+ receiver stack: \+\d+\.\d% EV vs independent\.$/);
  // An under on the receiver flips the sign; the other team's receiver isn't stacked with this QB.
  assert.equal(evaluateSlip(power(2, 3), [qb, { ...wr, side: 'LESS' }]).correlatedPairs![0]!.rho, -.35);
  assert.equal(priorCorrelation(qb, { ...wr, team: 'Buffalo' })!.label, 'Same game total');
});

test('spec priors: teammates sharing points −0.05; pitcher strikeouts vs opposing hitters −0.15; different games 0', () => {
  const a = leg('a', .5, { eventId: 'g', team: 'Boston' }), b = leg('b', .5, { eventId: 'g', team: 'Boston' });
  assert.equal(priorCorrelation(a, b)!.rho, -.05);
  const pitcher = leg('p', .5, { sport: 'MLB', market: 'pitcher_strikeouts', eventId: 'm', team: 'New York Yankees' });
  const hitter = leg('h', .5, { sport: 'MLB', market: 'batter_hits', eventId: 'm', team: 'Boston Red Sox' });
  assert.equal(priorCorrelation(pitcher, hitter)!.rho, -.15);
  assert.equal(priorCorrelation(a, leg('c', .5)), null);
});

test('Kelly growth: zero without an edge; a fair coin at 2.2x stakes ~8%', () => {
  assert.deepEqual(entryGrowth([.5, .5], (hits) => (hits ? 1.9 : 0)), { fraction: 0, growth: 0 });
  const kelly = entryGrowth([.5, .5], (hits) => (hits ? 2.2 : 0));
  assert.ok(Math.abs(kelly.fraction - (.5 * 1.2 - .5) / 1.2) < 1e-4);
});

test('builder: one leg per player, at most N per game, two games, player exposure across entries; swaps into a positive stack', () => {
  const picks = [leg('a', .62, { eventId: 'g1' }), leg('b', .61, { eventId: 'g1' }), leg('c', .6, { eventId: 'g1' }),
    leg('d', .59, { eventId: 'g2' }), leg('e', .58, { eventId: 'g3' }), leg('f', .57, { eventId: 'g4' }), leg('g', .56, { eventId: 'g5' }),
    leg('a2', .6, { eventId: 'g1', playerId: 'p-a', key: 'a2', lineId: 'a2', market: 'player_rebounds' })];
  const slips = generateEntries(picks, power(3, 6), { count: 3, nowMs: Date.parse(start) - 3600_000, maxPerEvent: 2, maxLegUses: 1 });
  assert.ok(slips.length >= 2);
  const seen = new Set<string>();
  for (const slip of slips) {
    const players = slip.legs.map((item) => picks.find((pick) => pick.lineId === item.lineId)!.playerId);
    assert.equal(new Set(players).size, players.length, 'one leg per player');
    const games = slip.legs.map((item) => item.eventId);
    assert.ok(new Set(games).size >= 2 && games.filter((game) => game === 'g1').length <= 2);
    for (const player of players) { assert.ok(!seen.has(player), 'a player is used once across entries'); seen.add(player); }
  }
  // A sportsbook parlay with an NFL QB: the builder swaps the weakest leg for his receiver (positive stack beats a stronger leg alone).
  const qb = leg('qb', .6, { sport: 'NFL', market: 'passing_yards', eventId: 'kc', team: 'KC', payoutMultiplier: 1.9 });
  const wr = leg('wr', .565, { sport: 'NFL', market: 'player_reception_yds', eventId: 'kc', team: 'KC', payoutMultiplier: 1.9 });
  const other = leg('x', .57, { sport: 'NFL', market: 'player_rush_yds', eventId: 'buf', team: 'BUF', payoutMultiplier: 1.9 });
  const [two] = parlayEntries(4).map(describeEntry);
  const [built] = generateEntries([qb, other, wr], two!, { count: 1, nowMs: Date.parse(start) - 3600_000, minEvents: 1 });
  assert.deepEqual(built!.legs.map((item) => item.lineId).sort(), ['qb', 'wr']);
  assert.ok(built!.expectedReturn > built!.independentExpectedReturn!);
});

test('slip checker suggests the swap that adds the most EV', () => {
  const pool = [leg('a', .52, { eventId: 'g1' }), leg('b', .6, { eventId: 'g2' }), leg('c', .64, { eventId: 'g3' })];
  const suggestion = suggestSwap(power(2, 3), [pool[0]!, pool[1]!], pool, { nowMs: Date.parse(start) - 3600_000 })!;
  assert.deepEqual([suggestion.replaceLineId, suggestion.lineId], ['a', 'c']);
  assert.ok(Math.abs(suggestion.gain - 3 * .6 * (.64 - .52)) < .002);
  assert.equal(suggestSwap(power(2, 3), [pool[2]!, pool[1]!], pool, { nowMs: Date.parse(start) - 3600_000 }), null);
});

test('PrizePicks Goblins and Demons only go into Power entries, never Flex', () => {
  const goblin = leg('g', .95, { eventId: 'g1', lineType: 'GOBLIN', payoutMultiplier: .7 });
  const picks = [goblin, leg('a', .66, { eventId: 'g2' }), leg('b', .64, { eventId: 'g3' })];
  const flex = { type: 'FLEX' as const, size: 2, payouts: { 2: 2, 1: .5 }, label: '2-pick Flex', breakEven: .5 };
  const [built] = generateEntries(picks, flex, { count: 1, nowMs: Date.parse(start) - 3600_000 });
  assert.ok(!built!.legs.some((item) => item.lineId === 'g'));
  const [power] = generateEntries(picks, power2(), { count: 1, nowMs: Date.parse(start) - 3600_000 });
  assert.ok(power!.legs.some((item) => item.lineId === 'g'), '0.95 × 0.7 still beats the regulars in Power');
  assert.ok(evaluateSlip(flex, [goblin, picks[1]!]).warnings.some((warning) => warning.includes('Play them in Power')));
});
const power2 = () => ({ type: 'POWER' as const, size: 2, payouts: { 2: 3 }, label: '2-pick Power', breakEven: Math.sqrt(1 / 3) });

test('Gen builds only from sportsbook-backed legs; stats-only reads stay out', () => {
  const picks = [leg('m1', .67, { eventId: 'g1', tier: 'MODEL' }), leg('m2', .66, { eventId: 'g2', tier: 'MODEL' }),
    leg('a', .6, { eventId: 'g3' }), leg('b', .59, { eventId: 'g4', tier: 'SHARP' })];
  const [built] = generateEntries(picks, power2(), { count: 1, nowMs: Date.parse(start) - 3600_000 });
  assert.deepEqual(built!.legs.map((item) => item.lineId).sort(), ['a', 'b']);
});
