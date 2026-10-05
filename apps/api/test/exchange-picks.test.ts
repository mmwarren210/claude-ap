import assert from 'node:assert/strict';
import test from 'node:test';
import type { PropLine } from '@crowniq/contracts';
import type { FairPrice, GamePrice, OverOnlyPrice } from '../src/context/sharp-props.js';
import { bookFair, consensusGameLines, exchangeGamePicks, exchangePropPicks, playerStarts, propLines } from '../src/exchange-picks.js';
import type { HistoryRead } from '../src/history-read.js';
import { gradeMarket } from '../src/market-record.js';
import { sameTeam } from '../src/team-match.js';

const now = new Date('2030-10-05T12:00:00Z'), start = '2030-10-05T23:00Z';
const g = (book: string, market: GamePrice['market'], side: GamePrice['side'], probability: number, line: number | null = null,
  names: [string, string] = ['Cleveland Guardians', 'Chicago White Sox']): GamePrice =>
  ({ book, league: 'mlb', sport: 'baseball', eventId: `${book}-e1`, home: names[0], away: names[1], startTime: start, market, line, side,
    probability, american: null });

test('team names match across sources', () => {
  assert.ok(sameTeam('Chicago WS', 'Chicago White Sox'));
  assert.ok(sameTeam('NO Saints', 'New Orleans Saints'));
  assert.ok(sameTeam('Cleveland Guardians', 'Guardians'));
  assert.ok(!sameTeam('Chicago Cubs', 'Chicago White Sox'));
  assert.ok(!sameTeam('Manchester United', 'Leeds United'), 'a shared generic word is not a match');
});

test('Kalshi game picks: priced below the books’ no-vig chance at the same number, every kind', () => {
  const games = [
    g('draftkings', 'moneyline', 'home', 0.6), g('draftkings', 'moneyline', 'away', 0.44),
    g('hardrock', 'moneyline', 'home', 0.59), g('hardrock', 'moneyline', 'away', 0.45),
    g('draftkings', 'total', 'over', 0.55, 8.5), g('draftkings', 'total', 'under', 0.5, 8.5),
    g('draftkings', 'spread', 'home', 0.52, -1.5), g('draftkings', 'spread', 'away', 0.52, 1.5),
    // Kalshi names the away team differently and has its own event id.
    g('kalshi', 'moneyline', 'home', 0.5, null, ['Cleveland Guardians', 'Chicago WS']),
    g('kalshi', 'moneyline', 'away', 0.5, null, ['Cleveland Guardians', 'Chicago WS']),
    g('kalshi', 'total', 'over', 0.45, 8.5), g('kalshi', 'spread', 'home', 0.49, -1.5)];
  assert.equal(bookFair(games, g('kalshi', 'moneyline', 'home', 0.5, null, ['Cleveland Guardians', 'Chicago WS'])), 0.5721, '0.6/1.04 and 0.59/1.04, averaged');
  const picks = exchangeGamePicks('kalshi', games, now);
  const winner = picks.find((pick) => pick.kind === 'WINNER')!, total = picks.find((pick) => pick.kind === 'TOTAL')!;
  assert.equal(winner.side, 'Cleveland Guardians to win');
  assert.equal(winner.cost, 0.52, '50¢ plus Kalshi’s 2¢ fee');
  assert.equal(winner.edge, 0.0521);
  assert.deepEqual([total.side, total.total], ['Over 8.5 total', { side: 'over', line: 8.5 }]);
  assert.ok(!picks.some((pick) => pick.kind === 'SPREAD'), '49¢ + fee against a 50% fair: no edge');
  assert.equal(gradeMarket(total, { home: 5, away: 4 }), 'WIN');
  assert.equal(gradeMarket({ ...total, total: { side: 'under', line: 8.5 } }, { home: 5, away: 4 }), 'LOSS');
  const lines = consensusGameLines(games);
  assert.deepEqual(lines.map((line) => [line.market, line.line, line.homeFair]), [['moneyline', null, 0.5721], ['spread', -1.5, 0.5]],
    'books only, totals left out, one line per game and number');
});

test('Kalshi props: the books’ fair chance first, else History by a wide margin; History against it drops the prop', () => {
  const offer = (player: string, line: number, price: number): OverOnlyPrice => ({ book: 'kalshi', sport: 'NHL', player, market: 'points',
    line, price, american: null, startTime: start, home: 'Boston Bruins', away: 'Buffalo Sabres' });
  const offers = [offer('Book Backed', 0.5, 0.45), offer('History Backed', 0.5, 0.5), offer('History Against', 0.5, 0.4), offer('Nothing', 0.5, 0.5)];
  const prices: FairPrice[] = [{ book: 'draftkings', sport: 'NHL', player: 'Book Backed', market: 'points', line: 0.5, fairOver: 0.52,
    overAmerican: null, underAmerican: null, startTime: start, home: null, away: null },
  { book: 'draftkings', sport: 'NHL', player: 'History Against', market: 'points', line: 0.5, fairOver: 0.6,
    overAmerican: null, underAmerican: null, startTime: start, home: null, away: null }];
  // The other players' games are known from a different stat the books price; Kalshi's close time is days later.
  const other = (player: string): FairPrice => ({ ...prices[0]!, player, market: 'shots_on_goal', line: 2.5 });
  const lines = propLines(offers.map((item) => ({ ...item, startTime: '2030-10-08T23:00Z' })), [] as PropLine[], now,
    playerStarts([...prices, other('History Backed'), other('Nothing')], []));
  assert.equal(lines.size, 4);
  assert.ok([...lines.values()].every((line) => line.eventStartTime === '2030-10-05T23:00:00.000Z'), 'the real game time');
  const read = (direction: HistoryRead['direction'], score: number): HistoryRead => ({ direction, score, over: 7, under: 3, games: 10,
    average: 1, books: null, text: 'Over in 7 of last 10', source: 'ESPN' });
  const byPlayer = new Map([...lines].map(([item, line]) => [item.player, line]));
  const history = new Map([[byPlayer.get('History Backed')!.id, read('MORE', 66)], [byPlayer.get('History Against')!.id, read('LESS', 64)]]);
  const picks = exchangePropPicks([...lines.keys()], prices, lines, history, now);
  assert.deepEqual(picks.map((pick) => [pick.side.split(' over')[0], pick.by, pick.edge]).sort(),
    [['Book Backed', 'MARKET', 0.05], ['History Backed', 'HISTORY', 0.14]]);
});
