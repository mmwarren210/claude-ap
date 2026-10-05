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

test('market picks: winner and spread sides cheaper than Pinnacle, after fees; nothing else', () => {
  const polymarket = marketPicks('polymarket', [
    market('polymarket', 'Chiefs vs. Raiders', [['Chiefs', 67], ['Raiders', 33]]),
    market('polymarket', 'Spread: Chiefs (-4.5)', [['Chiefs', 50], ['Raiders', 50]]),
    market('polymarket', 'Spread: Chiefs (-3.5)', [['Chiefs', 55], ['Raiders', 45]]),
    market('polymarket', 'Chiefs vs. Raiders: 1H Moneyline', [['Chiefs', 90], ['Raiders', 10]]),
    market('polymarket', '1H Spread: Chiefs (-2.5)', [['Chiefs', 20], ['Raiders', 80]]),
    market('polymarket', 'Chiefs vs. Raiders: O/U 48.5', [['Over', 30], ['Under', 70]]),
  ], games, now);
  assert.deepEqual(polymarket.map((pick) => [pick.kind, pick.side, pick.price, pick.fair, pick.edge]),
    [['WINNER', 'Raiders to win', 0.33, 0.36, 0.03], ['SPREAD', 'Raiders +4.5', 0.5, 0.53, 0.03]],
    'the -3.5 spread has no Pinnacle number; half-game and total markets never show');
  // Kalshi: "— Las Vegas" Yes at 33c costs 35c with the fee, so a 3-point gap is 1 point: below the 2-point bar.
  const kalshi = [market('kalshi', 'KC Chiefs vs LV Raiders — Las Vegas', [['Yes', 33], ['No', 67]], 'KC Chiefs vs LV Raiders')];
  assert.equal(platformFee('kalshi', 0.33), 0.02);
  assert.deepEqual(marketPicks('kalshi', kalshi, games, now), []);
  assert.equal(marketPicks('kalshi', kalshi, games, now, 0.01)[0]?.side, 'Las Vegas to win');
  assert.deepEqual(marketPicks('polymarket', [market('polymarket', 'Chiefs vs. Raiders', [['Chiefs', 65], ['Raiders', 35]])],
    games, now), [], 'priced at or above Pinnacle: no pick');
  assert.deepEqual(marketPicks('polymarket', [market('polymarket', 'Chiefs vs. Raiders', [['Chiefs', 67], ['Raiders', 33]])],
    games, new Date('2030-10-04T21:00:00Z')), [], 'started games drop');
});
