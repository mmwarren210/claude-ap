import assert from 'node:assert/strict';
import test from 'node:test';
import { FullPrizePicksProvider } from '../src/full-prizepicks-provider.js';
import { classifyPrizePicksLineTypes } from '../src/prizepicks-line-types.js';

// All responses are fabricated contract fixtures. The tests never spend credits.
const sports = [
  { key: 'americanfootball_nfl', title: 'NFL', active: true },
  { key: 'tennis_atp_us_open', title: 'ATP US Open', active: true },
];
const nfl = { id: 'fixture-nfl', sport_key: sports[0].key,
  commence_time: '2030-09-25T00:00:00Z', home_team: 'Fixture Home', away_team: 'Fixture Away' };
const tennis = { id: 'fixture-tennis', sport_key: sports[1].key,
  commence_time: '2030-09-25T03:00:00Z', home_team: 'Fixture B', away_team: 'Fixture A' };

function mockFetch(initialQuota: number, requested: URL[]) {
  let remaining = initialQuota;
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requested.push(url);
    const path = url.pathname;
    let body: unknown;
    let cost = 0;
    if (path === '/v4/sports') body = sports;
    else if (path.endsWith('/events')) body = path.includes('tennis_') ? [tennis] : [nfl];
    else if (path.endsWith('/markets')) {
      cost = 1;
      const event = path.includes('tennis_') ? tennis : nfl;
      body = { ...event, bookmakers: [
        { key: 'unwanted_book', markets: [{ key: 'player_rush_yds' }] },
        { key: 'prizepicks', markets: (event === tennis
          ? ['player_aces', 'h2h'] : ['player_pass_yds', 'player_pass_yds_alternate'])
          .map((key) => ({ key })) },
      ] };
    } else if (path.endsWith('/odds')) {
      const event = path.includes('tennis_') ? tennis : nfl;
      const markets = url.searchParams.get('markets')!.split(',');
      cost = markets.length;
      body = { ...event, bookmakers: [{ key: 'prizepicks', markets: markets.map((key) => ({
        key, outcomes: event === tennis ? [
          { name: 'Over', description: 'Fixture Tennis Player', point: 8.5, sid: 'ace-id' },
        ] : key.endsWith('_alternate') ? [
          { name: 'Over', description: 'Fixture QB', point: 219.5, multiplier: 0.85 },
          { name: 'Under', description: 'Fixture QB', point: 269.5, multiplier: 1.6 },
        ] : [
          { name: 'Over', description: 'Fixture QB', point: 240.5, sid: 'pass-id' },
        ],
      })) }] };
    } else throw new Error('Unexpected fixture URL');
    remaining -= cost;
    return new Response(JSON.stringify(body), { status: 200, headers: {
      'x-requests-remaining': String(remaining), 'x-requests-last': String(cost),
    } });
  };
}

test('discovers every active sport and PrizePicks market and retains all playable thresholds', async () => {
  const requested: URL[] = [];
  const provider = new FullPrizePicksProvider({ apiKey: 'fixture-key',
    fetchFn: mockFetch(50, requested) });
  const raw = await provider.fetchPrizePicksLines();
  const lines = classifyPrizePicksLineTypes(raw.map((item) =>
    provider.normalize(item, '2030-09-24T12:00:00Z')));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((line) => line.lineType),
    ['REGULAR', 'GOBLIN', 'GOBLIN', 'REGULAR']);
  assert.deepEqual(lines.map((line) => line.availableDirections),
    [['MORE'], ['MORE'], ['LESS'], ['MORE']]);
  assert.deepEqual(lines.map((line) => line.sourceSportKey),
    ['americanfootball_nfl', 'americanfootball_nfl', 'americanfootball_nfl', 'tennis_atp_us_open']);
  assert.equal(lines[3].sport, 'TENNIS');
  assert.equal(lines[0].sourceLineId, 'pass-id');
  assert.equal(lines[1].sourceLineIdIsSynthetic, true);
  assert.equal(requested.filter((url) => url.pathname.endsWith('/odds')).length, 2);
  assert.ok(requested.filter((url) => url.pathname.endsWith('/odds') ||
    url.pathname.endsWith('/markets')).every((url) => url.searchParams.get('bookmakers') === 'prizepicks'));
  assert.equal(requested.some((url) => url.searchParams.get('markets')?.includes('h2h')), false);
  assert.deepEqual(provider.getHealth().coverage, {
    sportsScanned: 2, eventsDiscovered: 2, eventsWithPrizePicks: 2,
    marketsDiscovered: 3, oddsRequests: 2, selections: 4, skippedOutcomes: 0,
    creditsSpent: 5, creditsRemaining: 45, complete: true,
    marketKeys: ['player_aces', 'player_pass_yds', 'player_pass_yds_alternate'],
    sportKeysWithLines: ['americanfootball_nfl', 'tennis_atp_us_open'],
  });
});

test('normalizes verified NHL provider market aliases into existing CrownIQ model keys',()=>{
  const provider=new FullPrizePicksProvider({apiKey:'fixture-key',fetchFn:mockFetch(50,[])});
  const base={
    sport:{key:'icehockey_nhl',title:'NHL',active:true},
    event:{id:'fixture-nhl',sport_key:'icehockey_nhl',commence_time:'2030-09-25T00:00:00Z',
      home_team:'Fixture Home',away_team:'Fixture Away'},
    outcome:{name:'Over',description:'Fixture Skater',point:2.5,sid:'nhl-id'},
  };
  const points=provider.normalize({...base,marketKey:'player_points'},'2030-09-24T12:00:00Z');
  const shots=provider.normalize({...base,marketKey:'player_shots_on_goal_alternate',
    outcome:{...base.outcome,point:3.5,sid:'nhl-shot-id'}},'2030-09-24T12:00:00Z');
  assert.equal(points.sport,'NHL');
  assert.equal(points.market,'points');
  assert.equal(points.sourceMarketKey,'player_points');
  assert.equal(shots.market,'shots_on_goal');
  assert.equal(shots.sourceMarketKey,'player_shots_on_goal_alternate');
  assert.equal(shots.lineType,'UNKNOWN_ALTERNATE');
});

test('refuses to spend on market discovery when quota cannot cover every event', async () => {
  const requested: URL[] = [];
  const provider = new FullPrizePicksProvider({ apiKey: 'fixture-key',
    fetchFn: mockFetch(1, requested) });
  await assert.rejects(provider.fetchPrizePicksLines(), /ODDS_API_INSUFFICIENT_CREDITS_FOR_FULL_BOARD/);
  assert.equal(requested.filter((url) => /\/(markets|odds)$/.test(url.pathname)).length, 0);
  assert.equal(provider.getHealth().coverage?.complete, false);
});

test('refuses to publish a partial board when discovered prop markets exceed remaining quota', async () => {
  const requested: URL[] = [];
  const provider = new FullPrizePicksProvider({ apiKey: 'fixture-key',
    fetchFn: mockFetch(4, requested) });
  await assert.rejects(provider.fetchPrizePicksLines(), /ODDS_API_INSUFFICIENT_CREDITS_FOR_FULL_BOARD/);
  assert.equal(requested.filter((url) => url.pathname.endsWith('/markets')).length, 2);
  assert.equal(requested.filter((url) => url.pathname.endsWith('/odds')).length, 0);
  assert.equal(provider.getHealth().coverage?.creditsSpent, 2);
});
