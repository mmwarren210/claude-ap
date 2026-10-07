import assert from 'node:assert/strict';
import test from 'node:test';
import { fairPrices, scorerFairPrices, shotsAudit, tennisTotalPrices } from '../src/context/sharp-props.js';
import type { GamePrice } from '../src/context/sharp-props.js';
import { canonicalMarket } from '../src/edge/market-map.js';
import { lineMarket, marketKey, segmentBase } from '../src/scrapers/markets.js';

// Step 4: markets the books price that Edge didn't read. Synthetic rows only.
const start = '2030-10-08T00:00:00Z';
const row = (extra: Record<string, unknown>) => ({ sportsbook: 'fanduel', league: 'nfl', event_id: 'g1', event_start_time: start,
  home_team: 'Home', away_team: 'Away', is_live: false, is_active: true, player_name: 'Test Receiver', ...extra });

test('4c: partial-game lines share one key across PrizePicks boards, Underdog/Pick6 labels and SharpAPI', () => {
  assert.equal(marketKey('NFL', '1H Rec Yards', 'underdog'), '1h_player_reception_yds');
  assert.equal(lineMarket({ league: 'NFL1H', stat: 'Rec Yards', marketKey: null, app: 'prizepicks' }), '1h_player_reception_yds');
  assert.deepEqual(segmentBase('NHL1P'), { sport: 'NHL', segment: '1P' });
  assert.equal(segmentBase('NFL'), null);
  assert.equal(canonicalMarket('NCAAFB', marketKey('NCAAFB', '1H Rush + Rec TD Scorer', 'pick6')), canonicalMarket('NCAAFB', '1h_anytime_tds'));
  const [price] = fairPrices([row({ market_type: '1st_half_player_receiving_yards', selection_type: 'over', line: 30.5, odds_probability: .52, odds_american: -110 }),
    row({ market_type: '1st_half_player_receiving_yards', selection_type: 'under', line: 30.5, odds_probability: .52, odds_american: -110 })]);
  assert.equal(price?.market, '1h_player_reception_yds', 'the segment stays in the key, never the full-game market');
  const [longest] = fairPrices([row({ market_type: 'player_longest_reception', selection_type: 'over', line: 21.5, odds_probability: .5 }),
    row({ market_type: 'player_longest_reception', selection_type: 'under', line: 21.5, odds_probability: .5 })]);
  assert.equal(longest?.market, 'player_reception_longest');
});

test('4a: anytime TD Yes prices de-vigged per game against expected rush + receiving TDs from the total', () => {
  // A 47.5 total priced 50/50 → 47.5 expected points → ~5 rush + rec TDs. 24 players; the book shades every Yes up by 30%.
  const rates = Array.from({ length: 24 }, (_, index) => .05 + .5 * ((index * 5) % 24) / 24);
  const scale = 47.5 * .105 / rates.reduce((a, b) => a + b, 0), fair = rates.map((rate) => 1 - Math.exp(-rate * scale));
  const rows = fair.map((p, index) => row({ market_type: 'anytime_touchdown_scorer', selection_type: 'other', line: null,
    player_name: `Player ${index}`, odds_probability: Math.min(.95, p * 1.3) }));
  const game = (side: 'over' | 'under'): GamePrice => ({ book: 'draftkings', league: 'nfl', sport: 'football', eventId: 'g1', home: 'Home',
    away: 'Away', startTime: start, market: 'total', line: 47.5, side, probability: .524, american: -110 });
  const prices = scorerFairPrices(rows, [game('over'), game('under')]);
  assert.equal(prices.length, 24);
  assert.deepEqual([prices[0]!.sport, prices[0]!.market, prices[0]!.line], ['NFL', 'anytime_tds', 0.5]);
  for (const [index, price] of prices.entries()) assert.ok(Math.abs(price.fairOver - fair[index]!) < .01, `player ${index}`);
  assert.equal(scorerFairPrices(rows.slice(0, 6), [game('over'), game('under')]).length, 0, 'an incomplete list is left out');
});

test('4d: tennis total games from the match total, for both players; 4e: NHL shots vs shots on goal compared before mapping', () => {
  const game = (side: 'over' | 'under', probability: number): GamePrice => ({ book: 'fanduel', league: 'atp', sport: 'tennis', eventId: 't1',
    home: 'Ana Player', away: 'Bea Player', startTime: start, market: 'total', line: 22.5, side, probability, american: -110 });
  const prices = tennisTotalPrices([game('over', .55), game('under', .5)]);
  assert.deepEqual(prices.map((price) => [price.player, price.market, price.line]), [['Ana Player', 'total_games', 22.5], ['Bea Player', 'total_games', 22.5]]);
  assert.equal(prices[0]!.fairOver, Math.round(.55 / 1.05 * 10_000) / 10_000);
  const nhl = (market: string, line: number, player = 'Skater A') => ({ sportsbook: 'fanduel', league: 'nhl', market_type: market, selection_type: 'over', line, player_name: player });
  const audit = shotsAudit([nhl('player_shots', 2.5), nhl('player_shots_on_goal', 2.5), nhl('player_shots', 3.5, 'Skater B'), nhl('player_shots_on_goal', 3.5, 'Skater B')]);
  assert.deepEqual([audit.players, audit.medianGap], [2, 0]);
});
