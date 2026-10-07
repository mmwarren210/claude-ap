import assert from 'node:assert/strict';
import test from 'node:test';
import type { PropLine } from '@crowniq/contracts';
import { SharpPropsFeed } from '../src/context/sharp-props.js';
import type { PickemLine } from '../src/context/sharp-props.js';
import { ScrapedLineStore } from '../src/scrapers/line-store.js';
import { sameLineKey } from '../src/scrapers/markets.js';
import { classifyAgainst, regularKey } from '../src/scrapers/odds-api-source.js';
import { ScrapedPrizePicksProvider } from '../src/scrapers/scraped-prizepicks-provider.js';
import type { ScrapedLine } from '../src/scrapers/scraped-line.js';
import { SHARP_SOURCE, sharpPrizePicksScraped } from '../src/scrapers/sharp-prizepicks.js';

// Step 0: SharpAPI's PrizePicks lines first, The Odds API and the scrapers as backup. Synthetic rows only.
const now = new Date('2030-10-07T12:00:00Z'), start = '2030-10-08T00:00:00.000Z';
const pickem = (overrides: Partial<PickemLine> = {}): PickemLine => ({ book: 'prizepicks', league: 'nfl', sport: 'NFL', eventId: 'e1',
  home: 'Home', away: 'Away', startTime: start, player: 'Test Receiver', marketType: 'player_receiving_yards', market: 'player_reception_yds',
  line: 54.5, sides: ['MORE', 'LESS'], american: null, alternate: false, stale: false, observedAt: null, ...overrides });
const scraped = (overrides: Partial<ScrapedLine> = {}): ScrapedLine => ({ app: 'prizepicks', appLineId: 'pp-1', league: 'NFL', gameId: 'g1',
  player: 'Test Receiver', team: 'HOM', teamName: null, opponent: 'AWY', stat: 'Receiving Yards', marketKey: 'player_reception_yds', line: 54.5,
  tier: 'REGULAR', directions: ['MORE', 'LESS'], startTime: start, imageUrl: null, ...overrides });

test('SharpAPI PrizePicks lines become store lines: mapped stats only, PrizePicks and Flex once, no alternates', () => {
  const { lines, unmapped } = sharpPrizePicksScraped([pickem(), pickem({ book: 'prizepicks_flex' }),
    pickem({ marketType: 'player_1st_half_receiving_yards', market: null }), pickem({ alternate: true, line: 40.5 })]);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0]!.league, lines[0]!.gameId, lines[0]!.tier, lines[0]!.marketKey], ['NFL', 'sharp:e1', 'REGULAR', 'player_reception_yds']);
  assert.equal(unmapped.get('NFL:player_1st_half_receiving_yards'), 1);
});

test('the same line from SharpAPI and a scraper confirms; soccer league labels meet; segments never mix', () => {
  assert.equal(sameLineKey(scraped({ league: 'LA LIGA' })), sameLineKey(scraped({ league: 'SOCCER' })));
  assert.notEqual(sameLineKey(scraped({ league: 'NFL1H' })), sameLineKey(scraped({ league: 'NFL' })));
});

test('board: SharpAPI first, the newest number wins a disagreement and stays unconfirmed, a failed feed fails closed', async () => {
  let clock = now;
  const store = new ScrapedLineStore(null, () => clock);
  // The scraper saw 54.5 at noon; SharpAPI agrees on one player and lists a new player the scraper lacks.
  await store.ingest('zen-studio-prizepicks', [scraped(), scraped({ appLineId: 'pp-2', player: 'Other Back', stat: 'Rush Yards',
    marketKey: 'player_rush_yds', line: 60.5 }), scraped({ appLineId: 'pp-g', line: 44.5, tier: 'GOBLIN', directions: ['MORE'] })],
  { complete: true, apps: ['prizepicks'] });
  clock = new Date(now.getTime() + 3600_000);
  await store.ingest(SHARP_SOURCE, sharpPrizePicksScraped([pickem(), pickem({ player: 'Other Back', marketType: 'player_rushing_yards',
    market: 'player_rush_yds', line: 62.5 }), pickem({ player: 'New Tight End', line: 31.5 })]).lines, { complete: true, apps: ['prizepicks'] });
  const provider = new ScrapedPrizePicksProvider(store);
  const board = await provider.fetchPrizePicksLines() as PropLine[];
  const of = (player: string, type = 'REGULAR') => board.filter((line) => line.playerName === player && line.lineType === type);
  assert.deepEqual(of('Test Receiver').map((line) => [line.threshold, line.confirmed, line.sources]),
    [[54.5, true, ['sharpapi', 'zen-studio-prizepicks']]], 'two sources agree: one confirmed line');
  assert.deepEqual(of('Other Back').map((line) => [line.threshold, line.confirmed]), [[62.5, false]], 'the newest number wins, unconfirmed');
  assert.equal(of('New Tight End').length, 1, 'a player only SharpAPI lists is added');
  assert.equal(of('Test Receiver', 'GOBLIN').length, 1, 'Goblins still come from the scrapers');
  assert.deepEqual(provider.lastReport?.disagreements, { NFL: 1 });
  assert.equal(provider.lastReport?.primary.sharpapi, 3);
  assert.equal(provider.lastReport?.goblins, 1);
  // SharpAPI goes down: its only-SharpAPI line leaves, the confirmed one stays on the scraper alone.
  await store.ingest(SHARP_SOURCE, [], { complete: true, apps: ['prizepicks'] });
  const after = await provider.fetchPrizePicksLines() as PropLine[];
  assert.equal(after.some((line) => line.playerName === 'New Tight End'), false);
  assert.deepEqual(after.filter((line) => line.playerName === 'Test Receiver' && line.lineType === 'REGULAR').map((line) => line.sources),
    [['zen-studio-prizepicks']]);
});

test('Odds API alternates with no regular beside them are placed against SharpAPI’s regular line', () => {
  const alt = { id: 'a', provider: 'prizepicks', sourceLineId: 'a', sourceLineIdIsSynthetic: true, sport: 'NFL', league: 'NFL', eventId: 'o1',
    eventName: 'Away @ Home', eventStartTime: start, playerId: 'p', playerName: 'Test Receiver', team: null, opponent: null,
    market: 'player_reception_yds', threshold: 39.5, availableDirections: ['MORE'], lineType: 'UNKNOWN_ALTERNATE', fetchedAt: now.toISOString() } as PropLine;
  const regulars = new Map([[regularKey('NFL', 'Test Receiver', 'player_reception_yds', start), 54.5]]);
  const [goblin, demon, unknown] = classifyAgainst([alt, { ...alt, threshold: 74.5 }, { ...alt, playerName: 'Nobody' }], regulars);
  assert.deepEqual([goblin!.lineType, demon!.lineType, unknown!.lineType], ['GOBLIN', 'DEMON', 'UNKNOWN_ALTERNATE']);
});

test('SharpAPI feed: PrizePicks gets its own pass; a failed pass clears its lines and says so, book prices unaffected', async () => {
  const row = (book: string, side: string, extra: Record<string, unknown> = {}) => ({ sportsbook: book, league: 'nfl', market_type: 'player_receiving_yards',
    selection_type: side, line: 54.5, odds_probability: .5, odds_american: -110, player_name: 'Test Receiver', event_id: 'e1',
    event_start_time: start, home_team: 'Home', away_team: 'Away', is_live: false, is_active: true, ...extra });
  let failPrizePicks = false;
  const asked: string[] = [];
  const fetchFn = (async (input: URL | string) => {
    const url = new URL(String(input)), books = url.searchParams.get('sportsbooks')!;
    asked.push(books);
    if (books === 'prizepicks') {
      if (failPrizePicks) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ data: [row('prizepicks', 'over'), row('prizepicks', 'under')], pagination: { has_more: false } }));
    }
    return new Response(JSON.stringify({ data: [row('draftkings', 'over', { odds_probability: .55 }), row('draftkings', 'under', { odds_probability: .5 })],
      pagination: { has_more: false } }));
  }) as typeof fetch;
  const feed = new SharpPropsFeed('key', null, { leagues: ['mlb'], books: ['draftkings', 'prizepicks'], requestGapMs: 0 }, fetchFn, () => now);
  const heard: [number, boolean][] = [];
  feed.whenPickem((lines, ok) => { heard.push([lines.length, ok]); });
  await feed.refresh();
  assert.deepEqual(asked, ['prizepicks', 'draftkings'], 'PrizePicks alone first (its rows name the partial-game types), then the books');
  assert.equal((await feed.pickemLines()).lines.length, 1);
  failPrizePicks = true;
  const status = await feed.refresh();
  assert.deepEqual(heard, [[1, true], [0, false]]);
  assert.equal((await feed.pickemLines()).lines.length, 0, 'never stale lines as current');
  assert.equal(status.prizePicksFeed?.ok, false);
  assert.equal(status.prices, 1, 'book prices still refreshed');
});

test('Step 1: books per league logged, market types as one list, book_not_selected said out loud, empty books flagged, cadence', async () => {
  const { fullGameTypes } = await import('../src/context/sharp-props.js');
  assert.ok(fullGameTypes('NFL').includes('player_receiving_yards') && fullGameTypes('NFL').includes('anytime_touchdown_scorer'));
  assert.ok(fullGameTypes('NCAAB').includes('player_points'), 'college basketball reads like the NBA');
  const asked: URL[] = [];
  const fetchFn = (async (input: URL | string) => {
    const url = new URL(String(input)); asked.push(url);
    if (url.searchParams.get('sportsbooks')?.includes('betmgm')) return new Response(JSON.stringify({ error: { code: 'book_not_selected',
      details: { selected: ['draftkings', 'fanduel'] } } }), { status: 400 });
    return new Response(JSON.stringify({ data: [], pagination: { has_more: false } }));
  }) as typeof fetch;
  let clock = now;
  const feed = new SharpPropsFeed('key', null, { leagues: ['nfl'], books: ['draftkings', 'betmgm'], requestGapMs: 0 }, fetchFn, () => clock);
  await feed.refresh();
  assert.ok(asked[0]!.searchParams.get('market_type')!.split(',').length > 5, 'one comma-separated market_type list');
  assert.equal((await feed.status()).planSelects?.join(), 'draftkings,fanduel');
  await feed.refresh();
  assert.deepEqual((await feed.status()).selectedButEmpty, ['draftkings', 'betmgm'], 'no rows two refreshes running');
  assert.ok(((await feed.status()).requestsLastHour ?? 0) >= 2);
  // Nothing within 3 hours: due again only after an hour.
  assert.equal(feed.due(), false);
  clock = new Date(now.getTime() + 60 * 60_000);
  assert.equal(feed.due(), true);
});

test('Step 3: each app reads the other apps’ regular numbers, never its own, and skips an app listing two', async () => {
  const { anchorsFor, dfsAnchors } = await import('../src/edge/service.js');
  const base = { provider: 'prizepicks', sourceLineIdIsSynthetic: false, sport: 'NFL', league: 'NFL', eventId: 'e', eventName: 'A @ H',
    eventStartTime: start, playerId: 'p', playerName: 'Test Receiver', team: null, opponent: null, market: 'player_reception_yds',
    availableDirections: ['MORE', 'LESS'], lineType: 'REGULAR', fetchedAt: now.toISOString() } as const;
  const make = (id: string, threshold: number, extra: Partial<PropLine> = {}) => ({ ...base, id, sourceLineId: id, threshold, ...extra }) as PropLine;
  const index = dfsAnchors([{ platform: 'prizepicks', lines: [make('pp', 54.5), make('ppg', 39.5, { lineType: 'GOBLIN' })] },
    { platform: 'underdog', lines: [make('ud', 52.5)] },
    { platform: 'pick6', lines: [make('p6a', 50.5), make('p6b', 55.5)] }, { platform: 'draftkings', lines: [make('dk', 60.5)] }]);
  assert.deepEqual(anchorsFor(index, make('x', 52.5), 'underdog'), [54.5], 'PrizePicks only: own excluded, Pick6 ambiguous, books and Goblins never');
  assert.deepEqual(anchorsFor(index, make('x', 54.5), 'prizepicks'), [52.5]);
});

test('the books’ partial-game pass asks only for partial types SharpAPI has named in the PrizePicks pass', async () => {
  const asked: URL[] = [];
  const fetchFn = (async (input: URL | string) => {
    const url = new URL(String(input)); asked.push(url);
    const data = url.searchParams.get('sportsbooks') === 'prizepicks'
      ? [{ sportsbook: 'prizepicks', league: 'nfl', market_type: '1st_half_player_receiving_yards', selection_type: 'over', line: 30.5,
        player_name: 'Test Receiver', event_id: 'e1', event_start_time: start, is_live: false, is_active: true }] : [];
    return new Response(JSON.stringify({ data, pagination: { has_more: false } }));
  }) as typeof fetch;
  await new SharpPropsFeed('key', null, { leagues: ['nfl'], books: ['draftkings', 'prizepicks'], requestGapMs: 0 }, fetchFn, () => now).refresh();
  const partial = asked.find((url) => url.searchParams.get('sportsbooks') === 'draftkings' && url.searchParams.get('market_type')?.startsWith('1st_'));
  assert.equal(partial?.searchParams.get('market_type'), '1st_half_player_receiving_yards');
});

test('a requested book SharpAPI answers book_unavailable for is reported as down', async () => {
  const fetchFn = (async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.searchParams.get('sportsbooks') === 'hardrock') return new Response(JSON.stringify({ error: { code: 'book_unavailable' } }), { status: 503 });
    const data = url.searchParams.get('sportsbooks')?.includes('draftkings')
      ? [{ sportsbook: 'draftkings', league: 'nfl', market_type: 'player_receiving_yards', selection_type: 'over', line: 50.5, odds_american: -110,
        player_name: 'Test Receiver', event_id: 'e1', event_start_time: start, is_live: false, is_active: true }] : [];
    return new Response(JSON.stringify({ data, pagination: { has_more: false } }));
  }) as typeof fetch;
  const feed = new SharpPropsFeed('key', null, { leagues: ['nfl'], books: ['draftkings', 'hardrock'], requestGapMs: 0, retryScale: 0 }, fetchFn, () => now);
  await feed.refresh();
  assert.deepEqual((await feed.status()).unavailable, ['hardrock']);
});

test('a book the plan no longer selects gets its own note; a working book gets none', async () => {
  const { bookFeedNote } = await import('../src/context/sharp-props.js');
  const fetchFn = (async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.searchParams.get('sportsbooks') === 'hardrock') return new Response(JSON.stringify({ error: { code: 'book_not_selected',
      details: { selected: ['draftkings', 'caesars'] } } }), { status: 403 });
    return new Response(JSON.stringify({ data: [], pagination: { has_more: false } }));
  }) as typeof fetch;
  const feed = new SharpPropsFeed('key', null, { leagues: ['nfl'], books: ['draftkings', 'hardrock'], requestGapMs: 0, retryScale: 0 }, fetchFn, () => now);
  await feed.refresh();
  const status = await feed.status();
  assert.match(bookFeedNote(status, 'hardrock', 'Hard Rock') ?? '', /isn't available from our odds provider/);
  assert.equal(bookFeedNote(status, 'draftkings', 'DraftKings'), null);
  assert.match(bookFeedNote({ unavailable: ['hardrock'] }, 'hardrock', 'Hard Rock') ?? '', /reports the book unavailable/);
});

test('a runaway SharpAPI body is cut off instead of read into memory', async () => {
  const { capped } = await import('../src/context/sharp-props.js');
  let sent = 0;
  const endless = new ReadableStream<Uint8Array>({ pull(controller) { sent++; controller.enqueue(new Uint8Array(1024)); } });
  await assert.rejects(capped(new Response(endless), new URL('https://example.test/odds?league=nfl'), 64 * 1024), /TOO_LARGE/);
  assert.ok(sent < 200, 'stops reading at the cap');
  const ok = await capped(new Response(JSON.stringify({ data: [1] }), { status: 200 }), new URL('https://example.test/odds'));
  assert.deepEqual(await ok.json(), { data: [1] });
});

test('a dropped SharpAPI request is retried instead of failing the whole refresh', async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ data: [], pagination: { has_more: false } }));
  }) as typeof fetch;
  const status = await new SharpPropsFeed('key', null, { leagues: ['nfl'], books: ['draftkings'], requestGapMs: 0, retryScale: 0 }, fetchFn, () => now).refresh();
  assert.notEqual(status.lastError, 'fetch failed', 'the dropped request was tried again');
  assert.ok(calls >= 2);
});
