import assert from 'node:assert/strict';
import test from 'node:test';
import { eventLines, isPropMarket, marketLabel, PropLineClient, propLineBoard, proplineLeague } from '../src/scrapers/propline.js';

// Synthetic values in PropLine's response shape (checked live 2026-10-08): no network.
const outcome = (name: string, player: string, point: number, flavor: string | null) =>
  ({ name, description: player, price: 100, point, dfs_odds_type: flavor, payout_multiplier: null, player_id: 'espn:1' });
const event = { id: '32678', sport_key: 'football_nfl', home_team: 'Dallas Cowboys', away_team: 'Tampa Bay Buccaneers',
  commence_time: '2030-01-06T00:15:00Z', bookmakers: [{ key: 'prizepicks', markets: [
    { key: 'player_pass_yds', outcomes: [outcome('Over', 'Dak Prescott', 245.5, 'standard'), outcome('Under', 'Dak Prescott', 245.5, 'standard'),
      outcome('Over', 'Dak Prescott', 215.5, 'goblin'), outcome('Over', 'Dak Prescott', 275.5, 'demon'),
      outcome('Under', 'Dak Prescott', 275.5, 'demon')] },
    { key: 'player_reception_yds', outcomes: [outcome('Over', 'Mike Evans', 62.5, 'standard'), outcome('Over', 'Mike Evans', 60.5, 'sparkle')] }] },
  { key: 'draftkings', markets: [{ key: 'player_pass_yds', outcomes: [outcome('Over', 'Dak Prescott', 240.5, null)] }] }] };

test('PrizePicks lines from PropLine: tiers kept, real sides only, Goblin/Demon MORE-only, model market keys', () => {
  const dropped: string[] = [];
  const lines = eventLines(event, 'NFL', 'NFL', { app: 'prizepicks', bookmaker: 'prizepicks' }, (reason) => dropped.push(reason));
  const view = lines.map((line) => [line.player, line.marketKey, line.tier, line.line, line.directions.join('/')]);
  assert.deepEqual(view, [
    ['Dak Prescott', 'passing_yards', 'REGULAR', 245.5, 'MORE/LESS'],
    ['Dak Prescott', 'passing_yards', 'GOBLIN', 215.5, 'MORE'],
    ['Dak Prescott', 'passing_yards', 'DEMON', 275.5, 'MORE'],
    ['Mike Evans', 'player_reception_yds', 'REGULAR', 62.5, 'MORE'],
  ]);
  assert.deepEqual(dropped.sort(), ['ALTERNATE_UNDER', 'TIER_SPARKLE']);
  assert.ok(lines.every((line) => line.league === 'NFL' && line.gameId === 'propline:32678' && line.home?.name === 'Dallas Cowboys'));
  assert.equal(new Set(lines.map((line) => line.appLineId)).size, 4, 'one stable id per player, market, tier and number');
  assert.ok(lines.every((line) => !line.multipliers), 'no payout invented');
});

test('league labels, prop-market filter and readable stat names', () => {
  assert.deepEqual(['football_ncaaf', 'soccer_epl', 'hockey_nhl', 'mma_ufc', 'esports'].map(proplineLeague), ['CFB', 'SOCCER', 'NHL', 'UFC', 'ESPORTS']);
  assert.deepEqual(['player_pass_yds', 'batter_hits', 'h2h', 'spreads', 'player_anytime_td', 'player_kills_maps_1_2'].map(isPropMarket),
    [true, true, false, false, false, true]);
  assert.equal(marketLabel('player_pass_yds'), 'Pass Yds');
});

test('a full pull: discovery, one bulk request per sport, and a failed request never takes lines down', async () => {
  const calls: string[] = [];
  let fail = false;
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'x-daily-remaining': '249000' } });
    if (url.pathname === '/v1/sports') return json([{ key: 'football_nfl', active: true }]);
    if (url.pathname.endsWith('/events')) return json([{ id: '32678', commence_time: '2030-01-06T00:15:00Z' }]);
    if (url.pathname.endsWith('/markets')) return json([{ key: 'h2h' }, { key: 'player_pass_yds' }, { key: 'player_reception_yds' }]);
    return fail ? json({}, 500) : json([event]);
  }) as typeof fetch;
  const client = new PropLineClient('k', fetchFn, 8, 'https://pl.test', async () => undefined);
  const source = propLineBoard(client, { app: 'prizepicks', bookmaker: 'prizepicks', clock: () => new Date('2030-01-05T00:00:00Z') });
  const first = await source.run!();
  assert.equal(first.rows.length, 4);
  assert.equal(first.complete, true);
  assert.ok(calls.includes('/v1/sports/football_nfl/odds?markets=player_pass_yds,player_reception_yds&bookmakers=prizepicks'));
  assert.equal(client.remaining, 249000);
  // Discovery is cached: the next pull is just the bulk request.
  calls.length = 0;
  fail = true;
  const second = await source.run!();
  assert.deepEqual(calls.filter((path) => !path.includes('/odds')), []);
  assert.equal(second.complete, false, 'a failed sport request never counts as a complete pull');
});

test('Pick6 alternates are ordinary picks at their own number; Underdog lines are regular with both sides', () => {
  const pick6 = { ...event, bookmakers: [{ key: 'pick6', markets: [{ key: 'player_pass_yds', outcomes: [
    outcome('Over', 'Dak Prescott', 245.5, 'standard'), outcome('Under', 'Dak Prescott', 245.5, 'standard'),
    outcome('Over', 'Dak Prescott', 275.5, 'alternate')] }] }] };
  assert.deepEqual(eventLines(pick6, 'NFL', 'NFL', { app: 'pick6', bookmaker: 'pick6' }).map((line) => [line.line, line.tier, line.directions.join('/')]),
    [[245.5, 'REGULAR', 'MORE/LESS'], [275.5, 'REGULAR', 'MORE']]);
  const underdog = { ...event, bookmakers: [{ key: 'underdog', markets: [{ key: 'player_pass_yds', outcomes: [
    outcome('Over', 'Dak Prescott', 245.5, null), outcome('Under', 'Dak Prescott', 245.5, null)] }] }] };
  assert.deepEqual(eventLines(underdog, 'NFL', 'NFL', { app: 'underdog', bookmaker: 'underdog' }).map((line) => [line.app, line.tier, line.directions.join('/')]),
    [['underdog', 'REGULAR', 'MORE/LESS']]);
});

test('Dabble: an Edge platform with its own all-hit payout chart, its PropLine lines read as regular lines', async () => {
  const { EDGE_PLATFORMS } = await import('../src/edge/service.js');
  const { DEFAULT_PAYOUTS } = await import('@crowniq/contracts');
  assert.ok(EDGE_PLATFORMS.includes('dabble'));
  // The chart from Dabble's own app: all picks must hit, 2–12 picks; no Hedge or partial payouts assumed.
  assert.deepEqual(DEFAULT_PAYOUTS.dabble.POWER[2], { 2: 3 });
  assert.deepEqual(DEFAULT_PAYOUTS.dabble.POWER[12], { 12: 1500 });
  assert.deepEqual(DEFAULT_PAYOUTS.dabble.FLEX, {});
  const dabble = { ...event, bookmakers: [{ key: 'dabble', markets: [{ key: 'player_pass_yds', outcomes: [
    outcome('Over', 'Dak Prescott', 244.5, null), outcome('Under', 'Dak Prescott', 244.5, null)] }] }] };
  assert.deepEqual(eventLines(dabble, 'NFL', 'NFL', { app: 'dabble', bookmaker: 'dabble' }).map((line) => [line.app, line.tier, line.line]),
    [['dabble', 'REGULAR', 244.5]]);
});
