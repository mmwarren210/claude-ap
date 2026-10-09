import assert from 'node:assert/strict';
import test from 'node:test';
import { propLineSchema } from '@crowniq/contracts';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { ContextFeeds, injuryReports } from '../src/context/feeds.js';
import { eventGameLines, proplineGameLines } from '../src/context/propline-game-lines.js';
import type { PropLineClient } from '../src/scrapers/propline.js';
import type { ApifyClient } from '../src/scrapers/apify-client.js';
import type { DailySpendBudget } from '../src/scrapers/spend-budget.js';
import { gameLinesFor, injuryFor } from '../src/context/match.js';

const line = propLineSchema.parse({ ...fixtureLine(), sport: 'NFL', league: 'NFL', playerName: 'Caleb Williams',
  team: 'Chicago Bears', opponent: 'New York Jets', homeTeam: 'Chicago Bears', awayTeam: 'New York Jets',
  eventStartTime: '2030-10-04T17:00:00.000Z' });
const injury = injuryReports.read({ type: 'injury', league: 'nfl', team: 'Chicago Bears', teamAbbreviation: 'CHI',
  player: 'Caleb Williams', positionAbbreviation: 'QB', status: 'Out', injuryType: 'Hamstring', returnDate: '2030-10-11',
  shortComment: 'Williams is out Sunday.', reportedAt: '2030-10-04T15:50Z', playerUrl: 'https://www.espn.com/x' })!;
// One PropLine event: DraftKings and Pinnacle both price it; Pinnacle is read first, DraftKings fills the market it lacks.
const event = { home_team: 'Chicago Bears', away_team: 'New York Jets', commence_time: '2030-10-04T17:00:00Z', bookmakers: [
  { key: 'draftkings', markets: [
    { key: 'h2h', outcomes: [{ name: 'Chicago Bears', price: -200 }, { name: 'New York Jets', price: 170 }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 44.5 }, { name: 'Under', price: -110, point: 44.5 }] }] },
  { key: 'pinnacle', markets: [
    { key: 'h2h', outcomes: [{ name: 'Chicago Bears', price: -183 }, { name: 'New York Jets', price: 164 }] },
    { key: 'spreads', outcomes: [{ name: 'Chicago Bears', price: -105, point: -3.5 }, { name: 'New York Jets', price: -105, point: 3.5 }] }] }] };
const pinnacle = eventGameLines(event, 'NFL').find((item) => item.market === 'moneyline')!;

test('context feeds read each scraper row and match it to a board line conservatively', () => {
  assert.deepEqual([injury.league, injury.status, injury.injury], ['NFL', 'Out', 'Hamstring']);
  assert.equal(injuryFor(line, [injury])?.player, 'Caleb Williams');
  assert.equal(injuryFor({ ...line, team: 'Detroit Lions' }, [injury]), null, 'another team with that name is not matched');
  const games = gameLinesFor(line, [pinnacle]);
  assert.equal(games.length, 1);
  assert.equal(gameLinesFor({ ...line, eventStartTime: '2030-10-11T17:00:00.000Z' }, [pinnacle]).length, 0);
});

test('PropLine game lines take Pinnacle first, fill gaps from DraftKings and remove the vig', async () => {
  const lines = eventGameLines(event, 'NFL');
  assert.deepEqual(lines.map((item) => [item.market, item.line, item.homePrice]),
    [['moneyline', null, -183], ['spread', -3.5, -105], ['total', 44.5, -110]]);
  assert.ok(Math.abs(pinnacle.homeFair! + pinnacle.awayFair! - 1) < 1e-9);
  assert.ok(Math.abs(pinnacle.homeFair! - 0.6306) < 0.001, '-183 and +164 without the vig');
  assert.deepEqual(eventGameLines({ ...event, home_team: null }, 'NFL'), [], 'an event without both teams is skipped');
  // One request per sport, kept for the cache window.
  let calls = 0, now = 0;
  const client = { propMarkets: async () => new Map([['football_nfl', ['player_pass_yds']]]),
    get: async () => { calls++; return [event]; } } as unknown as PropLineClient;
  const read = proplineGameLines(client, 60_000, () => now);
  assert.equal((await read()).length, 3);
  await read(); assert.equal(calls, 1);
  now = 61_000; await read(); assert.equal(calls, 2);
});

test('a context pull spends from the shared budget, keeps the last good snapshot and counts blank runs', async () => {
  let spent = 0, rows: unknown[] = [{ type: 'injury', league: 'nfl', team: 'Chicago Bears', player: 'Caleb Williams', status: 'Out' }];
  const apify = { runActor: async () => ({ status: 'SUCCEEDED', usageUsd: 0.2, datasetId: 'd' }),
    datasetItems: async () => rows } as unknown as ApifyClient;
  const budget = { remaining: async () => 15 - spent, record: async (usd: number) => { spent += usd; } } as unknown as DailySpendBudget;
  const feeds = new ContextFeeds(apify, budget, [{ source: injuryReports, hoursEt: [8] }], null);
  assert.equal((await feeds.pull('injuries')).status, 'SUCCEEDED');
  assert.equal((await feeds.items('injuries')).items.length, 1);
  rows = [];
  const blank = await feeds.pull('injuries');
  assert.deepEqual([blank.status, blank.reason], ['FAILED', 'NO_ROWS']);
  assert.equal((await feeds.items('injuries')).items.length, 1, 'a blank run keeps the previous snapshot');
  assert.equal((await feeds.status())[0].blankRunsInARow, 1);
  spent = 14.8;
  assert.equal((await feeds.pull('injuries')).reason, 'DAILY_BUDGET_REACHED');
});

test('ESPN injury reports become injury notes; rows without a player or status are skipped', async () => {
  const { espnInjuryNotes, espnInjuries } = await import('../src/context/espn-injuries.js');
  const body = { injuries: [{ displayName: 'Chicago Bears', injuries: [
    { status: 'Out', date: '2030-10-04T15:50Z', shortComment: 'Williams is out Sunday.',
      athlete: { displayName: 'Caleb Williams', position: { abbreviation: 'QB' }, team: { abbreviation: 'CHI' }, links: [{ href: 'https://www.espn.com/x' }] },
      details: { type: 'Hamstring', returnDate: '2030-10-11' } },
    { status: 'Out', athlete: {} }] }] };
  const notes = espnInjuryNotes(body, 'NFL');
  assert.deepEqual(notes.map((note) => [note.player, note.team, note.teamAbbreviation, note.status, note.injury]),
    [['Caleb Williams', 'Chicago Bears', 'CHI', 'Out', 'Hamstring']]);
  assert.equal(injuryFor(line, notes)?.status, 'Out', 'matches a board line like the old feed did');
  let calls = 0;
  const feed = espnInjuries(async () => { calls++; return Response.json(body); }, 60_000, () => 0);
  assert.equal((await feed.items()).length, 5, 'one player per league asked (five leagues)');
  await feed.items(); assert.equal(calls, 5, 'kept for the cache window');
});
