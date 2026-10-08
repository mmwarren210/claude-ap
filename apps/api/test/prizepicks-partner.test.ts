import assert from 'node:assert/strict';
import test from 'node:test';
import { prizePicksPartner, prizePicksPartnerRows } from '../src/scrapers/prizepicks-partner.js';

const now = new Date('2026-10-08T20:00:00Z');
const projection = (id: string, overrides: Record<string, unknown> = {}) => ({ type: 'projection', id, attributes: {
  line_score: 1.5, stat_type: 'FG Made', stat_display_name: 'FG Made', odds_type: 'standard', status: 'pre_game', is_live: false,
  in_game: false, event_type: 'player', allowed_wager_types: null, game_id: 'NFL_game_x', start_time: '2026-10-09T20:15:00.000-04:00',
  ...overrides }, relationships: { new_player: { data: { type: 'new_player', id: '211166' } }, league: { data: { type: 'league', id: '9' } },
  game: { data: { type: 'game', id: '500' } } } });
const feed = {
  data: [projection('1'), projection('2', { odds_type: 'goblin', line_score: 0.5 }), projection('3', { status: 'in_progress' })],
  included: [
    { type: 'new_player', id: '211166', attributes: { combo: false, display_name: 'Brandon Aubrey', image_url: 'https://static.prizepicks.com/images/players/x.webp',
      league: 'NFL', team: 'DAL', team_name: 'Cowboys' } },
    { type: 'league', id: '9', attributes: { name: 'NFL' } },
    { type: 'game', id: '500', attributes: { external_game_id: 'NFL_game_x', start_time: '2026-10-09T20:15:00.000-04:00',
      metadata: { game_info: { teams: { away: { abbreviation: 'TB' }, home: { abbreviation: 'DAL' } } } } },
    relationships: { away_team_data: { data: { type: 'team', id: '1' } }, home_team_data: { data: { type: 'team', id: '2' } } } },
    { type: 'team', id: '1', attributes: { name: 'Buccaneers' } }, { type: 'team', id: '2', attributes: { name: 'Cowboys' } },
  ],
};

test("PrizePicks' partner feed becomes board lines with league, teams, opponent and Goblin tier", async () => {
  const source = prizePicksPartner(async () => new Response(JSON.stringify(feed)));
  const { rows, complete } = await source.run!();
  assert.equal(complete, true);
  const [regular, goblin, live] = rows.map((row) => source.read(row, now));
  assert.ok('line' in regular && 'line' in goblin);
  assert.deepEqual({ app: regular.line.app, id: regular.line.appLineId, league: regular.line.league, player: regular.line.player,
    team: regular.line.team, opponent: regular.line.opponent, stat: regular.line.stat, line: regular.line.line, tier: regular.line.tier,
    gameId: regular.line.gameId, home: regular.line.home, away: regular.line.away },
  { app: 'prizepicks', id: '1', league: 'NFL', player: 'Brandon Aubrey', team: 'DAL', opponent: 'TB', stat: 'FG Made', line: 1.5,
    tier: 'REGULAR', gameId: 'NFL_game_x', home: { abbreviation: 'DAL', name: 'Cowboys' }, away: { abbreviation: 'TB', name: 'Buccaneers' } });
  assert.equal(goblin.line.tier, 'GOBLIN');
  assert.deepEqual(goblin.line.directions, ['MORE']);
  assert.deepEqual(live, { skip: 'LIVE_OR_STARTED' });
});

test('a PrizePicks error or an empty feed never takes lines down', async () => {
  await assert.rejects(() => prizePicksPartner(async () => new Response('{}', { status: 403 })).run!(), /PRIZEPICKS_PARTNER_HTTP_403/);
  assert.deepEqual(await prizePicksPartner(async () => new Response('{"data":[]}')).run!(), { rows: [], complete: false });
  assert.deepEqual(prizePicksPartnerRows(null), []);
});
