import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameLine, MarketOdds } from '../src/context/feeds.js';
import { marketPicks, platformFee } from '../src/market-picks.js';

const now = new Date('2030-10-04T15:00:00Z'), start = '2030-10-04T20:25:00Z';
const game = (market: GameLine['market'], line: number | null, homeFair: number | null): GameLine => ({ league: 'NFL',
  home: 'Las Vegas Raiders', away: 'Kansas City Chiefs', startTime: start, market, line, homePrice: null, awayPrice: null,
  homeFair, awayFair: homeFair === null ? null : 1 - homeFair, sourceUrl: null });
const market = (platform: MarketOdds['platform'], question: string, outcomes: [string, number][], eventTitle = 'Chiefs vs. Raiders'): MarketOdds =>
  ({ platform, eventTitle, question, outcomes: outcomes.map(([name, probability]) => ({ name, probability })), volume24h: 1000,
    closeTime: start, url: null });
const games = [game('moneyline', null, 0.36), game('spread', 4.5, 0.53), game('total', 48, null)];

test('market picks: winner and spread sides cheaper than Pinnacle after the fee, named by team or by question; nothing else', () => {
  const named = marketPicks('kalshi', [
    market('kalshi', 'Chiefs vs. Raiders', [['Chiefs', 67], ['Raiders', 33]]),
    market('kalshi', 'Spread: Chiefs (-4.5)', [['Chiefs', 50], ['Raiders', 50]]),
    market('kalshi', 'Spread: Chiefs (-3.5)', [['Chiefs', 55], ['Raiders', 45]]),
    market('kalshi', 'Chiefs vs. Raiders: 1H Moneyline', [['Chiefs', 90], ['Raiders', 10]]),
    market('kalshi', '1H Spread: Chiefs (-2.5)', [['Chiefs', 20], ['Raiders', 80]]),
    market('kalshi', 'Chiefs vs. Raiders: O/U 48.5', [['Over', 30], ['Under', 70]]),
  ], games, now, 0.01);
  assert.deepEqual(named.map((pick) => [pick.kind, pick.side, pick.price, pick.fair, pick.edge]),
    [['WINNER', 'Raiders to win', 0.33, 0.36, 0.01], ['SPREAD', 'Raiders +4.5', 0.5, 0.53, 0.01]],
    'the -3.5 spread has no Pinnacle number; half-game and total markets never show');
  // Kalshi: "— Las Vegas" Yes at 33c costs 35c with the fee, so a 3-point gap is 1 point: below the 2-point bar.
  const kalshi = [market('kalshi', 'KC Chiefs vs LV Raiders — Las Vegas', [['Yes', 33], ['No', 67]], 'KC Chiefs vs LV Raiders')];
  assert.equal(platformFee('kalshi', 0.33), 0.02);
  assert.deepEqual(marketPicks('kalshi', kalshi, games, now), []);
  assert.equal(marketPicks('kalshi', kalshi, games, now, 0.01)[0]?.side, 'Las Vegas to win');
  assert.deepEqual(marketPicks('kalshi', [market('kalshi', 'Chiefs vs. Raiders', [['Chiefs', 65], ['Raiders', 35]])],
    games, now, 0.01), [], 'priced at or above Pinnacle: no pick');
  assert.deepEqual(marketPicks('kalshi', [market('kalshi', 'Chiefs vs. Raiders', [['Chiefs', 67], ['Raiders', 33]])],
    games, new Date('2030-10-04T21:00:00Z'), 0.01), [], 'started games drop');
});

test('market picks: a name that fits both teams, a long shot, or an edge too big to be real is left out', async () => {
  const { marketPicks } = await import('../src/market-picks.js');
  const start = '2030-10-05T23:00:00Z', now = new Date('2030-10-05T12:00:00Z');
  const games = [{ league: 'NHL', home: 'New York Rangers', away: 'New York Islanders', startTime: start, market: 'moneyline' as const,
    line: null, homePrice: null, awayPrice: null, homeFair: 0.55, awayFair: 0.45, sourceUrl: null },
  { league: 'MLB', home: 'San Diego Padres', away: 'Milwaukee Brewers', startTime: start, market: 'moneyline' as const,
    line: null, homePrice: null, awayPrice: null, homeFair: 0.58, awayFair: 0.42, sourceUrl: null }];
  const market = (eventTitle: string, question: string, yes: number) => ({ platform: 'kalshi' as const, eventTitle, question,
    outcomes: [{ name: 'Yes', probability: yes }, { name: 'No', probability: 100 - yes }], closeTime: start, volume24h: null, url: null });
  const picks = marketPicks('kalshi', [market('New York Islanders vs New York Rangers', 'Islanders vs Rangers — New York', 40),
    market('Brewers vs Padres', 'Brewers vs Padres — San Diego', 12)], games as never, now);
  assert.deepEqual(picks, [], '"New York" fits both teams; the Padres at 12¢ against a 58% fair chance is a mismatch');
});
