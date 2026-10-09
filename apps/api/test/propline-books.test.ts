import assert from 'node:assert/strict';
import test from 'node:test';
import { proplineRows, sharpLeagueFor } from '../src/context/propline-books.js';
import { fairPrices, gamePrices, normalizeRow } from '../src/context/sharp-props.js';

// Synthetic values in PropLine's odds shape (checked live 2026-10-08).
const event = { id: '32678', home_team: 'Dallas Cowboys', away_team: 'Tampa Bay Buccaneers', commence_time: '2030-01-06T00:15:00Z',
  bookmakers: [
    { key: 'draftkings', markets: [
      { key: 'player_pass_yds', outcomes: [{ name: 'Over', description: 'Dak Prescott', price: -115, point: 245.5 },
        { name: 'Under', description: 'Dak Prescott', price: -105, point: 245.5 }] },
      { key: 'player_anytime_td', outcomes: [{ name: 'Yes', description: 'CeeDee Lamb', price: 120, point: null },
        { name: 'No', description: 'CeeDee Lamb', price: -150, point: null }] },
      { key: 'player_weird_stat', outcomes: [{ name: 'Over', description: 'X', price: 100, point: 1.5 }] },
      { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 47.5 }, { name: 'Under', price: -110, point: 47.5 }] }] },
    { key: 'hardrock', markets: [{ key: 'player_reception_yds', outcomes: [{ name: 'Over', description: 'CeeDee Lamb', price: -110, point: 75.5 },
      { name: 'Under', description: 'CeeDee Lamb', price: -110, point: 75.5 }] }] }] };

test('PropLine sportsbook odds become the feed rows Edge, the book tabs and line shopping already read', () => {
  const unmapped = new Map<string, number>();
  const { rows, gameRows } = proplineRows(event, 'football_nfl', unmapped);
  const prices = fairPrices(rows.map(normalizeRow));
  const view = prices.map((price) => [price.book, price.market, price.player, price.line, Math.round(price.fairOver * 1000) / 1000]).sort();
  assert.deepEqual(view, [
    ['draftkings', 'passing_yards', 'Dak Prescott', 245.5, 0.511],
    ['hardrock', 'player_reception_yds', 'CeeDee Lamb', 75.5, 0.5],
  ].sort());
  // Yes/no scorer markets arrive as the feed's anytime-scorer rows (priced by its own scorer step with the game total).
  const scorer = rows.map(normalizeRow).filter((row) => (row as { market_type: string }).market_type === 'anytime_touchdown_scorer')
    .map((row) => { const item = row as { selection_type: string; line: number }; return [item.selection_type, item.line]; });
  assert.deepEqual(scorer, [['over', 0.5], ['under', 0.5]]);
  assert.deepEqual([...unmapped], [['NFL:player_weird_stat', 1]], 'an unknown market is counted, never guessed');
  const totals = gamePrices(gameRows);
  assert.deepEqual(totals.map((game) => [game.market, game.line, game.side]), [['total', 47.5, 'over'], ['total', 47.5, 'under']]);
  assert.equal(sharpLeagueFor('soccer_epl'), 'england_-_premier_league');
  assert.equal(sharpLeagueFor('cricket'), null);
});
