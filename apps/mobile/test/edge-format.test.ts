import assert from 'node:assert/strict';
import test from 'node:test';
import { edgePickSchema } from '@crowniq/contracts';
import { dayRange, edgeSummary, lineComparison, marketLabel, signedPoints, sportsFrom, toggleSlipLeg } from '../src/edge-format.js';

const base = edgePickSchema.parse({ key: 'k1', lineId: 'l1', oppositeLineId: null, sport: 'NBA', league: 'NBA',
  eventId: 'e1', eventName: 'A @ B', eventStartTime: '2030-01-02T00:00:00Z', playerId: 'p1', playerName: 'Fixture',
  market: 'player_points_rebounds_assists', threshold: 30.5, lineType: 'REGULAR', side: 'MORE', probability: .6,
  pushProbability: 0, oppositeProbability: .4, breakEven: .5421, edge: .0579, requiredPayoutFactor: .9035,
  edgeScore: 84.7, rating: 'STRONG', tier: 'SHARP', projection: { mean: 33, median: 33, sd: 8, family: 'NEGBIN' },
  lineGap: 2.5, fairLine: 32.5, sources: { market: null, stats: null, ladder: null }, reasons: [], warnings: [], calibrated: false,
  modelVersion: 'EDGE-1.0' });

test('Edge labels and summaries read naturally', () => {
  assert.equal(marketLabel('player_points_rebounds_assists'), 'Pts + Rebs + Asts');
  assert.equal(marketLabel('batter_rbis'), 'Rbis');
  assert.equal(marketLabel('player_double_faults'), 'Double Faults');
  assert.equal(signedPoints(.0579), '+5.8');
  assert.equal(signedPoints(-.02), '−2.0');
  assert.equal(edgeSummary(base), '60.0% to hit · +5.8 pts vs 54.2% break-even');
  assert.equal(edgeSummary({ ...base, edge: null, lineType: 'GOBLIN' }), '60.0% to hit · needs payout factor ≥ 0.90×');
  assert.deepEqual(sportsFrom([base, { ...base, sport: 'MLB' }, base]), ['MLB', 'NBA']);
});

test('slip legs toggle, replace the same player and cap at six', () => {
  let legs = toggleSlipLeg([], base);
  assert.equal(legs.length, 1);
  legs = toggleSlipLeg(legs, { ...base, lineId: 'l2', key: 'k2' });
  assert.deepEqual(legs.map((leg) => leg.lineId), ['l2']);
  assert.equal(toggleSlipLeg(legs, legs[0]).length, 0);
  const many = Array.from({ length: 6 }, (_, index) => ({ ...base, lineId: 'x' + index, playerId: 'p' + index }));
  assert.equal(toggleSlipLeg(many, { ...base, lineId: 'new', playerId: 'new' }).length, 6);
});

test('Edge line comparison and generator day windows', () => {
  assert.equal(lineComparison(base), 'PP 30.5 · Edge line 32.5');
  assert.deepEqual(dayRange('all', Date.now()), {});
  const now = new Date(2030, 0, 2, 15, 30).getTime();
  const today = dayRange('today', now), tomorrow = dayRange('tomorrow', now);
  assert.equal(new Date(today.from!).getHours(), 0);
  assert.equal(Date.parse(today.to!) - Date.parse(today.from!), 86400_000);
  assert.equal(tomorrow.from, today.to);
  assert.ok(Date.parse(today.from!) <= now && now < Date.parse(today.to!));
});
