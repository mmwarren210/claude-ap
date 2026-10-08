import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryArchive } from '../src/history-archive.js';
import { ScrapedLineStore } from '../src/scrapers/line-store.js';
import type { ScrapedLine } from '../src/scrapers/scraped-line.js';

test('the archive appends each record once per key, by stream and month, and keeps lines the store lets go', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-archive-'));
  try {
    let now = new Date('2030-10-04T12:00:00Z');
    const archive = new HistoryArchive(folder, () => now);
    assert.equal(await archive.append('results', [{ key: 'e:p:m', record: { actual: 7 } }, { key: 'e:p:m', record: { actual: 7 } }]), 1);
    assert.equal(await archive.append('results', [{ key: 'e:p:m', record: { actual: 7 } }]), 0, 'already written');
    const line: ScrapedLine = { app: 'underdog', appLineId: 'u1', league: 'NFL', gameId: 'g1', player: 'Test Player', team: 'BUF',
      teamName: null, opponent: 'MIA', stat: 'Rush Yards', line: 64.5, tier: 'REGULAR', directions: ['MORE', 'LESS'],
      startTime: '2030-10-04T17:00:00Z', imageUrl: null };
    const store = new ScrapedLineStore(null, () => now, archive);
    await store.ingest('zen', [line], { complete: true, apps: ['underdog'] });
    await store.ingest('zen', [line], { complete: true, apps: ['underdog'] });
    await store.ingest('zen', [{ ...line, line: 66.5 }], { complete: true, apps: ['underdog'] });
    now = new Date('2030-11-01T12:00:00Z');
    await archive.append('games', [{ key: 'g', record: { metrics: { yards: 80 } } }]);
    const files = (await readdir(folder)).sort();
    assert.deepEqual(files, ['games-2030-11.jsonl', 'lines-2030-10.jsonl', 'results-2030-10.jsonl']);
    const lines = (await readFile(join(folder, 'lines-2030-10.jsonl'), 'utf8')).trim().split('\n').map((row) => JSON.parse(row));
    assert.deepEqual(lines.map((row) => [row.line, row.previousLine]), [[64.5, null], [66.5, 64.5]], 'new, then the move; no repeat');
    assert.deepEqual(Object.keys((await archive.status()).streams).sort(), ['games', 'lines', 'results']);
    // A restarted server reads this month's keys back and doesn't write them twice.
    const restarted = new HistoryArchive(folder, () => now);
    assert.equal(await restarted.append('games', [{ key: 'g', record: {} }, { key: 'g2', record: {} }]), 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('the archive pauses when the volume runs low, so the app’s own saves keep their room', async () => {
  const { mkdtemp, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-archive-low-'));
  let free = 10e6;
  try {
    const archive = new HistoryArchive(folder, () => new Date('2030-10-08T12:00:00Z'), 60e6, async () => free);
    assert.equal(await archive.append('games', [{ key: 'a', record: { x: 1 } }]), 0, 'under 60 MB free: nothing written');
    assert.deepEqual(await readdir(folder), []);
    free = 200e6;
    assert.equal(await archive.append('games', [{ key: 'a', record: { x: 1 } }]), 1, 'room again: written');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
