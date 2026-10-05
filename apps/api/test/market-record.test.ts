import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarketPick } from '../src/market-picks.js';
import { gradeMarket, MarketRecord, parseScoreboard } from '../src/market-record.js';

const pick = (overrides: Partial<MarketPick> = {}): MarketPick => ({ id: 'kalshi:NFL:x:winner', platform: 'kalshi', league: 'NFL',
  game: 'Kansas City Chiefs @ Las Vegas Raiders', startTime: '2030-10-04T20:25:00Z', kind: 'WINNER', side: 'Las Vegas to win',
  question: 'q', home: 'Las Vegas Raiders', away: 'Kansas City Chiefs', team: 'home', handicap: null, price: 0.33, cost: 0.35,
  fair: 0.37, edge: 0.02, volume24h: null, url: null, ...overrides });
const scoreboard = { events: [{ date: '2030-10-04T20:25Z', status: { type: { completed: true } }, competitions: [{ competitors: [
  { homeAway: 'home', score: '20', team: { displayName: 'Las Vegas Raiders', name: 'Raiders', abbreviation: 'LV' } },
  { homeAway: 'away', score: '24', team: { displayName: 'Kansas City Chiefs', name: 'Chiefs', abbreviation: 'KC' } }] }] }] };

test('market picks grade on the winner, or the spread with its handicap', () => {
  assert.equal(gradeMarket({ kind: 'WINNER', team: 'home', handicap: null }, { home: 20, away: 24 }), 'LOSS');
  assert.equal(gradeMarket({ kind: 'SPREAD', team: 'home', handicap: 4.5 }, { home: 20, away: 24 }), 'WIN');
  assert.equal(gradeMarket({ kind: 'SPREAD', team: 'away', handicap: -4 }, { home: 20, away: 24 }), 'PUSH');
  assert.deepEqual(parseScoreboard(scoreboard)[0], { start: Date.parse('2030-10-04T20:25Z'), home: ['Las Vegas Raiders', 'Raiders', 'LV'],
    away: ['Kansas City Chiefs', 'Chiefs', 'KC'], homeScore: 20, awayScore: 24, final: true });
});

test('the market record saves picks once before the game, grades from ESPN, scores per dollar and voids what never finishes', async () => {
  let now = new Date('2030-10-04T12:00:00Z');
  const urls: string[] = [];
  const fetchFn = (async (url: string) => { urls.push(url); return new Response(JSON.stringify(url.includes('football/nfl') ? scoreboard : { events: [] })); }) as typeof fetch;
  const record = new MarketRecord(null, fetchFn, () => now);
  assert.equal(await record.record([pick(), pick({ id: 'spread', kind: 'SPREAD', side: 'Raiders +4.5', handicap: 4.5, cost: 0.48 }),
    pick({ id: 'tennis', league: 'ATP', home: 'A Player', away: 'B Player' }), pick()]), 3);
  now = new Date('2030-10-05T03:00:00Z');
  assert.equal(await record.grade(), 2, 'tennis waits');
  assert.ok(urls[0]!.includes('dates=20301004'), 'the Eastern date of the game');
  assert.deepEqual(await record.status('kalshi'), { picks: 3, graded: 2, wins: 1, losses: 1, pushes: 0, hitRate: 0.5,
    perDollar: Math.round(((1 - 0.48) - 0.35) / 2 * 1000) / 1000 });
  now = new Date('2030-10-09T03:00:00Z');
  assert.equal(await record.grade(), 1, 'no result after four days: void');
});
