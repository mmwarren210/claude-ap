import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProductLedger } from '../src/product-ledger.js';

test('GKR\'s hit curve reads graded picks by cushion, never falls as the cushion grows, and waits for 150 graded', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'hit-curve-'));
  const decision = (i: number, cushion: number, won: boolean) => ({ trackedPickId: `t${i}`, decisionKey: `k${i}`, sport: 'NFL', market: 'm',
    direction: 'MORE', lineType: 'REGULAR', lineScore: 85, contextScore: 90, thresholdCushion: cushion, modelVersion: 'GKR-X-1.0',
    grade: won ? 'WIN' : 'LOSS', eventId: `e${i}`, playerId: `p${i}`, exactLine: 1 });
  // Small cushions hit half the time, 0.5–1 spreads 60%, but the 0.75 band dips below 0.5's (pooled), 1.5+ hit 80%.
  const rows = [
    ...Array.from({ length: 60 }, (_, i) => decision(i, .1, i % 2 === 0)),
    ...Array.from({ length: 50 }, (_, i) => decision(100 + i, .6, i % 10 < 7)),
    ...Array.from({ length: 30 }, (_, i) => decision(200 + i, .8, i % 10 < 5)),
    ...Array.from({ length: 40 }, (_, i) => decision(300 + i, 2, i % 10 < 8))];
  const file = join(folder, 'ledger.json');
  const save = (decisions: unknown[]) => writeFile(file, JSON.stringify({ version: 2, decisions, profiles: [], crowns: [], follows: [],
    publicCredits: [], accounts: [], sessions: [], savedPicks: [], privateCrowns: [] }));
  await save(rows.slice(0, 100));
  assert.equal(await new ProductLedger(file).gkrHitCurve(), null, 'under 150 graded');
  await save(rows);
  const curve = (await new ProductLedger(file).gkrHitCurve())!;
  assert.equal(curve.graded, 180);
  const rates = curve.bands.map((band) => band.hitRate);
  assert.deepEqual(rates, [...rates].sort((a, b) => a - b), 'rates only rise');
  assert.deepEqual(curve.bands.map((band) => [band.from, band.to]), [[0, .25], [.5, 1], [1.5, null]]);
  assert.equal(curve.bands[1]!.hitRate, .625, '0.5 and 0.75 pooled: 50 of 80');
  const report = await new ProductLedger(file).gkrCalibration();
  assert.ok(report.byCushion['>=2'], 'the calibration report shows cushion bands');
});
