import assert from 'node:assert/strict';
import test from 'node:test';
import type { Analysis, EdgePick } from '@crowniq/contracts';
import { GKR3_MIN_CHANCE, gkr3Read } from '../src/gkr3.js';
import { whyDifferent } from '../src/gkr2-reads.js';

const analysis = (over: Partial<Analysis>) => ({ lineId: 'l', direction: 'MORE', score: 80, contextBreakdown: [], ...over }) as unknown as Analysis;
const edge = (over: Partial<EdgePick>) => ({ side: 'MORE', probability: .6, oppositeProbability: .4, threshold: 4.5,
  sources: { market: null, stats: { mean: 5, weight: .5, samples: 20, recentMean: 5, seasonMean: 5, hitRateAtLine: .7 }, ladder: null }, ...over }) as unknown as EdgePick;

test('GKR 3 blends GKR 2, Edge and history on GKR 2\'s side, the way GKR+ blends', () => {
  const read = gkr3Read(analysis({}), edge({}))!;
  assert.equal(read.side, 'MORE');
  assert.ok(read.chance > .6 && read.chance < .8, `blended ${read.chance}`);
  assert.equal(read.reasons.length, 3);
  // Edge on the other side pulls it down; far enough and GKR 3 passes.
  assert.equal(gkr3Read(analysis({ score: 60 }), edge({ side: 'LESS', probability: .8, oppositeProbability: .2,
    sources: { market: null, stats: { mean: 3, weight: .5, samples: 20, recentMean: 3, seasonMean: 3, hitRateAtLine: .85 }, ladder: null } } as never)), null);
  assert.equal(gkr3Read(analysis({ direction: 'PASS', score: null }), edge({})), null, 'no GKR 2 play, no GKR 3 play');
  assert.ok((gkr3Read(analysis({}), undefined)?.chance ?? 0) >= GKR3_MIN_CHANCE, 'GKR 2 alone when Edge has no read');
});

test('why GKR 2 differs from GKR, in plain words', () => {
  const gkr = analysis({ score: 70, contextBreakdown: [{ name: 'shot_volume', measured: true }] as never });
  const two = analysis({ score: 82, contextBreakdown: [{ name: 'shot_volume', measured: true }, { name: 'game_script', measured: true }] as never });
  assert.match(whyDifferent(gkr, two)!, /12 points higher.*game script/);
  assert.equal(whyDifferent(gkr, analysis({ score: 72 })), null, 'within 5 points is the same read');
  assert.match(whyDifferent(gkr, analysis({ direction: 'LESS', score: 75 }))!, /opposite sides/);
  assert.match(whyDifferent(analysis({ direction: 'PASS', score: null }), two)!, /GKR passes/);
});
