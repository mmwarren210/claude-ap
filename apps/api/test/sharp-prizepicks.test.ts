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
  const feed = new SharpPropsFeed('key', null, { leagues: ['nfl'], books: ['draftkings', 'prizepicks'], requestGapMs: 0 }, fetchFn, () => now);
  const heard: [number, boolean][] = [];
  feed.whenPickem((lines, ok) => { heard.push([lines.length, ok]); });
  await feed.refresh();
  assert.deepEqual(asked, ['draftkings', 'prizepicks'], 'books without PrizePicks, then PrizePicks alone');
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
