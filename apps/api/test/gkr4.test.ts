import assert from 'node:assert/strict';
import test from 'node:test';
import type { Analysis, EdgePick } from '@crowniq/contracts';
import { CALIBRATE_MIN, DEFAULT_WEIGHTS, GKR4_MIN_CHANCE, LEARN_MIN, gkr4Parts, gkr4Read, learnGkr4 } from '../src/gkr4.js';

const analysis = (over: Partial<Analysis>) => ({ lineId: 'l', direction: 'MORE', score: 80, contextBreakdown: [], ...over }) as unknown as Analysis;
const edge = (over: Partial<EdgePick>) => ({ side: 'MORE', probability: .6, oppositeProbability: .4, threshold: 4.5,
  projection: { mean: 5, median: 5, sd: 1.5, family: 'NORMAL' },
  sources: { market: { mean: 5, weight: .5, books: [{ bookmaker: 'fanduel', point: 4.5, overPrice: 1.8, underPrice: 2, fairOver: .58, twoSided: true },
    { bookmaker: 'draftkings', point: 5.5, overPrice: 2.4, underPrice: 1.6, fairOver: .4, twoSided: true }] },
  stats: { mean: 5, weight: .5, samples: 20, recentMean: 6, seasonMean: 5, hitRateAtLine: .7 }, ladder: null,
  anchors: { mean: 5, weight: .1, thresholds: [5] } }, ...over }) as unknown as EdgePick;

test('GKR 4 reads books at the same number, form, the other apps, opponent and role on GKR 2\'s side', () => {
  const parts = gkr4Parts(analysis({ contextBreakdown: [
    { name: 'opponent_pace', contribution: 3, weight: 6, measured: true, explanation: 'x' },
    { name: 'overall_usage', contribution: -2, weight: 4, measured: true, explanation: 'x' },
    { name: 'role_opportunity', contribution: 0, weight: 4, measured: false, explanation: 'x' }] as Analysis['contextBreakdown'] }),
    edge({ injury: 'Questionable' }), 'MORE')!;
  assert.equal(parts.side, 'MORE');
  assert.equal(parts.parts.books, .58, 'only the book at 4.5 counts');
  assert.ok(parts.parts.form! > .5, 'averaging 6 against 4.5 favors MORE');
  assert.ok(parts.parts.apps! > .5, 'a higher number elsewhere favors MORE here');
  assert.equal(parts.parts.opponent, .575);
  assert.ok(parts.parts.role! < .5, 'usage down and an injury tag hurt MORE');
  assert.equal(parts.parts.script, .75);
  const read = gkr4Read(parts, 'NBA', null)!;
  assert.ok(read.chance >= GKR4_MIN_CHANCE && read.chance < .9, `blended ${read.chance}`);
  assert.equal(read.chance, read.raw, 'no calibration before any graded picks');
  assert.equal(gkr4Read(gkr4Parts(analysis({ direction: 'PASS', score: null }), edge({})), 'NBA', null), null);
});

test('GKR 4 at another app\'s number uses that app\'s Edge chance and drops PrizePicks-only reads', () => {
  const parts = gkr4Parts(analysis({}), edge({}), null, { threshold: 5.5, probability: .7, side: 'LESS' })!;
  assert.ok(Math.abs(parts.parts.edge! - .3) < 1e-9);
  assert.equal(parts.parts.history, undefined);
  assert.equal(parts.parts.apps, undefined);
  assert.equal(parts.parts.books, .4, 'the book at 5.5');
  assert.ok(parts.parts.form! > .5);
});

test('GKR 4 learns weights from graded picks and corrects its chance bands', () => {
  // Books always right, Edge always a coin flip: books should gain weight over Edge.
  const rows = Array.from({ length: LEARN_MIN + 40 }, (_, index) => {
    const hit = index % 4 !== 0;
    return { sport: 'NHL', raw: .7, hit, parts: { gkr2: .7, edge: index % 2 ? .7 : .4, books: hit ? .7 : .35 } };
  });
  const learned = learnGkr4(rows);
  assert.ok(learned.weights.NHL!.books > DEFAULT_WEIGHTS.books, `books ${learned.weights.NHL!.books}`);
  assert.ok(learned.weights.NHL!.edge < DEFAULT_WEIGHTS.edge, `edge ${learned.weights.NHL!.edge}`);
  assert.equal(learned.weights.NBA, undefined, 'NBA uses the pooled weights');
  assert.ok(learned.graded >= CALIBRATE_MIN);
  const band = learned.bands.find((item) => item.low === .7)!;
  assert.ok(band.hitRate > .7 && band.hitRate < .76, `band ${band.hitRate}`);
  for (let index = 1; index < learned.bands.length; index++) assert.ok(learned.bands[index]!.hitRate >= learned.bands[index - 1]!.hitRate);
  const read = gkr4Read({ side: 'MORE', parts: { gkr2: .7, books: .7 }, reasons: [] }, 'NHL', learned)!;
  assert.equal(read.chance, band.hitRate);
});
