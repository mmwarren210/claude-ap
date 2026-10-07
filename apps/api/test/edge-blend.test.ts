import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgePick } from '@crowniq/contracts';
import { blendPick, blendPicks, GKR_PLUS_VERSION } from '../src/edge/blend.js';

const pick = (options: Partial<EdgePick> & { hitRate?: number | null; games?: number } = {}): EdgePick => {
  const { hitRate = null, games = 0, ...rest } = options;
  return { platform: 'prizepicks', key: 'k', lineId: 'l1', oppositeLineId: null, sport: 'NFL', league: 'NFL', eventId: 'e1',
    eventName: 'A @ B', eventStartTime: '2030-01-01T00:00:00Z', playerId: 'p1', playerName: 'Test Player', market: 'player_rush_yds',
    threshold: 60.5, lineType: 'REGULAR', side: 'MORE', probability: .56, pushProbability: 0, oppositeProbability: .44, breakEven: .5425,
    edge: .0175, requiredPayoutFactor: 1, edgeScore: 60, rating: 'THIN', tier: 'MARKET',
    projection: { mean: 64, median: 64, sd: 20, family: 'NORMAL' }, lineGap: null, fairLine: 64,
    sources: { market: null, stats: games ? { mean: 64, weight: .3, samples: games, recentMean: 64, seasonMean: 64, hitRateAtLine: hitRate } : null, ladder: null },
    reasons: [], warnings: [], calibrated: false, modelVersion: 'edge', ...rest } as EdgePick;
};

test('GKR+: history at the number pulls Edge’s chance toward it, weighted by sample size', () => {
  const strong = blendPick(pick({ hitRate: .8, games: 15 }), null);
  assert.ok(strong.probability > .56 && strong.probability < .8, `blended ${strong.probability}`);
  assert.equal(strong.modelVersion, GKR_PLUS_VERSION);
  const few = blendPick(pick({ hitRate: .8, games: 6 }), null);
  assert.ok(few.probability < strong.probability, 'fewer games count less');
  assert.equal(blendPick(pick({ hitRate: .8, games: 4 }), null).probability, .56, 'under 5 games: Edge alone');
  assert.ok(Math.abs(strong.edge! - (strong.probability - .5425)) < 1e-6);
});

test('GKR+: GKR nudges toward its side, or away when it plays the other side', () => {
  const base = blendPick(pick(), null).probability;
  assert.ok(blendPick(pick(), { direction: 'MORE', score: 90 }).probability > base);
  const against = blendPick(pick(), { direction: 'LESS', score: 90 });
  assert.ok(against.probability < base);
  assert.equal(against.rating, 'NONE', 'pushed under break-even, it is no longer ranked');
  assert.match(against.reasons.join(' '), /GKR plays the other side/);
});

test('GKR+: picks Edge holds back stay held; book EV and stake follow the blended chance; ranked first by edge', () => {
  const held = blendPick(pick({ rating: 'NONE', edge: .2, probability: .74, hitRate: .9, games: 15 }), null);
  assert.equal(held.rating, 'NONE');
  const bet = blendPick(pick({ platform: 'draftkings', decimalOdds: 2, breakEven: .5, edge: .06, probability: .56, ev: .5, kelly: .5,
    hitRate: .8, games: 15 }), null);
  assert.ok(Math.abs(bet.ev! - (bet.probability * 2 - 1)) < 1e-4);
  assert.ok(bet.kelly! <= .02);
  const ranked = blendPicks([pick({ lineId: 'weak' }), pick({ lineId: 'strong', hitRate: .9, games: 15 })], () => null);
  assert.equal(ranked[0]!.lineId, 'strong');
});
