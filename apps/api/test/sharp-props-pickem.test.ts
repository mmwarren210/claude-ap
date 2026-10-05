import assert from 'node:assert/strict';
import test from 'node:test';
import { fairPrices, isPickemRow, pickemLines } from '../src/context/sharp-props.js';

const row = (book: string, side: 'over' | 'under', extra: Record<string, unknown> = {}) => ({ sportsbook: book, league: 'nfl',
  market_type: 'player_receiving_yards', selection_type: side, line: 54.5, odds_probability: 0.5781, odds_american: -137,
  player_name: 'Drake London', event_start_time: '2030-10-06T17:00Z', home_team: 'New Orleans Saints', away_team: 'Atlanta Falcons',
  event_id: 'nfl_falcons_saints', is_pickem: book.startsWith('prizepicks'), timestamp: '2030-10-06T12:00:00Z', ...extra });

test('SharpAPI PrizePicks rows become lines, never prices', () => {
  const rows = [row('prizepicks', 'over'), row('prizepicks', 'under'), row('draftkings', 'over', { odds_probability: 0.55 }),
    row('draftkings', 'under', { odds_probability: 0.5 })];
  assert.equal(isPickemRow(rows[0]), true);
  assert.equal(isPickemRow(rows[2]), false);
  const lines = pickemLines(rows);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0]!.book, lines[0]!.market, lines[0]!.line, lines[0]!.sides, lines[0]!.american],
    ['prizepicks', 'player_reception_yds', 54.5, ['LESS', 'MORE'], -137]);
  assert.deepEqual(fairPrices(rows.filter((item) => !isPickemRow(item))).map((price) => price.book), ['draftkings']);
});
