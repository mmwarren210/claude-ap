import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StatApiArchive } from '../src/stat-api-archive.js';

const until = async (archive: StatApiArchive) => { while ((await archive.status()).running) await new Promise((done) => setTimeout(done, 5)); };

test('archive saves base tables, games by season and game logs by player, and resumes after a quota stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stat-archive-'));
  let calls = 0, quotaAfter = 5;
  const seen: string[] = [];
  const fetchFn = (async (input: URL) => {
    calls++;
    if (calls > quotaAfter) return new Response('{}', { status: 429 });
    const table = input.pathname.split('/').slice(4).join('/'), from = Number(input.searchParams.get('from_id'));
    seen.push(`${table}?${input.searchParams}`);
    if (table.startsWith('game_player') || table === 'player_rounds') {
      if (!input.searchParams.get('player_id')) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ [table]: [{ id: 1, player_id: Number(input.searchParams.get('player_id')) }], next_from_id: null }));
    }
    const row = table === 'seasons' ? { id: 1, start_year: 2025 } : { id: from + 1 };
    return new Response(JSON.stringify({ [table]: [row], next_from_id: from === 0 && table === 'players' ? 1 : null }),
      { headers: { 'x-quota-remaining': '9' } });
  }) as unknown as typeof fetch;
  const archive = new StatApiArchive('key', dir, fetchFn, async () => {});
  archive.start(); await until(archive);
  assert.equal((await archive.status()).stopReason, 'QUOTA_EXHAUSTED');
  quotaAfter = Infinity;
  archive.start(); await until(archive);
  const status = await archive.status();
  assert.equal(status.stopReason, null);
  assert.equal((await readFile(join(dir, 'NFL_players.jsonl'), 'utf8')).trim().split('\n').length, 2);
  assert.ok(seen.some((item) => item.startsWith('games?season_id=2025')));
  assert.equal(status.tables.NFL_game_player_stats.requests, 2);
  assert.equal(status.tables.MLB_game_player_pitching_stats.rows, 2);
  assert.equal(await archive.file('../etc'), null);
  assert.ok(await archive.file('NFL_game_player_stats.jsonl'));
});
