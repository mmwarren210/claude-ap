import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import type { GameLine, MarketOdds } from '../src/context/feeds.js';
import { gameScriptFor, scriptEligible, ShadowRecord } from '../src/shadow-record.js';

const start = '2030-10-04T20:25:00.000Z';
const line = fixtureLine({ id: 'pp:1', sport: 'NFL', league: 'NFL', market: 'player_rush_yds', threshold: 70.5, team: 'Raiders',
  opponent: 'Chiefs', eventStartTime: start, playerId: 'rb' });
const game = (market: GameLine['market'], lineValue: number | null, homeFair: number | null): GameLine => ({ league: 'NFL',
  home: 'Las Vegas Raiders', away: 'Kansas City Chiefs', startTime: start, market, line: lineValue, homePrice: null,
  awayPrice: null, homeFair, awayFair: homeFair === null ? null : 1 - homeFair, sourceUrl: null });
const games = [game('moneyline', null, 0.33), game('spread', 7.5, 0.5), game('total', 48, null)];

test('game script: the player team margin, total and win chance from Pinnacle, with the markets as a check', () => {
  const markets: MarketOdds[] = [
    { platform: 'kalshi', eventTitle: 'Kansas City at Las Vegas', question: 'Kansas City at Las Vegas — Las Vegas',
      outcomes: [{ name: 'Yes', probability: 32 }, { name: 'No', probability: 68 }], volume24h: null, closeTime: start, url: null },
    { platform: 'kalshi', eventTitle: 'Chiefs vs. Raiders', question: 'Chiefs vs. Raiders',
      outcomes: [{ name: 'Chiefs', probability: 66 }, { name: 'Raiders', probability: 34 }], volume24h: null, closeTime: start, url: null },
    { platform: 'kalshi', eventTitle: 'Chiefs vs. Raiders', question: 'Spread: Chiefs (-7.5)',
      outcomes: [{ name: 'Chiefs', probability: 50 }, { name: 'Raiders', probability: 50 }], volume24h: null, closeTime: start, url: null },
  ];
  assert.deepEqual(gameScriptFor(line, games, markets), { teamMargin: -7.5, total: 48, teamWin: 0.33, marketsWin: 0.33, agree: true },
    'Raiders (home) are 7.5-point underdogs; markets name teams by city or by nickname; spreads are not win markets');
  assert.equal(gameScriptFor({ ...line, team: 'Jets', opponent: 'Bills' }, games, markets), null, 'no Pinnacle game');
  assert.equal(scriptEligible(line), true);
  assert.equal(scriptEligible({ ...line, sport: 'MLB', market: 'batter_hits' }), false);
});

test('shadow record: saved once before the game, graded from box scores, split by whether the script backs the side', async () => {
  let now = new Date('2030-10-04T12:00:00Z');
  const boxScores = { results: async () => ({ waiting: [], unsupported: [], facts: [{ eventId: line.eventId, playerId: 'rb',
    market: line.market, status: 'FINAL', actual: 52 }] }) };
  const shadow = new ShadowRecord(null, boxScores as never, () => now);
  const script = { teamMargin: -7.5, total: 48, teamWin: 0.33, marketsWin: null, agree: null };
  assert.equal(await shadow.record([{ kind: 'script', line, side: 'LESS', strength: 86, script },
    { kind: 'books', line, side: 'LESS', strength: 0.58 }, { kind: 'books', line, side: 'LESS', strength: 0.6 }]), 2,
    'the second Books entry for the same line is a repeat');
  assert.equal(await shadow.grade(), 0, 'game not over');
  now = new Date('2030-10-05T03:00:00Z');
  assert.equal(await shadow.record([{ kind: 'book:hardrock', line, side: 'LESS', strength: 88 }]), 0, 'started games are not saved');
  assert.equal(await shadow.grade(), 2);
  const status = await shadow.status() as unknown as Record<string, { picks: number; graded: number; wins: number; hitRate: number | null }> &
    { scriptSplit: Record<string, { graded: number; wins: number }> };
  assert.deepEqual(status.books, { picks: 1, graded: 1, wins: 1, hitRate: 1 });
  assert.equal(status.scriptSplit.backs.wins, 1, 'a 7.5-point underdog backs LESS on rushing yards');
});
