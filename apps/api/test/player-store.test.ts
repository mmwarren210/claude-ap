import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PlayerStore, seasonOf } from '../src/player-store.js';
import { PropLineHistory } from '../src/propline-history.js';
import type { PropLineClient } from '../src/scrapers/propline.js';
import { profileOf, rosterAthletes, seasonSummaries } from '../src/player-profiles.js';
import { ProductLedger } from '../src/product-ledger.js';

/** A trial's login (owner, 2026-10-12: a new trial needs one), unique per device. */
const signup = (device: string) => ({ username: `T_${device.replace(/[^A-Za-z0-9]/g, '').slice(-12)}`, email: `${device}@example.com`, password: 'trial-password-1' });


const now = Date.parse('2030-10-12T00:00:00Z');
const game = (daysAgo: number, hits: number) => ({ at: new Date(now - daysAgo * 86_400_000).toISOString(), opponent: null, home: 'Brewers', away: 'Cubs', stats: { hits } });

test('the store merges games per player, newest first, and folds games older than two seasons into season summaries', () => {
  const store = new PlayerStore(null);
  store.put('baseball_mlb|a', 'baseball_mlb', { at: now, deep: true, teams: true }, [game(1, 2), game(3, 1)], now);
  store.put('baseball_mlb|a', 'baseball_mlb', { at: now, deep: true, teams: true }, [game(1, 3), game(800, 1), game(801, 3)], now);
  const games = store.games('baseball_mlb|a');
  assert.deepEqual(games.map((item) => item.stats.hits), [3, 1], 'the newer copy of a game replaces the old; old games left the rows');
  const seasons = store.seasons('baseball_mlb|a');
  assert.equal(seasons.length, 1);
  assert.equal(seasons[0]!.games, 2);
  assert.equal(seasons[0]!.averages.hits, 2);
  assert.equal(seasonOf('football_nfl', '2030-01-05T00:00:00Z'), '2029-30', 'football seasons span New Year');
  assert.equal(seasonOf('baseball_mlb', '2030-01-05T00:00:00Z'), '2030');
  assert.equal(store.prune(now + 1), 1);
  assert.equal(store.games('baseball_mlb|a').length, 0);
  assert.equal(store.seasons('baseball_mlb|a').length, 1, 'season summaries stay');
});

test('a profile is written only when something changed', () => {
  const store = new PlayerStore(null);
  const profile = { sport: 'MLB', name: 'Aaron Ashby', team: 'Milwaukee Brewers', position: 'RP', bats: 'R', throws: 'L', status: 'Active',
    jersey: '26', espnId: '41325', updatedAt: '2030-10-12T00:00:00.000Z' };
  assert.equal(store.putProfile('aaron ashby', profile), true);
  assert.equal(store.putProfile('aaron ashby', { ...profile, updatedAt: '2030-10-13T00:00:00.000Z' }), false, 'same facts, no write');
  assert.equal(store.putProfile('aaron ashby', { ...profile, status: 'Injured' }), true);
  assert.equal(store.profile('MLB', 'aaron ashby')?.status, 'Injured');
});

test('ESPN roster entries become profiles, grouped or flat', () => {
  const athlete = { id: '41325', fullName: 'Aaron Ashby', jersey: '26', position: { abbreviation: 'RP' }, bats: { abbreviation: 'R' },
    throws: { abbreviation: 'L' }, status: { name: 'Active' } };
  assert.equal(rosterAthletes({ athletes: [{ position: 'pitchers', items: [athlete] }] }).length, 1);
  assert.equal(rosterAthletes({ athletes: [athlete] }).length, 1);
  const profile = profileOf('MLB', 'Milwaukee Brewers', athlete, new Date(now))!;
  assert.deepEqual([profile.position, profile.bats, profile.throws, profile.status], ['RP', 'R', 'L', 'Active']);
  const summary = seasonSummaries('baseball_mlb', [game(1, 2), game(2, 0)], [{ season: '2027', games: 100, averages: { hits: 1.1 } }], 'Brewers');
  assert.deepEqual(summary.map((item) => item.season), ['2030', '2027']);
  assert.equal(summary[0]!.averages.hits, 1);
  assert.equal(summary[0]!.home?.hits, 1, 'all these games were at home');
});

test('the history moves its JSON file into the store once, writes only changed players, and fetches only new games for a fresh log', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(folder, 'propline-history.json');
  await writeFile(file, JSON.stringify([['baseball_mlb|old player', { at: now - 3600_000, games: [game(2, 1)], deep: true, teams: true }]]));
  const asked: string[] = [];
  const client = { get: async (path: string) => { asked.push(path);
    return { games: [{ commence_time: new Date(now - 86_400_000).toISOString(), status: 'final', home_team: 'Brewers', away_team: 'Cubs', stats: { hits: 4 } }] }; } } as unknown as PropLineClient;
  const store = new PlayerStore(join(folder, 'players.sqlite'));
  let clock = now;
  const history = new PropLineHistory(client, file, () => 'baseball_mlb', { store, ttlMs: 1000 }, () => clock);
  await history.ready();
  assert.equal(store.counts().players, 1, 'the JSON file moved in');
  // The old player's log is stale (TTL 1s) but deep and under a week old: only his newest games are asked for, then merged.
  const line = { sport: 'MLB' as const, eventId: 'e', playerName: 'Old Player', eventStartTime: new Date(now + 86_400_000).toISOString(), market: 'batter_hits' };
  const values = await history.values(line);
  assert.ok(asked[0]!.endsWith('limit=15'), asked[0]);
  assert.deepEqual(values !== 'PENDING' && values?.values, [4, 1], 'new game merged with the stored one');
  await history.save();
  assert.equal(store.games('baseball_mlb|old player').length, 2);
  // A new player gets the full log.
  clock += 1;
  await history.values({ ...line, playerName: 'New Player' });
  assert.ok(asked[1]!.endsWith('limit=100'));
  // A fresh start reads the store, not the file.
  const again = new PropLineHistory(client, file, () => 'baseball_mlb', { store, ttlMs: 86_400_000 }, () => clock);
  await history.save();
  assert.equal((await again.cachedFor(line))?.length, 2);
});

test('spot checks: a random sample of unchecked picks, verdicts recorded and tallied', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'audit-'));
  const decision = (i: number, grade: string) => ({ trackedPickId: `t${i}`, decisionKey: `k${i}`, playerName: `P${i}`, sport: 'NFL', market: 'm',
    exactLine: 1, direction: 'MORE', lineType: 'REGULAR', lineScore: 85, modelVersion: 'GKR-X', eventStartTime: '2030-10-11T00:00:00.000Z',
    createdAt: '2030-10-10T00:00:00.000Z', grade, actualResult: null, eventId: `e${i}`, playerId: `p${i}`, thresholdCushion: 1 });
  const file = join(folder, 'ledger.json');
  await writeFile(file, JSON.stringify({ version: 2, decisions: [...Array.from({ length: 6 }, (_, i) => decision(i, i % 2 ? 'WIN' : 'PENDING')),
    { ...decision(9, 'WIN'), createdAt: '2030-01-01T00:00:00.000Z' }], profiles: [], crowns: [], follows: [], publicCredits: [], accounts: [], sessions: [],
    savedPicks: [], privateCrowns: [] }));
  const ledger = new ProductLedger(file, 'PLAYABLE', () => new Date(now));
  const sample = await ledger.auditSample(4, 14, () => .3);
  assert.equal(sample.length, 4);
  assert.ok(!sample.some((item) => item.trackedPickId === 't9'), 'only the last two weeks');
  assert.equal(sample.filter((item) => item.grade === 'WIN').length, 2, 'half graded');
  const summary = await ledger.audit(sample[0]!.trackedPickId, 'WRONG', 'box score says 3');
  assert.deepEqual([summary.checked, summary.wrong], [1, 1]);
  assert.equal((await ledger.audit(sample[0]!.trackedPickId, 'ACCURATE', null)).wrong, 0, 'a second verdict replaces the first');
  assert.ok(!(await ledger.auditSample(10, 14)).some((item) => item.trackedPickId === sample[0]!.trackedPickId), 'checked picks leave the pool');
  await assert.rejects(ledger.audit('nope', 'WRONG', null));
});

test('an account keeps its chosen language', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lang-'));
  const ledger = new ProductLedger(join(folder, 'ledger.json'));
  await ledger.register('spanishfan', 'a-long-password-123', 'fan@example.com');
  const data = JSON.parse(await (await import('node:fs/promises')).readFile(join(folder, 'ledger.json'), 'utf8')) as { accounts: { id: string }[] };
  const id = data.accounts[0]!.id;
  assert.equal(await ledger.language(id), null, 'unset until chosen');
  assert.equal(await ledger.setLanguage(id, 'es'), 'es');
  assert.equal(await ledger.language(id), 'es');
  await assert.rejects(ledger.setLanguage('nobody', 'en'));
});

test('ghost trial accounts give their keys back; a poll answer or a signed-up account is never removed', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ghost-'));
  const ledger = new ProductLedger(join(folder, 'ledger.json'));
  const [key] = await ledger.issueTrialKeys(2, 2);
  await ledger.trialLogin(key!, 'preview-bot', signup('preview-bot'));
  let trials = await ledger.trialUsers();
  assert.equal(trials.length, 1);
  // A trial with a login is a real person (code check, 2026-10-13): never released.
  assert.deepEqual(await ledger.releaseGuests([trials[0]!.accountId]), []);
  // A ghost from before logins were required (a link preview's pass, no login) gives its key back.
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(join(folder, 'ledger.json'), 'utf8'));
  for (const account of raw.accounts) { delete account.passwordHash; delete account.passwordSalt; delete account.email; }
  await writeFile(join(folder, 'ledger.json'), JSON.stringify(raw));
  const reopened = new ProductLedger(join(folder, 'ledger.json'));
  trials = await reopened.trialUsers();
  assert.deepEqual(await reopened.releaseGuests([trials[0]!.accountId]), [trials[0]!.username]);
  assert.equal((await reopened.trialUsers()).length, 0, 'the key is free again');
  await reopened.trialLogin(key!, 'real-person', signup('real-person'));
  assert.equal((await reopened.membership()).trials.used, 1);
  assert.deepEqual(await reopened.releaseGuests(['not-a-guest']), []);
});

test('code check: only players fetched in the last week sit in memory; older ones are read from the store when asked', async () => {
  const store = new PlayerStore(null);
  const now = Date.parse('2026-10-13T12:00:00Z');
  store.put('icehockey_nhl|old player', 'icehockey_nhl', { at: now - 10 * 86_400_000, deep: true, teams: true },
    [{ at: '2026-10-01T00:00:00.000Z', opponent: null, home: 'A', away: 'B', stats: { goals: 1 } }], now);
  store.put('icehockey_nhl|new player', 'icehockey_nhl', { at: now - 86_400_000, deep: true, teams: true },
    [{ at: '2026-10-11T00:00:00.000Z', opponent: null, home: 'A', away: 'B', stats: { goals: 2 } }], now);
  assert.deepEqual([...store.all(now - 7 * 86_400_000).keys()], ['icehockey_nhl|new player']);
  assert.equal(store.fetch('icehockey_nhl|old player')?.at, now - 10 * 86_400_000);
  assert.equal(store.all().size, 2);
});
