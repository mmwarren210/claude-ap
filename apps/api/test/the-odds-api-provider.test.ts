import assert from 'node:assert/strict';
import test from 'node:test';
import { propLineSchema } from '@crowniq/contracts';
import { classifyPrizePicksLineTypes } from '../src/prizepicks-line-types.js';
import { TheOddsApiProvider } from '../src/the-odds-api-provider.js';

// Synthetic provider responses only. These are not live PrizePicks lines.
const event = {
  id: 'fixture-event', sport_key: 'americanfootball_nfl',
  commence_time: '2030-09-25T00:00:00Z', home_team: 'Fixture Home', away_team: 'Fixture Away',
};

function response(value: unknown, cost: number) {
  return new Response(JSON.stringify(value), { status: 200,
    headers: { 'x-requests-remaining': String(40 - cost), 'x-requests-last': String(cost) } });
}

test('fetches only PrizePicks, preserves regular/alternate directions and marks missing source IDs', async () => {
  const urls: URL[] = [];
  const provider = new TheOddsApiProvider({ apiKey: 'fixture-key', baseUrl: 'https://example.test',
    fetchFn: async (input) => {
      const url = new URL(String(input)); urls.push(url);
      if (url.pathname.endsWith('/events')) return response([event], 0);
      return response({ ...event, bookmakers: [
        { key: 'unwanted_book', markets: [{ key: 'player_pass_yds', outcomes: [
          { name: 'Over', description: 'Ignore Me', point: 200.5 },
        ] }] },
        { key: 'prizepicks', markets: [
          { key: 'player_pass_yds', outcomes: [
            { name: 'Over', description: 'Fixture QB', point: 240.5, sid: 'pp-over' },
            { name: 'Under', description: 'Fixture QB', point: 240.5, sid: 'pp-under' },
          ] },
          { key: 'player_pass_yds_alternate', outcomes: [
            { name: 'Over', description: 'Fixture QB', point: 220.5, multiplier: 0.8, sid: 'pp-goblin' },
            { name: 'Over', description: 'Fixture QB', point: 260.5, multiplier: 1.5, sid: 'pp-demon' },
            { name: 'Under', description: 'Fixture QB', point: 280.5, sid: null, multiplier: null },
          ] },
        ] },
      ] }, 2);
    },
  });

  const raw = await provider.fetchPrizePicksLines();
  const lines = classifyPrizePicksLineTypes(raw.map((selection) => propLineSchema.parse(
    provider.normalize(selection, '2030-09-24T12:00:00Z'))));
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get('bookmakers'), 'prizepicks');
  assert.equal(urls[1].searchParams.get('regions'), null);
  assert.equal(urls[1].searchParams.get('includeMultipliers'), 'true');
  assert.equal(urls[1].searchParams.get('includeSids'), 'true');
  assert.deepEqual(lines.map(({ lineType }) => lineType),
    ['REGULAR', 'REGULAR', 'GOBLIN', 'DEMON', 'GOBLIN']);
  assert.deepEqual(lines.map(({ availableDirections }) => availableDirections),
    [['MORE'], ['LESS'], ['MORE'], ['MORE'], ['LESS']]);
  assert.equal(lines[0].sourceLineId, 'pp-over');
  assert.equal(lines[0].sourceLineIdIsSynthetic, false);
  assert.equal(lines[4].sourceLineIdIsSynthetic, true);
  assert.equal(lines[4].payoutMultiplier, undefined);
  assert.equal(lines.filter(({ playerName }) => playerName === 'Ignore Me').length, 0);
  assert.equal(new Set(lines.map(({ id }) => id)).size, lines.length);
  assert.deepEqual(provider.getHealth(), { creditsRemaining: 38, lastRequestCost: 2, lastHttpStatus: 200 });
});

test('aborts before paid event requests when the complete board exceeds budget', async () => {
  let requests = 0;
  const provider = new TheOddsApiProvider({ apiKey: 'fixture-key', maxEvents: 1,
    fetchFn: async () => { requests++; return response([event, { ...event, id: 'event-2' }], 0); },
  });
  await assert.rejects(provider.fetchPrizePicksLines(), /ODDS_API_REFRESH_BUDGET_EXCEEDED/);
  assert.equal(requests, 1);
});

test('missing player identity fails the complete refresh instead of publishing partial lines', async () => {
  const provider = new TheOddsApiProvider({ apiKey: 'fixture-key',
    fetchFn: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) return response([event], 0);
      return response({ ...event, bookmakers: [{ key: 'prizepicks', markets: [
        { key: 'player_pass_yds', outcomes: [{ name: 'Over', point: 240.5 }] },
      ] }] }, 1);
    },
  });
  await assert.rejects(provider.fetchPrizePicksLines(), /ODDS_API_INCOMPLETE_PLAYER_PROP/);
});

test('HTTP failures do not expose a credential in the error', async () => {
  const provider = new TheOddsApiProvider({ apiKey: 'fixture-secret-key',
    fetchFn: async () => new Response('{}', { status: 429 }),
  });
  await assert.rejects(provider.fetchPrizePicksLines(), (error: unknown) => {
    assert.equal((error as Error).message, 'ODDS_API_HTTP_429');
    assert.ok(!(error as Error).message.includes('fixture-secret-key'));
    return true;
  });
  assert.equal(provider.getHealth().lastHttpStatus, 429);
});
