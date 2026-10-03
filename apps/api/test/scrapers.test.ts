import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApifyClient } from '../src/scrapers/apify-client.js';
import { lergassy, readLergassyRow } from '../src/scrapers/lergassy.js';
import { ScrapedLineStore } from '../src/scrapers/line-store.js';
import { marketKey, ScrapedPrizePicksProvider } from '../src/scrapers/scraped-prizepicks-provider.js';
import type { ScrapedLine } from '../src/scrapers/scraped-line.js';
import { ScraperPuller } from '../src/scrapers/scraper-puller.js';
import { DailySpendBudget } from '../src/scrapers/spend-budget.js';
import { zenPrizePicks, zenUnderdog } from '../src/scrapers/zen-studio.js';

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

test('the puller runs each source on its schedule, within one daily spend cap, and rebuilds only when lines change', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-scraper-'));
  try {
    let runs = 0, rebuilds = 0, rows: unknown[] = [row(), row({ propId: '1002', player: 'Other Player' })];
    let status = 'SUCCEEDED';
    const apify = { runActor: async () => { runs++; return { id: 'run', status, datasetId: 'ds', usageUsd: 1.4 }; },
      datasetItems: async () => rows } as unknown as ApifyClient;
    const budget = new DailySpendBudget(join(folder, 'spend.json'), 4.5, () => now);
    const capped = { ...lergassy, rowCap: 2 };
    const puller = new ScraperPuller(apify, new ScrapedLineStore(join(folder, 'lines.json'), () => now), budget,
      [{ source: capped, hoursEt: [16] }, { source: zenPrizePicks, hoursEt: [] }], { maxRunUsd: 1.5 }, () => now);
    puller.whenLinesChange(() => { rebuilds++; });
    const first = await puller.pull('lergassy');
    assert.deepEqual([first.status, first.rows, first.truncated, first.costUsd, first.ingest?.added], ['SUCCEEDED', 2, true, 1.4, 2]);
    assert.equal(rebuilds, 1);
    rows = [row()];
    const second = await puller.pull('lergassy');
    assert.deepEqual([second.status, second.truncated, second.ingest?.added, second.ingest?.removed], ['SUCCEEDED', false, 0, 1]);
    assert.equal(rebuilds, 2);
    // A run stopped at the spend cap keeps what it saved but never counts as a complete board.
    status = 'ABORTED';
    const aborted = await puller.pull('lergassy');
    assert.deepEqual([aborted.status, aborted.reason, aborted.truncated], ['SUCCEEDED', 'RUN_ABORTED', true]);
    // 4.20 of 4.50 spent: not enough left for another 1.50 run.
    assert.deepEqual([(await puller.pull('lergassy')).reason, (await puller.pull('nope')).reason], ['DAILY_BUDGET_REACHED', 'UNKNOWN_SOURCE']);
    assert.equal(runs, 3);
    assert.equal(await budget.spent(), 4.2);
    // The schedule: 20:00 UTC is 16:00 Eastern, so only the source scheduled then runs, once.
    const scheduled = new ScraperPuller(apify, new ScrapedLineStore(null, () => now),
      new DailySpendBudget(join(folder, 'spend2.json'), 10, () => now),
      [{ source: lergassy, hoursEt: [16] }, { source: zenPrizePicks, hoursEt: [9] }], { maxRunUsd: 1.5 }, () => now);
    assert.deepEqual((await scheduled.tick()).map((report) => report.source), ['lergassy']);
    assert.deepEqual(await scheduled.tick(), []);
    assert.deepEqual((await scheduled.status()).sources.map((item) => [item.id, item.last?.source ?? null]),
      [['lergassy', 'lergassy'], ['zen-studio-prizepicks', null]]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

// Rows shaped like zen-studio scraper output; synthetic players and numbers.
const zenRow = (overrides: Record<string, unknown> = {}) => ({ projection_id: '1001', line: 64.5, stat: 'Receiving Yards',
  stat_short: 'Rec Yards', odds_tier: 'standard', status: 'pre_game', is_live: false, in_game: false, event_type: 'team',
  allowed_wager_types: 'under_or_over', player_name: 'Test Receiver', player_team: 'JAC', player_team_name: 'Jaguars',
  player_image: 'https://static.prizepicks.com/images/teams/nfl/x/1.webp', player_combo: false, league: 'NFL',
  game_external_id: 'NFL_game_1', start_time: '2030-10-04T13:00:00.000-04:00', game_start: '2030-10-04T13:00:00.000-04:00',
  home_team: 'CIN', home_team_name: 'Bengals', away_team: 'JAC', away_team_name: 'Jaguars', ...overrides });
const udRow = (overrides: Record<string, unknown> = {}) => ({ projection_id: 'ud-1', line: 48.5, stat: 'rushing_yds',
  stat_display: 'Rush Yards', status: 'active', is_live: false, player_name: 'Test Back', player_team: 'BAL',
  player_team_name: 'Baltimore Ravens', player_image: 'https://assets.underdogfantasy.com/player-images/nfl/x.png',
  league: 'NFL', game_start: '2030-10-04T17:00:00Z', game_status: 'scheduled', home_team: 'BAL', away_team: 'TEN',
  home_team_name: 'Baltimore Ravens', away_team_name: 'Tennessee Titans', line_type: 'balanced', category: 'player_prop',
  higher_payout_multiplier: '1.0', lower_payout_multiplier: '0.9', ...overrides });

test('Zen Studio rows read like lergassy rows, with home and away teams and Underdog payouts per side', () => {
  const zen = zenPrizePicks.read(zenRow(), now);
  assert.ok('line' in zen);
  assert.deepEqual([zen.line.appLineId, zen.line.stat, zen.line.opponent, zen.line.home?.abbreviation, zen.line.away?.abbreviation,
    zen.line.startTime, zen.line.imageUrl], ['1001', 'Rec Yards', 'CIN', 'CIN', 'JAC', '2030-10-04T17:00:00.000Z', null]);
  const skip = (result: ReturnType<typeof zenPrizePicks.read>) => 'skip' in result ? result.skip : null;
  assert.equal(skip(zenPrizePicks.read(zenRow({ player_combo: true }), now)), 'COMBO_PLAYER');
  assert.equal(skip(zenPrizePicks.read(zenRow({ in_game: true }), now)), 'LIVE_OR_STARTED');
  const ud = zenUnderdog.read(udRow(), now);
  assert.ok('line' in ud);
  assert.deepEqual([ud.line.app, ud.line.tier, ud.line.directions, ud.line.multipliers, ud.line.opponent],
    ['underdog', 'REGULAR', ['MORE', 'LESS'], { MORE: 1, LESS: 0.9 }, 'TEN']);
  const higherOnly = zenUnderdog.read(udRow({ lower_payout_multiplier: null }), now);
  assert.ok('line' in higherOnly && higherOnly.line.directions.length === 1 && higherOnly.line.directions[0] === 'MORE');
  assert.equal(skip(zenUnderdog.read(udRow({ higher_payout_multiplier: null, lower_payout_multiplier: null }), now)), 'NO_SIDES');
});

test('two sources reporting the same PrizePicks line confirm it, and each field keeps the best value', async () => {
  const store = new ScrapedLineStore(null, () => now);
  // lergassy has the headshot but not home/away; Zen Studio has home/away but only a team logo.
  await store.ingest('lergassy', [line()], { complete: false, apps: ['prizepicks'] });
  const zen = zenPrizePicks.read(zenRow(), now);
  assert.ok('line' in zen);
  await store.ingest('zen-studio-prizepicks', [zen.line], { complete: false, apps: ['prizepicks'] });
  const [stored] = await store.active();
  assert.deepEqual([...stored.confirmedBy].sort(), ['lergassy', 'zen-studio-prizepicks']);
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
