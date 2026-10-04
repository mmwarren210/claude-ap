import assert from 'node:assert/strict';
import test from 'node:test';
import { propLineSchema } from '@crowniq/contracts';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { ContextFeeds, injuryReports, kalshiMarkets, pinnacleLines, polymarketMarkets } from '../src/context/feeds.js';
import type { ApifyClient } from '../src/scrapers/apify-client.js';
import type { DailySpendBudget } from '../src/scrapers/spend-budget.js';
import { gameLinesFor, injuryFor, marketsFor } from '../src/context/match.js';

const line = propLineSchema.parse({ ...fixtureLine(), sport: 'NFL', league: 'NFL', playerName: 'Caleb Williams',
  team: 'Chicago Bears', opponent: 'New York Jets', homeTeam: 'Chicago Bears', awayTeam: 'New York Jets',
  eventStartTime: '2030-10-04T17:00:00.000Z' });
const injury = injuryReports.read({ type: 'injury', league: 'nfl', team: 'Chicago Bears', teamAbbreviation: 'CHI',
  player: 'Caleb Williams', positionAbbreviation: 'QB', status: 'Out', injuryType: 'Hamstring', returnDate: '2030-10-11',
  shortComment: 'Williams is out Sunday.', reportedAt: '2030-10-04T15:50Z', playerUrl: 'https://www.espn.com/x' })!;
const pinnacle = pinnacleLines.read({ league: 'nfl', homeTeam: 'Chicago Bears', awayTeam: 'New York Jets',
  startTime: '2030-10-04T17:00Z', market: 'moneyline', line: null, homePrice: -183, awayPrice: 164,
  homeFairProbability: 0.63, awayFairProbability: 0.37, espnLink: 'https://www.espn.com/nfl/game' })!;
const kalshi = kalshiMarkets.read({ status: 'open', question: 'NY Jets vs CHI Bears — Chicago', eventTitle: 'NY Jets vs CHI Bears',
  outcomes: [{ name: 'Yes', probability: 64 }, { name: 'No', probability: 36 }], volume24h: 1000,
  closeTime: '2030-10-04T21:00:00Z', url: 'https://kalshi.com/x' })!;
const unrelated = polymarketMarkets.read({ status: 'open', question: 'Bitcoin above 100k?', eventTitle: 'Bitcoin',
  outcomes: [{ name: 'Yes', probability: 40 }], closeTime: '2030-10-04T21:00:00Z' })!;

test('context feeds read each scraper row and match it to a board line conservatively', () => {
  assert.deepEqual([injury.league, injury.status, injury.injury], ['NFL', 'Out', 'Hamstring']);
  assert.equal(injuryFor(line, [injury])?.player, 'Caleb Williams');
  assert.equal(injuryFor({ ...line, team: 'Detroit Lions' }, [injury]), null, 'another team with that name is not matched');
  const games = gameLinesFor(line, [pinnacle]);
  assert.equal(games.length, 1);
  assert.equal(gameLinesFor({ ...line, eventStartTime: '2030-10-11T17:00:00.000Z' }, [pinnacle]).length, 0);
  assert.deepEqual(marketsFor(line, [kalshi, unrelated], games).map((item) => item.platform), ['kalshi']);
  assert.equal(pinnacleLines.read({ ...pinnacle, market: 'alternate-total' }), null);
  assert.equal(kalshiMarkets.read({ status: 'closed', question: 'x', outcomes: [] }), null);
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
