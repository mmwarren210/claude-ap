import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PropLineClient } from '../src/scrapers/propline.js';
import { PropLinePush } from '../src/scrapers/propline-push.js';
import { ScrapedLineStore } from '../src/scrapers/line-store.js';
import type { ScrapedLine } from '../src/scrapers/scraped-line.js';

const sign = (secret: string, body: string, at = Math.floor(Date.now() / 1000)) => ({ 'x-propline-timestamp': String(at),
  'x-propline-signature': createHmac('sha256', secret).update(`${at}.`).update(body).digest('hex') });

test('PropLine push: subscribes once, accepts only signed deliveries, batches moves into one sport re-pull, takes pulled markets down', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-push-'));
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/v1/webhooks' && (init?.method ?? 'GET') === 'GET') return new Response('[]', { status: 200 });
    if (url.pathname === '/v1/webhooks' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { events: string[] };
      return new Response(JSON.stringify({ id: body.events.includes('steam') ? 2 : 1, secret: body.events.includes('steam') ? 'steam-secret' : 'apps-secret' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const client = new PropLineClient('k', fetchFn, 8, 'https://pl.test', async () => undefined);
  const pulls: [string, string[]][] = [], suspended: unknown[][] = [], graded: unknown[] = [];
  const push = new PropLinePush(client, 'https://crowniq.test/v1/hooks/propline', join(folder, 'push.json'), {
    pullSports: async (app, sports) => { pulls.push([app, [...sports]]); },
    suspend: async (...args) => { suspended.push(args); return 2; },
    resolution: (event) => graded.push(event) }, 10);
  try {
    await push.ensure(['football_nfl', 'basketball_nba']);
    assert.deepEqual(calls.filter((call) => call.startsWith('POST')), ['POST /v1/webhooks', 'POST /v1/webhooks']);
    // A forged delivery is refused.
    const body = JSON.stringify({ batch: true, event_type: 'line_movement', count: 3, events: [
      { delivery_id: 1, data: { event_type: 'line_movement', bookmaker_key: 'prizepicks', sport_key: 'football_nfl' } },
      { delivery_id: 2, data: { event_type: 'line_movement', bookmaker_key: 'prizepicks', sport_key: 'football_nfl' } },
      { delivery_id: 3, data: { event_type: 'line_movement', bookmaker_key: 'draftkings', sport_key: 'football_nfl' } }] });
    assert.equal(await push.receive(Buffer.from(body), sign('wrong', body)), false);
    assert.equal(await push.receive(Buffer.from(body), { ...sign('apps-secret', body), 'x-propline-sequence': '7' }), true);
    await new Promise((done) => setTimeout(done, 40));
    assert.deepEqual(pulls, [['prizepicks', ['football_nfl']]], 'two moves, one re-pull; a sportsbook move is not an app re-pull');
    const pulled = JSON.stringify({ event_type: 'market_suspended', bookmaker_key: 'underdog', sport_key: 'football_nfl',
      event: { id: 55 }, subject: 'Dak Prescott', markets: [{ key: 'player_rush_tds' }] });
    assert.equal(await push.receive(Buffer.from(pulled), sign('apps-secret', pulled)), true);
    await new Promise((done) => setTimeout(done, 5));
    assert.deepEqual(suspended[0], ['underdog', 'propline:55', 'Dak Prescott', ['player_rush_tds', 'rush_tds']]);
    const grade = JSON.stringify({ event_type: 'resolution', player_name: 'Dak Prescott' });
    assert.equal(await push.receive(Buffer.from(grade), sign('apps-secret', grade)), true);
    assert.equal(graded.length, 1);
    assert.equal(push.status().subscriptions.find((item) => item.name === 'apps')?.lastSeq, 7);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('line store: a partial (one league) pull replaces only that league; a pulled market comes down', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-scope-'));
  const at = new Date('2030-01-10T12:00:00Z'), start = '2030-01-11T00:00:00Z';
  const line = (id: string, league: string, player: string, value: number, marketKey = 'player_points'): ScrapedLine => ({ app: 'prizepicks',
    appLineId: id, league, gameId: 'propline:55', player, team: null, opponent: null, stat: 'Points', marketKey, line: value, tier: 'REGULAR',
    directions: ['MORE', 'LESS'], startTime: start } as unknown as ScrapedLine);
  const store = new ScrapedLineStore(join(folder, 'lines.json'), () => at);
  try {
    await store.ingest('propline-prizepicks', [line('a', 'NBA', 'Alpha', 20.5), line('b', 'NFL', 'Bravo', 50.5)], { complete: true, apps: ['prizepicks'] });
    // NBA re-pull without line "a" (it moved to a new id) and nothing for NFL: only NBA's old line comes down.
    const report = await store.ingest('propline-prizepicks', [line('a2', 'NBA', 'Alpha', 21.5)], { complete: true, apps: ['prizepicks'],
      scope: (item) => item.league === 'NBA' });
    assert.equal(report.removed, 1);
    assert.deepEqual((await store.active('prizepicks')).map((item) => item.appLineId).sort(), ['a2', 'b']);
    assert.equal(await store.suspend('prizepicks', 'propline:55', 'bravo', ['player_points']), 1);
    assert.deepEqual((await store.active('prizepicks')).map((item) => item.appLineId), ['a2']);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
