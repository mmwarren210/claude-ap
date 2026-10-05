import assert from 'node:assert/strict';
import test from 'node:test';
import { FullPrizePicksProvider } from '../src/full-prizepicks-provider.js';

// Fabricated contract fixtures; no provider credits are spent.
const sport = { key: 'basketball_nba', title: 'NBA', active: true };
const event = { id: 'fixture-nba', sport_key: sport.key, commence_time: '2030-01-10T00:00:00Z',
  home_team: 'Home', away_team: 'Away' };

function fetchFixture(requested: URL[]) {
  let remaining = 100;
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); requested.push(url);
    let body: unknown, cost = 0;
    if (url.pathname === '/v4/sports') body = [sport];
    else if (url.pathname.endsWith('/events')) body = [event];
    else if (url.pathname.endsWith('/markets')) {
      cost = 1;
      body = { ...event, bookmakers: [{ key: 'prizepicks', markets: [{ key: 'player_points' }] }] };
    } else {
      cost = 1;
      body = { ...event, bookmakers: [
        { key: 'prizepicks', markets: [{ key: 'player_points', outcomes: [
          { name: 'Over', description: 'Fixture Guard', point: 24.5, sid: 'pp-over' },
          { name: 'Under', description: 'Fixture Guard', point: 24.5, sid: 'pp-under' }] }] },
        { key: 'pinnacle', markets: [{ key: 'player_points', outcomes: [
          { name: 'Over', description: 'Fixture Guard', point: 26.5, price: 1.87 },
          { name: 'Under', description: 'Fixture Guard', point: 26.5, price: 1.95 }] }] },
        { key: 'fanduel', markets: [{ key: 'player_points', outcomes: [
          { name: 'Over', description: 'Fixture Guard', point: 27.5, price: 2.1 },
          { name: 'Over', description: 'No Price', point: 27.5 }] }] },
        { key: 'unrequested_book', markets: [{ key: 'player_points', outcomes: [
          { name: 'Over', description: 'Fixture Guard', point: 20.5, price: 1.5 }] }] },
      ] };
    }
    remaining -= cost;
    return new Response(JSON.stringify(body), { status: 200, headers: {
      'x-requests-remaining': String(remaining), 'x-requests-last': String(cost) } });
  };
}

test('consensus books ride along in the same odds request and become market quotes', async () => {
  const requested: URL[] = [];
  const provider = new FullPrizePicksProvider({ apiKey: 'fixture-key', fetchFn: fetchFixture(requested),
    consensusBookmakers: ['pinnacle', 'fanduel'] });
  const raw = await provider.fetchPrizePicksLines();
  assert.equal(raw.length, 2);
  const odds = requested.filter((url) => url.pathname.endsWith('/odds'));
  assert.equal(odds.length, 1);
  assert.equal(odds[0].searchParams.get('bookmakers'), 'prizepicks,pinnacle,fanduel');
  assert.equal(odds[0].searchParams.get('oddsFormat'), 'decimal');
  assert.equal(provider.getHealth().coverage?.creditsSpent, 2);
  const quotes = provider.marketQuotes('2030-01-09T12:00:00Z');
  assert.deepEqual(quotes.map((quote) => [quote.bookmaker, quote.point, quote.overPrice, quote.underPrice]),
    [['pinnacle', 26.5, 1.87, 1.95], ['fanduel', 27.5, 2.1, null]]);
  assert.equal(quotes[0].sport, 'NBA');
  assert.equal(quotes[0].market, 'player_points');
});

test('consensus books are optional and validated', async () => {
  const requested: URL[] = [];
  const provider = new FullPrizePicksProvider({ apiKey: 'fixture-key', fetchFn: fetchFixture(requested) });
  await provider.fetchPrizePicksLines();
  assert.equal(requested.find((url) => url.pathname.endsWith('/odds'))!.searchParams.get('bookmakers'), 'prizepicks');
  assert.equal(provider.marketQuotes('2030-01-09T12:00:00Z').length, 0);
  assert.throws(() => new FullPrizePicksProvider({ apiKey: 'k', consensusBookmakers: Array.from({ length: 10 }, (_, i) => 'b' + i) }),
    /INVALID_CONSENSUS_BOOKMAKERS/);
});
