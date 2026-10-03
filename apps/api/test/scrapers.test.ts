import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApifyClient } from '../src/scrapers/apify-client.js';
import { readLergassyRow } from '../src/scrapers/lergassy.js';
import { ScrapedLineStore } from '../src/scrapers/line-store.js';
import { marketKey, ScrapedPrizePicksProvider } from '../src/scrapers/scraped-prizepicks-provider.js';
import type { ScrapedLine } from '../src/scrapers/scraped-line.js';
import { ScraperPuller } from '../src/scrapers/scraper-puller.js';
import { DailySpendBudget } from '../src/scrapers/spend-budget.js';

const now = new Date('2030-10-03T20:00:00.000Z');
// Rows shaped like lergassy/dfs-props-scraper output; every player and number is synthetic.
const row = (overrides: Record<string, unknown> = {}) => ({ type: 'prop', platform: 'prizepicks', propId: '1001',
  league: 'NFL', player: 'Test Receiver', team: 'JAC', teamName: 'Jaguars', position: 'WR', market: 'Rec Yards',
  line: 64.5, oddsType: 'standard', pickType: 'Single Stat', allowedPicks: 'under_or_over', live: false,
  status: 'pre_game', gameId: 'NFL_game_1', opponent: 'CIN', startTime: '2030-10-04T17:00:00.000Z',
  image: 'https://static.prizepicks.com/images/players/test.png', ...overrides });
const line = (overrides: Record<string, unknown> = {}): ScrapedLine => {
  const result = readLergassyRow(row(overrides), now);
  if ('skip' in result) throw new Error(result.skip);
  return result.line;
};

test('scraped rows become lines with the right sides, tier and photo, and unreadable rows are skipped', () => {
  const regular = line();
  assert.deepEqual([regular.app, regular.tier, regular.directions, regular.stat, regular.line],
    ['prizepicks', 'REGULAR', ['MORE', 'LESS'], 'Rec Yards', 64.5]);
  assert.equal(regular.imageUrl, 'https://static.prizepicks.com/images/players/test.png');
  assert.deepEqual(line({ oddsType: 'demon', allowedPicks: 'over' }).directions, ['MORE']);
  // No stated sides: Regular offers both, Goblins and Demons MORE only.
  assert.deepEqual(line({ allowedPicks: null }).directions, ['MORE', 'LESS']);
  assert.deepEqual(line({ oddsType: 'goblin', allowedPicks: null }).directions, ['MORE']);
  // Team logos and placeholders are not player photos.
  assert.equal(line({ image: 'https://static.prizepicks.com/images/teams/nfl/x/2.webp' }).imageUrl, null);
  assert.equal(line({ image: 'https://static.prizepicks.com/images/players/placeholder.png' }).imageUrl, null);
  // Underdog's "OSU @ IOWA" opponent keeps only the other side.
  assert.equal(line({ platform: 'underdog', team: 'OSU', opponent: 'OSU @ IOWA', oddsType: 'balanced' }).opponent, 'IOWA');
  const skip = (overrides: Record<string, unknown>) => {
    const result = readLergassyRow(row(overrides), now); return 'skip' in result ? result.skip : null;
  };
  assert.equal(skip({ team: 'BAL/TEN' }), 'COMBO_PLAYER');
  assert.equal(skip({ live: true }), 'LIVE_OR_STARTED');
  assert.equal(skip({ status: 'suspended' }), 'LIVE_OR_STARTED');
  assert.equal(skip({ startTime: '2030-10-03T19:00:00.000Z' }), 'LIVE_OR_STARTED');
  assert.equal(skip({ platform: 'sleeper' }), 'UNKNOWN_APP');
  assert.equal(skip({ oddsType: 'flex' }), 'UNKNOWN_TIER');
  assert.equal(skip({ line: 'x' }), 'INVALID_ROW');
});

test('the store keeps one record per line, replaces moved numbers, confirms across sources and freezes started games', async () => {
  let clock = now;
  const store = new ScrapedLineStore(null, () => clock);
  const first = await store.ingest('scraper-a', [line(), line({ propId: '1002', player: 'Other Player', line: 40.5 })],
    { complete: true, apps: ['prizepicks'] });
  assert.deepEqual([first.added, first.moved, first.unchanged], [2, 0, 0]);
  // The same pull again adds nothing; a moved number replaces the old one and keeps it as previous.
  const second = await store.ingest('scraper-a', [line({ line: 66.5 }), line({ propId: '1002', player: 'Other Player', line: 40.5 })],
    { complete: true, apps: ['prizepicks'] });
  assert.deepEqual([second.added, second.moved, second.unchanged], [0, 1, 1]);
  const moved = (await store.active()).find((item) => item.appLineId === '1001')!;
  assert.deepEqual([moved.line, moved.previousLine], [66.5, 64.5]);
  assert.equal((await store.active()).length, 2, 'no duplicate records');
  // A second source reporting the same line confirms it.
  await store.ingest('scraper-b', [line({ propId: 'b-77', line: 66.5 })], { complete: false, apps: ['prizepicks'] });
  assert.deepEqual([...(await store.active()).find((item) => item.appLineId === 'b-77')!.confirmedBy].sort(), ['scraper-a', 'scraper-b']);
  // A complete pull that no longer lists a line takes it down; a cut-short pull never does.
  await store.ingest('scraper-a', [line({ line: 66.5 })], { complete: false, apps: ['prizepicks'] });
  assert.ok((await store.active()).some((item) => item.appLineId === '1002'));
  const removal = await store.ingest('scraper-a', [line({ line: 66.5 }), line({ propId: 'b-77', line: 66.5 })], { complete: true, apps: ['prizepicks'] });
  assert.equal(removal.removed, 1);
  assert.equal((await store.active()).some((item) => item.appLineId === '1002'), false);
  // Once the game starts the line is frozen and leaves the active board.
  clock = new Date('2030-10-04T17:30:00.000Z');
  const late = await store.ingest('scraper-a', [line({ line: 90.5 })], { complete: true, apps: ['prizepicks'] });
  assert.equal(late.moved, 0);
  assert.equal((await store.active()).length, 0);
});

test('stored PrizePicks lines become board lines with model market keys, full NFL team names and stable ids', async () => {
  const store = new ScrapedLineStore(null, () => now);
  await store.ingest('scraper-a', [line(), line({ propId: '2001', player: 'Test Linebacker', team: 'CIN', teamName: 'Bengals',
    opponent: 'JAC', market: 'Tackles+Ast', line: 6.5 }), line({ propId: '3001', platform: 'underdog', oddsType: 'balanced' })],
    { complete: true, apps: ['prizepicks', 'underdog'] });
  const lines = await new ScrapedPrizePicksProvider(store).fetchPrizePicksLines();
  assert.equal(lines.length, 2, 'Underdog lines stay off the PrizePicks board');
  const receiver = lines.find((item) => item.sourceLineId === '1001')!;
  assert.deepEqual([receiver.id, receiver.sport, receiver.market, receiver.team, receiver.opponent],
    ['pp:1001', 'NFL', 'player_reception_yds', 'Jacksonville Jaguars', 'Cincinnati Bengals']);
  // Same player id scheme as the Odds API provider, so history and models line up.
  assert.match(receiver.playerId, /^americanfootball_nfl:[0-9a-f]{24}$/);
  assert.deepEqual([receiver.awayTeam, receiver.homeTeam].sort(), ['Cincinnati Bengals', 'Jacksonville Jaguars']);
  assert.equal(receiver.eventName, 'Cincinnati Bengals vs Jacksonville Jaguars');
  assert.equal(receiver.playerImageUrl, 'https://static.prizepicks.com/images/players/test.png');
  assert.equal(lines.find((item) => item.sourceLineId === '2001')!.market, 'player_tackles_assists');
  assert.deepEqual([marketKey('MLB', 'Hits+Runs+RBIs'), marketKey('NBA', '3-PT Made'), marketKey('NFL', 'Longest Rec')],
    ['batter_hits_runs_rbis', 'player_threes', 'longest_rec']);
  await assert.rejects(() => new ScrapedPrizePicksProvider(new ScrapedLineStore(null, () => now)).fetchPrizePicksLines(),
    /SCRAPED_LINES_UNAVAILABLE/);
});

test('the puller stays within the daily spend cap, flags cut-short runs and rebuilds only when lines change', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-scraper-'));
  try {
    let runs = 0, rebuilds = 0, rows: unknown[] = [row(), row({ propId: '1002', player: 'Other Player' })];
    const apify = { runActor: async () => { runs++; return { id: 'run', status: 'SUCCEEDED', datasetId: 'ds', usageUsd: 1.4 }; },
      datasetItems: async () => rows } as unknown as ApifyClient;
    const budget = new DailySpendBudget(join(folder, 'spend.json'), 3, () => now);
    const puller = new ScraperPuller(apify, new ScrapedLineStore(join(folder, 'lines.json'), () => now), budget,
      { maxRows: 2, maxRunUsd: 1.5, hoursEt: [16] }, () => now);
    puller.whenLinesChange(() => { rebuilds++; });
    const first = await puller.pull();
    assert.deepEqual([first.status, first.rows, first.truncated, first.costUsd, first.ingest?.added], ['SUCCEEDED', 2, true, 1.4, 2]);
    assert.equal(rebuilds, 1);
    rows = [row()];
    const second = await puller.pull();
    assert.deepEqual([second.status, second.truncated, second.ingest?.added, second.ingest?.removed], ['SUCCEEDED', false, 0, 1]);
    assert.equal(rebuilds, 2);
    // 2.8 of 3.00 spent: not enough left for another 1.50 run.
    const third = await puller.pull();
    assert.deepEqual([third.status, third.reason], ['SKIPPED', 'DAILY_BUDGET_REACHED']);
    assert.equal(runs, 2);
    assert.equal(await budget.spent(), 2.8);
    // The schedule: 20:00 UTC is 16:00 Eastern, so a tick fires once for that hour.
    const scheduled = new ScraperPuller(apify, new ScrapedLineStore(null, () => now),
      new DailySpendBudget(join(folder, 'spend2.json'), 10, () => now), { maxRows: 100, maxRunUsd: 1.5, hoursEt: [16] }, () => now);
    assert.equal((await scheduled.tick())?.status, 'SUCCEEDED');
    assert.equal(await scheduled.tick(), null);
  } finally { await rm(folder, { recursive: true, force: true }); }
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
  assert.match(calls[0], /^POST https:\/\/api\.apify\.com\/v2\/acts\/lergassy~dfs-props-scraper\/runs\?.*maxItems=20000.*maxTotalChargeUsd=2\.5/);
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
