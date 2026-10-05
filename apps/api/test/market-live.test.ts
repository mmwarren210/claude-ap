import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameLine } from '../src/context/feeds.js';
import { kalshiOdds, LiveMarkets, polymarketOdds } from '../src/market-live.js';
import { marketPicks } from '../src/market-picks.js';

const kalshiEvents = [{ title: 'Kansas City at Las Vegas', event_ticker: 'KXNFLGAME-30OCT04KCLV', series_ticker: 'KXNFLGAME', markets: [
  { yes_sub_title: 'Las Vegas', yes_ask: 30, yes_bid: 29, status: 'active', expected_expiration_time: '2030-10-05T00:00:00Z', volume_24h: 900 },
  { yes_sub_title: 'Kansas City', yes_ask_dollars: '0.7100', yes_bid_dollars: '0.7000', status: 'active' },
  { yes_sub_title: 'Tie', yes_ask: 0, status: 'active' }] }];
const polymarketEvents = [{ title: 'Chiefs vs. Raiders', slug: 'nfl-kc-lv-2030-10-04', markets: [
  { question: 'Chiefs vs. Raiders', outcomes: '["Chiefs","Raiders"]', outcomePrices: '["0.675","0.325"]', volume24hr: 1000,
    gameStartTime: '2030-10-04 20:25:00+00' },
  { question: 'Old market', outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', closed: true }] }];

test('Kalshi markets read at the ask (cents or dollars); Polymarket outcomes and prices from their JSON strings', () => {
  const kalshi = kalshiOdds(kalshiEvents);
  assert.deepEqual(kalshi.map((item) => [item.question, item.outcomes[0]!.probability, item.outcomes[1]!.probability]),
    [['Kansas City at Las Vegas — Las Vegas', 30, 71], ['Kansas City at Las Vegas — Kansas City', 71, 30]]);
  assert.equal(kalshi[0]!.url, 'https://kalshi.com/markets/kxnflgame/kxnflgame-30oct04kclv');
  const polymarket = polymarketOdds(polymarketEvents);
  assert.deepEqual(polymarket.map((item) => item.outcomes), [[{ name: 'Chiefs', probability: 67.5 }, { name: 'Raiders', probability: 32.5 }]]);
  // City-named Kalshi markets match Pinnacle's game.
  const games: GameLine[] = [{ league: 'NFL', home: 'Las Vegas Raiders', away: 'Kansas City Chiefs', startTime: '2030-10-04T20:25:00Z',
    market: 'moneyline', line: null, homePrice: null, awayPrice: null, homeFair: 0.36, awayFair: 0.64, sourceUrl: null }];
  const picks = marketPicks('kalshi', kalshi, games, new Date('2030-10-04T12:00:00Z'), 0.01);
  assert.deepEqual(picks.map((pick) => [pick.side, pick.price, pick.cost]), [['Las Vegas to win', 0.3, 0.32]]);
});

test('live markets: a failed read keeps the last prices; stale prices fall back to the feed', async () => {
  let now = new Date('2030-10-04T12:00:00Z'), fail = false;
  const fetchFn = (async (url: string) => {
    if (fail) return new Response('no', { status: 503 });
    const body = url.includes('kalshi') ? { events: url.includes('KXNFLGAME') ? kalshiEvents : [], cursor: '' }
      : url.includes('tag_slug=nfl') ? polymarketEvents : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const live = new LiveMarkets(null, fetchFn, () => now);
  const first = await live.refresh();
  assert.deepEqual(first.markets, { kalshi: 2, polymarket: 1 });
  fail = true; now = new Date('2030-10-04T12:10:00Z');
  const second = await live.refresh();
  assert.equal(second.markets.kalshi, 2, 'kept');
  assert.equal(second.lastError.kalshi, 'HTTP_503');
  assert.ok(await live.items('kalshi'), 'still fresh at 10 minutes');
  now = new Date('2030-10-04T12:45:00Z');
  assert.equal(await live.items('kalshi'), null, 'stale after 30 minutes');
});
