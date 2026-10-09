import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApifyClient } from '../src/scrapers/apify-client.js';
import { ScrapedLineStore } from '../src/scrapers/line-store.js';
import { marketKey, ScrapedPrizePicksProvider } from '../src/scrapers/scraped-prizepicks-provider.js';
import type { ScrapedLine } from '../src/scrapers/scraped-line.js';
import { ScraperPuller } from '../src/scrapers/scraper-puller.js';
import { DailySpendBudget } from '../src/scrapers/spend-budget.js';
import { readPrizePicksRow } from '../src/scrapers/prizepicks-partner.js';
import type { ScraperSource } from '../src/scrapers/scraped-line.js';

const now = new Date('2030-10-03T20:00:00.000Z');
// PrizePicks rows as the partner feed flattens them; every player and number is synthetic.
const row = (overrides: Record<string, unknown> = {}) => ({ projection_id: '1001', line: 64.5, stat: 'Receiving Yards',
  stat_short: 'Rec Yards', odds_tier: 'standard', status: 'pre_game', is_live: false, in_game: false, event_type: 'team',
  allowed_wager_types: 'under_or_over', player_name: 'Test Receiver', player_team: 'JAC', player_team_name: 'Jaguars',
  player_image: 'https://static.prizepicks.com/images/players/test.png', player_combo: false, league: 'NFL',
  game_external_id: 'NFL_game_1', start_time: '2030-10-04T13:00:00.000-04:00', game_start: '2030-10-04T13:00:00.000-04:00',
  home_team: 'CIN', home_team_name: 'Bengals', away_team: 'JAC', away_team_name: 'Jaguars', ...overrides });
const line = (overrides: Record<string, unknown> = {}, app: ScrapedLine['app'] = 'prizepicks'): ScrapedLine => {
  const result = readPrizePicksRow(row(overrides), now);
  if ('skip' in result) throw new Error(result.skip);
  return { ...result.line, app };
};
// A paid-actor source for the puller tests (the puller still runs Apify actors for any source that names one).
const actorSource: ScraperSource = { id: 'test-actor', actor: 'test/actor', apps: ['prizepicks'], rowCap: null, input: () => ({}),
  read: readPrizePicksRow };
const otherSource: ScraperSource = { ...actorSource, id: 'test-other' };

test('PrizePicks rows become lines with the right sides, tier, teams and photo, and unreadable rows are skipped', () => {
  const regular = line();
  assert.deepEqual([regular.app, regular.tier, regular.directions, regular.stat, regular.line, regular.opponent, regular.startTime],
    ['prizepicks', 'REGULAR', ['MORE', 'LESS'], 'Rec Yards', 64.5, 'CIN', '2030-10-04T17:00:00.000Z']);
  assert.equal(regular.imageUrl, 'https://static.prizepicks.com/images/players/test.png');
  assert.deepEqual(line({ odds_tier: 'demon', allowed_wager_types: 'over' }).directions, ['MORE']);
  assert.deepEqual(line({ allowed_wager_types: null }).directions, ['MORE', 'LESS']);
  assert.deepEqual(line({ odds_tier: 'goblin', allowed_wager_types: null }).directions, ['MORE']);
  // Team logos and placeholders are not player photos.
  assert.equal(line({ player_image: 'https://static.prizepicks.com/images/teams/nfl/x/2.webp' }).imageUrl, null);
  assert.equal(line({ player_image: 'https://static.prizepicks.com/images/players/placeholder.png' }).imageUrl, null);
  const skip = (overrides: Record<string, unknown>) => {
    const result = readPrizePicksRow(row(overrides), now); return 'skip' in result ? result.skip : null;
  };
  assert.equal(skip({ player_combo: true }), 'COMBO_PLAYER');
  assert.equal(skip({ is_live: true }), 'LIVE_OR_STARTED');
  assert.equal(skip({ in_game: true }), 'LIVE_OR_STARTED');
  assert.equal(skip({ status: 'suspended' }), 'LIVE_OR_STARTED');
  assert.equal(skip({ start_time: '2030-10-03T19:00:00.000Z', game_start: null }), 'LIVE_OR_STARTED');
  assert.equal(skip({ odds_tier: 'flex' }), 'UNKNOWN_TIER');
  assert.equal(skip({ line: 'x' }), 'INVALID_ROW');
});

test('the store keeps one record per line, replaces moved numbers, confirms across sources and freezes started games', async () => {
  let clock = now;
  const store = new ScrapedLineStore(null, () => clock);
  const first = await store.ingest('scraper-a', [line(), line({ projection_id: '1002', player_name: 'Other Player', line: 40.5 })],
    { complete: true, apps: ['prizepicks'] });
  assert.deepEqual([first.added, first.moved, first.unchanged], [2, 0, 0]);
  // The same pull again adds nothing; a moved number replaces the old one and keeps it as previous.
  const second = await store.ingest('scraper-a', [line({ line: 66.5 }), line({ projection_id: '1002', player_name: 'Other Player', line: 40.5 })],
    { complete: true, apps: ['prizepicks'] });
  assert.deepEqual([second.added, second.moved, second.unchanged], [0, 1, 1]);
  const moved = (await store.active()).find((item) => item.appLineId === '1001')!;
  assert.deepEqual([moved.line, moved.previousLine], [66.5, 64.5]);
  assert.equal((await store.active()).length, 2, 'no duplicate records');
  // A second source reporting the same line confirms it.
  await store.ingest('scraper-b', [line({ projection_id: 'b-77', line: 66.5 })], { complete: false, apps: ['prizepicks'] });
  assert.deepEqual([...(await store.active()).find((item) => item.appLineId === 'b-77')!.confirmedBy].sort(), ['scraper-a', 'scraper-b']);
  // A complete pull that no longer lists a line takes it down; a cut-short pull never does.
  await store.ingest('scraper-a', [line({ line: 66.5 })], { complete: false, apps: ['prizepicks'] });
  assert.ok((await store.active()).some((item) => item.appLineId === '1002'));
  const removal = await store.ingest('scraper-a', [line({ line: 66.5 }), line({ projection_id: 'b-77', line: 66.5 })], { complete: true, apps: ['prizepicks'] });
  assert.equal(removal.removed, 1);
  assert.equal((await store.active()).some((item) => item.appLineId === '1002'), false);
  // A source that covers part of the app never takes down what only the other sources list, and a line another source
  // still lists stays when this one drops it.
  const partial = await store.ingest('partial-source', [line({ projection_id: 'odds-9', player_name: 'Odds Only', line: 10.5 })],
    { complete: true, apps: ['prizepicks'] });
  assert.equal(partial.removed, 0);
  assert.ok((await store.active()).some((item) => item.appLineId === '1001'), 'a full-board line survives the partial pull');
  const dropped = await store.ingest('partial-source', [], { complete: true, apps: ['prizepicks'] });
  assert.equal(dropped.removed, 1, 'only the line the partial source alone listed goes');
  assert.equal((await store.restoreRemoved(new Date('2030-01-01T00:00:00Z'))) >= 1, true, 'a bad pull can be undone');
  // Once the game starts the line is frozen and leaves the active board.
  clock = new Date('2030-10-04T17:30:00.000Z');
  const late = await store.ingest('scraper-a', [line({ line: 90.5 })], { complete: true, apps: ['prizepicks'] });
  assert.equal(late.moved, 0);
  assert.equal((await store.active()).length, 0);
});

test('stored PrizePicks lines become board lines with model market keys, full NFL team names and stable ids', async () => {
  const store = new ScrapedLineStore(null, () => now);
  await store.ingest('scraper-a', [line(), line({ projection_id: '2001', player_name: 'Test Linebacker', player_team: 'CIN',
    player_team_name: 'Bengals', stat_short: 'Tackles+Ast', line: 6.5 }), line({ projection_id: '3001' }, 'underdog')],
    { complete: true, apps: ['prizepicks', 'underdog'] });
  const lines = await new ScrapedPrizePicksProvider(store).fetchPrizePicksLines();
  assert.equal(lines.length, 2, 'Underdog lines stay off the PrizePicks board');
  const receiver = lines.find((item) => item.sourceLineId === '1001')!;
  assert.deepEqual([receiver.id, receiver.sport, receiver.market, receiver.team, receiver.opponent],
    ['pp:1001', 'NFL', 'player_reception_yds', 'Jacksonville Jaguars', 'Cincinnati Bengals']);
  // One player id scheme across providers, so history and models line up.
  assert.match(receiver.playerId, /^americanfootball_nfl:[0-9a-f]{24}$/);
  assert.deepEqual([receiver.awayTeam, receiver.homeTeam].sort(), ['Cincinnati Bengals', 'Jacksonville Jaguars']);
  assert.equal(receiver.eventName, 'Jacksonville Jaguars @ Cincinnati Bengals');
  assert.equal(receiver.playerImageUrl, 'https://static.prizepicks.com/images/players/test.png');
  assert.equal(lines.find((item) => item.sourceLineId === '2001')!.market, 'player_tackles_assists');
  assert.deepEqual([marketKey('MLB', 'Hits+Runs+RBIs'), marketKey('NBA', '3-PT Made'), marketKey('NFL', 'Longest Rec')],
    ['batter_hits_runs_rbis', 'player_threes', 'longest_rec']);
  await assert.rejects(() => new ScrapedPrizePicksProvider(new ScrapedLineStore(null, () => now)).fetchPrizePicksLines(),
    /SCRAPED_LINES_UNAVAILABLE/);
});

test('the puller runs each source on its schedule, within one daily spend cap, and rebuilds only when lines change', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-scraper-'));
  try {
    let runs = 0, rebuilds = 0, rows: unknown[] = [row(), row({ projection_id: '1002', player_name: 'Other Player' })];
    let status = 'SUCCEEDED';
    const charges: number[] = [];
    const apify = { runActor: async (_actor: string, _input: unknown, options: { maxChargeUsd: number }) => {
      runs++; charges.push(options.maxChargeUsd);
      const usageUsd = Math.min(1.4, options.maxChargeUsd);
      return { id: 'run', status, datasetId: 'ds', usageUsd }; },
      datasetItems: async () => rows } as unknown as ApifyClient;
    const budget = new DailySpendBudget(join(folder, 'spend.json'), 4.5, () => now);
    const capped = { ...actorSource, rowCap: 2 };
    const puller = new ScraperPuller(apify, new ScrapedLineStore(join(folder, 'lines.json'), () => now), budget,
      [{ source: capped, hoursEt: [16] }, { source: otherSource, hoursEt: [] }], { maxRunUsd: 1.5 }, () => now);
    puller.whenLinesChange(() => { rebuilds++; });
    const first = await puller.pull('test-actor');
    assert.deepEqual([first.status, first.rows, first.truncated, first.costUsd, first.ingest?.added], ['SUCCEEDED', 2, true, 1.4, 2]);
    assert.equal(rebuilds, 1);
    rows = [row()];
    const second = await puller.pull('test-actor');
    assert.deepEqual([second.status, second.truncated, second.ingest?.added, second.ingest?.removed], ['SUCCEEDED', false, 0, 1]);
    assert.equal(rebuilds, 2);
    // A run stopped at the spend cap keeps what it saved but never counts as a complete board.
    status = 'ABORTED';
    const aborted = await puller.pull('test-actor');
    assert.deepEqual([aborted.status, aborted.reason, aborted.truncated], ['SUCCEEDED', 'RUN_ABORTED', true]);
    // 4.20 of 4.50 spent: the next run may spend only the 0.30 left, and then the cap is reached.
    await puller.pull('test-actor');
    assert.deepEqual([(await puller.pull('test-actor')).reason, (await puller.pull('nope')).reason], ['DAILY_BUDGET_REACHED', 'UNKNOWN_SOURCE']);
    assert.equal(runs, 4);
    assert.deepEqual(charges.map((charge) => Math.round(charge * 100) / 100), [1.5, 1.5, 1.5, 0.3]);
    assert.equal(Math.round(await budget.spent() * 100) / 100, 4.5);
    // The schedule: 20:00 UTC is 16:00 Eastern, so only the source scheduled then runs, once.
    const scheduled = new ScraperPuller(apify, new ScrapedLineStore(null, () => now),
      new DailySpendBudget(join(folder, 'spend2.json'), 10, () => now),
      [{ source: actorSource, hoursEt: [16] }, { source: otherSource, hoursEt: [9] }], { maxRunUsd: 1.5 }, () => now);
    assert.deepEqual((await scheduled.tick()).map((report) => report.source), ['test-actor']);
    assert.deepEqual(await scheduled.tick(), []);
    assert.deepEqual((await scheduled.status()).sources.map((item) => [item.id, item.last?.source ?? null]),
      [['test-actor', 'test-actor'], ['test-other', null]]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('two sources reporting the same PrizePicks line confirm it, and each field keeps the best value', async () => {
  const store = new ScrapedLineStore(null, () => now);
  // One source has the headshot but not home/away; the other has home/away but only a team logo.
  await store.ingest('source-a', [{ ...line(), home: null, away: null }], { complete: false, apps: ['prizepicks'] });
  await store.ingest('source-b', [line({ player_image: 'https://static.prizepicks.com/images/teams/nfl/x/1.webp' })],
    { complete: false, apps: ['prizepicks'] });
  const [stored] = await store.active();
  assert.deepEqual([...stored.confirmedBy].sort(), ['source-a', 'source-b']);
  assert.equal(stored.imageUrl, 'https://static.prizepicks.com/images/players/test.png');
  assert.deepEqual([stored.home?.abbreviation, stored.away?.abbreviation], ['CIN', 'JAC']);
  const [board] = await new ScrapedPrizePicksProvider(store).fetchPrizePicksLines();
  assert.deepEqual([board.awayTeam, board.homeTeam, board.eventName],
    ['Jacksonville Jaguars', 'Cincinnati Bengals', 'Jacksonville Jaguars @ Cincinnati Bengals']);
});

test('the Apify client starts a run with spend and row caps, waits for it, and reads every page', async () => {
  const calls: string[] = [];
  let polls = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/acts/')) return Response.json({ data: { id: 'r1', status: 'RUNNING', defaultDatasetId: 'd1', usageTotalUsd: 0 } });
    if (url.includes('/actor-runs/')) { polls++; return Response.json({ data: { id: 'r1', status: polls < 2 ? 'RUNNING' : 'SUCCEEDED',
      defaultDatasetId: 'd1', usageTotalUsd: 1.25 } }); }
    const offset = Number(new URL(url).searchParams.get('offset'));
    return Response.json(offset === 0 ? [1, 2] : [3]);
  };
  const client = new ApifyClient('token', fetchFn, async () => undefined);
  const run = await client.runActor('lergassy/dfs-props-scraper', { mode: 'props' }, { maxChargeUsd: 2.5, maxItems: 20000 });
  assert.deepEqual(run, { id: 'r1', status: 'SUCCEEDED', datasetId: 'd1', usageUsd: 1.25 });
  assert.match(calls[0], /^POST https:\/\/api\.apify\.com\/v2\/acts\/lergassy~dfs-props-scraper\/runs\?/);
  assert.match(calls[0], /maxItems=20000/);
  assert.match(calls[0], /maxTotalChargeUsd=2\.5/);
  // Without a row cap the actor returns everything.
  await client.runActor('zen-studio/prizepicks-player-props', {}, { maxChargeUsd: 5 });
  assert.doesNotMatch(calls.at(-2) ?? '', /maxItems/);
  assert.deepEqual(await client.datasetItems('d1', 2), [1, 2, 3]);
  await assert.rejects(() => new ApifyClient(null, async () => new Response('', { status: 401 })).datasetItems('d1'), /APIFY_HTTP_401/);
});

test('a board built from scraped lines is dated by the scrape and carries their player photos', async () => {
  const { BoardService } = await import('../src/board-service.js');
  const { ModelRegistry } = await import('@crowniq/engine');
  const store = new ScrapedLineStore(null, () => now);
  await store.ingest('scraper-a', [line()], { complete: true, apps: ['prizepicks'] });
  const later = new Date(now.getTime() + 2 * 3600_000);
  const service = new BoardService(new ScrapedPrizePicksProvider(store), null, new ModelRegistry(), () => later);
  const snapshot = await service.refresh();
  assert.equal(snapshot.board.fetchedAt, now.toISOString(), 'captured when scraped, not when rebuilt');
  const playerId = snapshot.board.lines[0].playerId;
  assert.equal(snapshot.playerMedia?.[playerId]?.photoUrl, 'https://static.prizepicks.com/images/players/test.png');
});

test('runs that come back empty are counted so a broken scraper shows up', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-blank-'));
  try {
    let rows: unknown[] = [];
    const apify = { runActor: async () => ({ id: 'run', status: 'SUCCEEDED', datasetId: 'ds', usageUsd: 0.05 }),
      datasetItems: async () => rows } as unknown as ApifyClient;
    const puller = new ScraperPuller(apify, new ScrapedLineStore(null, () => now), new DailySpendBudget(join(folder, 's.json'), 10, () => now),
      [{ source: actorSource, hoursEt: [] }], { maxRunUsd: 1 }, () => now);
    await puller.pull('test-actor'); await puller.pull('test-actor');
    const blank = (await puller.status()).sources[0];
    assert.deepEqual([blank.last?.reason, blank.blankRunsInARow], ['NO_ROWS', 2]);
    rows = [row()];
    await puller.pull('test-actor');
    assert.equal((await puller.status()).sources[0].blankRunsInARow, 0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('Goblins and Demons stay MORE-only whatever side label a source sends', () => {
  for (const odds_tier of ['goblin', 'demon']) assert.deepEqual(line({ odds_tier, allowed_wager_types: 'under_or_over' }).directions, ['MORE']);
  assert.equal(line().directions.length, 2);
});

test('a restart or an overlapping deployment never repeats a scheduled pull, and both see the same spending', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-slots-'));
  try {
    const { SlotLedger } = await import('../src/scrapers/slot-ledger.js');
    const slotsFile = join(folder, 'slots.json'), spendFile = join(folder, 'spend.json');
    const first = new SlotLedger(slotsFile), second = new SlotLedger(slotsFile);
    assert.equal(await first.claim('2030-10-04', '12|zen'), true);
    assert.equal(await second.claim('2030-10-04', '12|zen'), false, 'the other process sees the slot already ran');
    assert.equal(await second.claim('2030-10-04', '15|zen'), true);
    assert.equal(await second.claim('2030-10-05', '12|zen'), true, 'a new day starts clean');
    const a = new DailySpendBudget(spendFile, 15, () => now), b = new DailySpendBudget(spendFile, 15, () => now);
    await a.spent();
    await b.record(4);
    assert.equal(await a.spent(), 4, 'a budget reads what another process spent');
    await a.record(1.5);
    assert.equal(await b.remaining(), 9.5);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('claims and charges made at the same moment are never lost', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-race-'));
  try {
    const { SlotLedger } = await import('../src/scrapers/slot-ledger.js');
    const ledger = new SlotLedger(join(folder, 'slots.json'));
    const results = await Promise.all(['15|zen', '15|context:pinnacle', '15|zen'].map((slot) => ledger.claim('2030-10-04', slot)));
    assert.deepEqual(results, [true, true, false]);
    assert.equal(await ledger.claim('2030-10-04', '15|context:pinnacle'), false, 'the context slot was kept, not overwritten');
    const budget = new DailySpendBudget(join(folder, 'spend.json'), 20, () => now);
    await Promise.all([budget.record(1.25), budget.record(0.4), budget.record(0.35)]);
    assert.equal(await budget.spent(), 2);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a run’s charge is read again after it settles, so the budget counts what Apify bills', async () => {
  let reads = 0;
  const fetchFn: typeof fetch = async (input) => {
    if (String(input).includes('/acts/')) return Response.json({ data: { id: 'r2', status: 'SUCCEEDED', defaultDatasetId: 'd2', usageTotalUsd: 0 } });
    reads++;
    return Response.json({ data: { id: 'r2', status: 'SUCCEEDED', defaultDatasetId: 'd2', usageTotalUsd: 0.405 } });
  };
  const run = await new ApifyClient('token', fetchFn, async () => undefined).runActor('lergassy/kalshi-scraper', {}, { maxChargeUsd: 1 });
  assert.equal(run.usageUsd, 0.405);
  assert.equal(reads, 1);
});

test('the daily budget counts Eastern days and the account real spend, whichever is higher', async () => {
  const { DailySpendBudget, easternDay, easternMidnight } = await import('../src/scrapers/spend-budget.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-budget-'));
  try {
    // 10:30 PM Eastern on Oct 4 is already Oct 5 in UTC: still the same Eastern day.
    let now = new Date('2030-10-05T02:30:00Z');
    assert.equal(easternDay(now), '2030-10-04');
    assert.equal(easternMidnight(now).toISOString(), '2030-10-04T04:00:00.000Z');
    let actualSince: Date | null = null;
    const budget = new DailySpendBudget(join(folder, 'spend.json'), 25, () => now, async (since) => { actualSince = since; return 30.82; });
    await budget.record(2);
    assert.equal(await budget.spent(), 30.82, 'Apify counts runs started elsewhere');
    assert.equal(actualSince!.toISOString(), '2030-10-04T04:00:00.000Z');
    assert.equal(await budget.remaining(), 0);
    now = new Date('2030-10-05T04:30:00Z');
    const failing = new DailySpendBudget(join(folder, 'spend.json'), 25, () => now, async () => { throw new Error('down'); });
    assert.equal(await failing.spent(), 0, 'a new Eastern day starts at zero; an unreadable Apify falls back to the local count');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a retired source takes down the lines only it held; lines another source lists stay', async () => {
  const store = new ScrapedLineStore(null, () => now);
  await store.ingest('old-feed', [line(), line({ projection_id: '1002', player_name: 'Old Only' })], { complete: true, apps: ['prizepicks'] });
  await store.ingest('new-feed', [line()], { complete: true, apps: ['prizepicks'] });
  assert.equal(await store.retire(['old-feed']), 1);
  const active = await store.active();
  assert.deepEqual(active.map((item) => [item.player, item.confirmedBy]), [['Test Receiver', ['new-feed']]]);
});

