import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ARCHIVE_TABLES, StatApiArchive } from '../src/stat-api-archive.js';

test('archive pages every table to its end and resumes where it stopped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stat-archive-'));
  let calls = 0, quotaAfter = 3;
  const fetchFn = (async (input: URL) => {
    calls++;
    if (calls > quotaAfter) return new Response('{}', { status: 429 });
    const table = input.pathname.split('/').pop()!, from = Number(input.searchParams.get('from_id') ?? 0);
    const body = from ? { [table]: [{ id: from }], next_from_id: null } : { [table]: [{ id: 1 }], next_from_id: 2 };
    return new Response(JSON.stringify(body), { headers: { 'x-quota-remaining': '9' } });
  }) as unknown as typeof fetch;
  const archive = new StatApiArchive('key', dir, fetchFn, async () => {});
  assert.equal(archive.start(), true);
  while ((await archive.status()).running) await new Promise((done) => setTimeout(done, 5));
  let status = await archive.status();
  assert.equal(status.stopReason, 'QUOTA_EXHAUSTED');
  assert.equal(status.tables.NFL_seasons.done, true);
  assert.equal(status.tables.NFL_seasons.rows, 2);
  assert.equal((await readFile(join(dir, 'NFL_seasons.jsonl'), 'utf8')).trim().split('\n').length, 2);
  quotaAfter = Infinity;
  archive.start();
  while ((await archive.status()).running) await new Promise((done) => setTimeout(done, 5));
  status = await archive.status();
  assert.equal(status.stopReason, null);
  assert.equal(status.tablesDone, Object.values(ARCHIVE_TABLES).flat().length);
  assert.equal(status.tables.NFL_teams.rows, 2);
  assert.equal(await archive.file('../etc'), null);
  assert.ok(await archive.file('NFL_seasons.jsonl'));
});
