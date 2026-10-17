import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expectedGoals } from '../src/context/sharp-props.js';
import type { GamePrice } from '../src/context/sharp-props.js';
import { InternalHistoryStore } from '../src/internal-history.js';
import type { InternalHistoryRow } from '../src/internal-history.js';
import { PlayerStore } from '../src/player-store.js';
import { PropLineHistory, turnTaker } from '../src/propline-history.js';
import type { PropLineClient } from '../src/scrapers/propline.js';

const NOW = Date.parse('2030-10-12T00:00:00Z');

test('the player store pages through recent players and prunes in batches, keeping season summaries', () => {
  const store = new PlayerStore(null);
  try {
    for (let i = 0; i < 250; i++) store.put(`baseball_mlb|p${String(i).padStart(3, '0')}`, 'baseball_mlb', { at: i < 200 ? NOW : NOW - 40 * 86_400_000 },
      [{ at: '2030-10-01T00:00:00Z', opponent: 'B', stats: { hits: i } }, { at: '2027-05-01T00:00:00Z', opponent: 'A', stats: { hits: 2 } }], NOW);
    const paged = new Map<string, unknown>();
    for (let page = store.recentPage(NOW - 1, ''); page.length; page = store.recentPage(NOW - 1, page[page.length - 1]!.key, 64))
      for (const { key, fetch, games } of page) paged.set(key, { fetch, games });
    assert.deepEqual(paged, store.all(NOW - 1));
    assert.equal(paged.size, 200);
    let pruned = 0;
    for (let gone = store.pruneSome(NOW - 30 * 86_400_000, 20); gone; gone = store.pruneSome(NOW - 30 * 86_400_000, 20)) pruned += gone;
    assert.equal(pruned, 50);
    assert.equal(store.counts().players, 200);
    // Every player's game from 2027 was folded into a season summary, and pruning keeps those.
    assert.equal(store.counts().seasons, 250);
  } finally { store.close(); }
});

test('rewriting a player with the same games changes nothing', () => {
  const store = new PlayerStore(null);
  try {
    const games = [{ at: '2030-10-01T00:00:00Z', opponent: 'B', stats: { hits: 1 } }];
    store.put('baseball_mlb|x', 'baseball_mlb', { at: NOW }, games, NOW);
    store.put('baseball_mlb|x', 'baseball_mlb', { at: NOW }, [...games, { at: '2030-10-02T00:00:00Z', opponent: 'C', stats: { hits: 3 } }], NOW);
    store.put('baseball_mlb|x', 'baseball_mlb', { at: NOW }, [{ at: '2030-10-01T00:00:00Z', opponent: 'B', stats: { hits: 4 } }], NOW);
    assert.deepEqual(store.games('baseball_mlb|x').map((game) => [game.at.slice(0, 10), game.stats.hits]), [['2030-10-02', 3], ['2030-10-01', 4]]);
  } finally { store.close(); }
});

test('overlapping saves share one pass, and a failed write is retried next time', async () => {
  const store = new PlayerStore(null);
  try {
    const client = { get: async () => ({ games: [{ status: 'final', commence_time: '2030-10-01T00:00:00Z', stats: { hits: 2 } }] }) } as unknown as PropLineClient;
    const history = new PropLineHistory(client, null, () => 'baseball_mlb', { store }, () => NOW);
    await history.values({ sport: 'MLB', eventId: 'e', playerName: 'Some Player', market: 'batter_hits', eventStartTime: '2030-10-13T00:00:00Z' });
    const put = store.put.bind(store);
    let writes = 0;
    store.put = (...args) => { writes++; if (writes === 1) throw new Error('DISK_BUSY'); put(...args); };
    await assert.rejects(history.save(), /DISK_BUSY/);
    await Promise.all([history.save(), history.save()]);
    assert.equal(writes, 2);
    assert.equal(store.games('baseball_mlb|some player')[0]?.stats.hits, 2);
  } finally { store.close(); }
});

test('the turn taker yields only once its time slice is used', async () => {
  const turn = turnTaker(20);
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 1);
  await turn();
  const before = ticks;
  const until = Date.now() + 30;
  while (Date.now() < until) { /* busy */ }
  await turn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearInterval(ticker);
  assert.ok(ticks >= before);
});

test('total goals ignore an absurd feed total without changing real ones', () => {
  const pair = (line: number, over = .52): GamePrice[] => (['over', 'under'] as const).map((side) => ({ book: 'b', league: 'nhl', sport: 'NHL',
    eventId: `e${line}`, home: 'A', away: 'B', startTime: '2030-10-13T00:00:00Z', market: 'total', line, side,
    probability: side === 'over' ? over : 1 - over, american: -110 }));
  const goals = expectedGoals([...pair(5.5), ...pair(6.5, .45)]);
  assert.ok(goals.get('e5.5')! > 5 && goals.get('e5.5')! < 6.5);
  assert.ok(goals.get('e6.5')! > 5.5 && goals.get('e6.5')! < 7);
  const started = Date.now();
  expectedGoals(pair(1e12 + .5));
  assert.ok(Date.now() - started < 500);
});

test('history lookups by ID or name return the same rows, order and limits as a full scan', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'history-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new InternalHistoryStore(join(dir, 'history.json'));
  const base = { sport: 'NFL' as const, sourcePlayerId: null, metrics: { passing_yds: 200 }, marketValues: {}, sourceKind: 'SEED_BACKFILL' as const,
    sourceName: 'fixture', sourceUrl: 'https://example.org', sourceType: 'PUBLIC' as const, importedAt: '2030-10-12T00:00:00Z', modelVersion: null,
    line: null, direction: null, lineScore: null, dataConfidence: null };
  const rows: InternalHistoryRow[] = [];
  for (let i = 0; i < 60; i++) rows.push({ ...base, id: `r${i}`, eventId: `g${i}`, playerId: i % 3 ? 'p' : 'other', playerName: i % 4 ? 'José Doe' : 'Someone Else',
    sport: i % 7 ? 'NFL' : 'NBA', occurredAt: `2030-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 5)).padStart(2, '0')}T00:00:00Z` } as InternalHistoryRow);
  await store.add(rows);
  const target = { sport: 'NFL' as const, league: 'NFL', playerId: 'p', playerName: 'Jose Doe', eventId: 'x', eventName: 'A @ B',
    eventStartTime: '2030-07-01T00:00:00Z', team: null, opponent: null, market: 'passing_yards' };
  // The full scan the index replaced.
  const scan = (limit: number) => rows.filter((row) => row.sport === target.sport && (row.playerId === target.playerId || row.playerName === 'José Doe') &&
    Date.parse(row.occurredAt) < Date.parse(target.eventStartTime)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit).map((row) => row.id);
  assert.deepEqual((await store.rowsFor(target)).map((row) => row.id), scan(40));
  assert.deepEqual((await store.rowsFor(target, 5)).map((row) => row.id), scan(5));
  assert.deepEqual((await store.rowsForTargets([target], 7)).get(target)!.map((row) => row.id), scan(7));
  await store.add([{ ...rows[1]!, id: 'newest', occurredAt: '2030-06-30T00:00:00Z' }]);
  assert.equal((await store.rowsFor(target, 1))[0]!.id, 'newest');
});

test('positions come back by sport and the same name key the app uses', async () => {
  const { PlayerProfiles } = await import('../src/player-profiles.js');
  const { positionKey } = await import('../../mobile/src/position-key.js');
  const { normalizedName } = await import('../src/context/match.js');
  const store = new PlayerStore(null);
  try {
    store.putProfile(normalizedName('Kenneth Walker III'), { sport: 'NFL', name: 'Kenneth Walker III', team: 'Seattle Seahawks', position: 'RB',
      bats: null, throws: null, status: 'Active', jersey: '9', espnId: '1', updatedAt: '2030-10-12T00:00:00Z' });
    store.putProfile(normalizedName('José Ramírez'), { sport: 'MLB', name: 'José Ramírez', team: 'Cleveland Guardians', position: '3B',
      bats: 'S', throws: 'R', status: 'Active', jersey: '11', espnId: '2', updatedAt: '2030-10-12T00:00:00Z' });
    const positions = new PlayerProfiles(store).positions();
    assert.equal(positions.NFL?.[positionKey('Kenneth Walker')], 'RB');
    assert.equal(positions.MLB?.[positionKey('Jose Ramirez')], '3B');
    for (const name of ["D'Andre Swift", 'A.J. Brown', 'Michael Pittman Jr.', 'Luka Dončić'])
      assert.equal(positionKey(name), normalizedName(name));
  } finally { store.close(); }
});
