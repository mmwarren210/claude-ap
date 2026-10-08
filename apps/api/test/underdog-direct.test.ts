import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { underdogDirect, underdogRows } from '../src/scrapers/underdog-direct.js';

const feed = JSON.parse(readFileSync(new URL('./fixtures/underdog-v1.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const now = new Date('2026-10-08T20:00:00Z');

test("Underdog's own feed becomes board lines with teams, opponent and each side's payout", async () => {
  const source = underdogDirect(async () => new Response(JSON.stringify(feed)));
  const { rows, complete } = await source.run!();
  assert.equal(complete, true);
  const result = source.read(rows[0], now);
  assert.ok('line' in result);
  assert.deepEqual({ app: result.line.app, league: result.line.league, player: result.line.player, team: result.line.team,
    opponent: result.line.opponent, stat: result.line.stat, line: result.line.line, tier: result.line.tier,
    directions: result.line.directions, multipliers: result.line.multipliers, startTime: result.line.startTime },
  { app: 'underdog', league: 'NFL', player: 'Javonte Williams', team: 'DAL', opponent: 'TB', stat: 'Anytime TD', line: 0.5,
    tier: 'REGULAR', directions: ['MORE', 'LESS'], multipliers: { MORE: 0.75, LESS: 1.29 }, startTime: '2026-10-09T00:15:00.000Z' });
  assert.equal(result.line.teamName, 'Dallas Cowboys');
});

test('a side Underdog has taken down is not offered, and a fight uses the other fighter as the opponent', () => {
  const lines = feed.over_under_lines as Record<string, unknown>[];
  const closed = { ...feed, over_under_lines: [{ ...lines[0], options: [{ choice: 'higher', payout_multiplier: '0.75', status: 'suspended' },
    { choice: 'lower', payout_multiplier: '1.29', status: 'active' }] }] };
  const [row] = underdogRows(closed);
  assert.equal(row.higher_payout_multiplier, null);
  const appearances = feed.appearances as Record<string, unknown>[];
  const solo = { ...feed, appearances: [{ ...appearances[0], match_type: 'SoloGame', match_id: 9 }],
    solo_games: [{ id: 9, home_player_name: 'Javonte Williams', away_player_name: 'Other Fighter', scheduled_at: '2026-10-10T00:00:00Z',
      sport_id: 'MMA', status: 'scheduled' }] };
  const [fight] = underdogRows(solo);
  assert.deepEqual([fight.player_team, fight.home_team, fight.away_team, fight.league], ['Javonte Williams', 'Javonte Williams', 'Other Fighter', 'MMA']);
});

test('an Underdog error or an empty feed never takes lines down', async () => {
  await assert.rejects(() => underdogDirect(async () => new Response('{}', { status: 426 })).run!(), /UNDERDOG_HTTP_426/);
  assert.deepEqual(await underdogDirect(async () => new Response('{}')).run!(), { rows: [], complete: false });
});
