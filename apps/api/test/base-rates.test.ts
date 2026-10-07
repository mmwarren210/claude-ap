import assert from 'node:assert/strict';
import test from 'node:test';
import type { PropLine } from '@crowniq/contracts';
import { BaseRates, TREND_MIN } from '../src/base-rates.js';
import type { BoxScoreResults } from '../src/box-score-results.js';

const line = (index: number, threshold = 0.5) => ({ id: `l${index}`, eventId: `e${index}`, playerId: `p${index}`, sport: 'MLB',
  league: 'MLB', market: 'batter_hits', threshold, lineType: 'REGULAR', availableDirections: ['MORE', 'LESS'],
  eventStartTime: '2030-10-05T20:00:00Z', playerName: `Player ${index}`, team: 'NYY' }) as unknown as PropLine;

test('base rates: every standard line graded into counts; a clear side becomes a Trend after enough lines', async () => {
  let now = new Date('2030-10-05T12:00:00Z');
  const actual = (index: number) => index % 10 < 4 ? 1 : 0; // 40% over, 60% under
  const boxScores = { results: async (targets: { eventId: string; playerId: string; lineSnapshot: PropLine }[]) => ({ unsupported: 0,
    waiting: 0, facts: targets.map((target) => { const index = Number(target.eventId.slice(1));
      return { eventId: target.eventId, playerId: target.playerId, market: target.lineSnapshot.market, status: 'FINAL' as const,
        actual: actual(index), sourceName: 'test', sourceUrl: 'https://example.org', completedAt: now.toISOString() }; }) }) } as unknown as BoxScoreResults;
  const rates = new BaseRates(null, boxScores, () => now);
  const lines = Array.from({ length: TREND_MIN.number }, (_, index) => line(index));
  await rates.record([...lines, { ...line(999), lineType: 'GOBLIN' } as PropLine]);
  assert.equal((await rates.status()).pending, TREND_MIN.number, 'Goblins are left out');
  assert.equal(await rates.trendFor(line(0)), null, 'nothing graded yet');
  now = new Date('2030-10-06T03:00:00Z');
  assert.equal(await rates.grade(), TREND_MIN.number);
  const trend = await rates.trendFor({ ...line(0), eventStartTime: '2030-10-07T20:00:00Z' } as PropLine);
  assert.equal(trend?.side, 'LESS');
  assert.equal(trend?.rate, 0.6);
  assert.equal(trend?.scope, 'number');
  assert.equal(await rates.trendFor(line(0, 1.5)), null, 'another number has too few lines, and the stat needs more');
  assert.equal(await rates.trendFor({ ...line(0), availableDirections: ['MORE'] } as PropLine), null, 'the side must be offered');
});

test('Trends for every line at once after a restart share one read of the saved file', async () => {
  const fs = (await import('node:fs')).default;
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { syncBuiltinESMExports } = await import('node:module');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-rates-')), file = join(folder, 'base-rates.json');
  const promises = fs.promises as unknown as { readFile: (...args: unknown[]) => Promise<unknown> };
  const original = promises.readFile;
  try {
    await writeFile(file, JSON.stringify({ pending: {}, counts: {} }));
    let reads = 0;
    promises.readFile = async (...args: unknown[]) => { if (String(args[0]) === file) reads++; return original.apply(fs.promises, args); };
    syncBuiltinESMExports();
    const rates = new BaseRates(file, null);
    await Promise.all(Array.from({ length: 50 }, () => rates.trendFor({ sport: 'NFL', market: 'player_receptions', threshold: 4.5,
      availableDirections: ['MORE', 'LESS'] })));
    assert.equal(reads, 1);
  } finally {
    promises.readFile = original; syncBuiltinESMExports();
    await rm(folder, { recursive: true, force: true });
  }
});
