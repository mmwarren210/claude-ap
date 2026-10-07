import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrapedLineStore } from '../src/scrapers/line-store.js';

test('concurrent callers after a restart share one read of the saved lines file', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-lines-'));
  const file = join(folder, 'lines.json'), now = new Date('2030-09-24T12:00:00Z');
  const promises = fs.promises as unknown as { readFile: (...args: unknown[]) => Promise<unknown> };
  const original = promises.readFile;
  try {
    const writer = new ScrapedLineStore(file, () => now);
    await writer.ingest('ud', [{ app: 'underdog', appLineId: 'u1', league: 'NFL', gameId: 'g1', player: 'Player A', team: 'CHI',
      teamName: 'Chicago Bears', opponent: 'GB', stat: 'Receptions', line: 4.5, tier: 'REGULAR', directions: ['MORE', 'LESS'],
      startTime: '2030-09-25T00:00:00.000Z', imageUrl: null, multipliers: { MORE: 1.8, LESS: 1.9 } }], { complete: true, apps: ['underdog'] });
    let reads = 0;
    promises.readFile = async (...args: unknown[]) => { if (String(args[0]) === file) reads++; return original.apply(fs.promises, args); };
    syncBuiltinESMExports();
    const restarted = new ScrapedLineStore(file, () => now);
    const results = await Promise.all(Array.from({ length: 40 }, () => restarted.active('underdog')));
    assert.equal(reads, 1, 'one read, not one per caller');
    assert.ok(results.every((lines) => lines.length === 1));
  } finally {
    promises.readFile = original; syncBuiltinESMExports();
    await rm(folder, { recursive: true, force: true });
  }
});
