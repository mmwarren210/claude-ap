import assert from 'node:assert/strict';
import test from 'node:test';
import { EspnTennisHistory, LeaguepediaHistory, OpenDotaHistory, PlayerHistory, statFor, tennisMatches } from '../src/player-history.js';

const now = new Date('2030-10-05T12:00:00Z');
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const match = (date: string, a: string, b: string, aSets: number[], bSets: number[], detail = 'Final') => ({
  date, status: { type: { completed: true, detail, shortDetail: detail } },
  competitors: [{ athlete: { displayName: a }, linescores: aSets.map((value) => ({ value })) },
    { athlete: { displayName: b }, linescores: bSets.map((value) => ({ value })) }] });
const scoreboard = { events: [{ groupings: [
  { grouping: { displayName: "Men's Singles" }, competitions: [
    match('2030-10-01T10:00Z', 'Jaume Munar', 'Carlos Alcaraz', [4, 6, 3], [6, 3, 6]),
    match('2030-09-20T10:00Z', 'Jaume Munar', 'Ben Shelton', [6, 7], [3, 6]),
    match('2030-09-10T10:00Z', 'Jaume Munar', 'Retired Guy', [6, 1], [2, 0], 'Ret.')] },
  { grouping: { displayName: "Men's Doubles" }, competitions: [match('2030-10-01T10:00Z', 'A / B', 'C / D', [6, 6], [1, 1])] }] }] };

test('tennis: finished singles matches give games won, total games, sets and the first set; retirements are left out', () => {
  const matches = tennisMatches(scoreboard);
  assert.equal(matches.length, 2, 'doubles and the retirement are skipped');
  assert.deepEqual(matches[0].players[0].stats, { gamesWon: 13, gamesLost: 15, totalGames: 28, setsWon: 1, totalSets: 3,
    firstSetGamesWon: 4, firstSetGames: 10 });
  assert.equal(statFor('TENNIS', 'total_games_won', matches[0].players[0].stats), 13);
  assert.equal(statFor('TENNIS', 'total_games', matches[0].players[0].stats), 28);
  assert.equal(statFor('TENNIS', '1st_set_games_won', matches[0].players[0].stats), 4);
  assert.equal(statFor('TENNIS', 'aces', matches[0].players[0].stats), null, 'aces are not in set scores');
});

test('the history feeds Scout facts and the card game log, newest first, and keeps games in the archive', async () => {
  const appended: unknown[] = [];
  const archive = { append: async (_stream: string, rows: unknown[]) => { appended.push(...rows); return rows.length; } };
  const history = new PlayerHistory([new EspnTennisHistory(async () => json(scoreboard), () => now)], archive as never, () => now);
  await history.refresh();
  const facts = await history.factsFor({ sport: 'TENNIS', playerName: 'Jaume Munar', market: 'total_games_won', threshold: 12.5 });
  assert.deepEqual(facts, ['Last 2 matches (ESPN tennis scoreboards, newest first): 13, 13. Average 13.0.', 'Went over 12.5 in 2 of those 2.']);
  const log = await history.gameLog('TENNIS', 'TENNIS:munar', 'Jaume Munar', 'total_games_won');
  assert.deepEqual(log?.games.map((game) => [game.date, game.opponent, game.value]),
    [['2030-10-01', 'Carlos Alcaraz', 13], ['2030-09-20', 'Ben Shelton', 13]]);
  assert.equal(log?.source, 'FREE_PUBLIC_HISTORY');
  assert.equal(appended.length, 2);
  assert.deepEqual(await history.factsFor({ sport: 'TENNIS', playerName: 'Nobody Here', market: 'total_games', threshold: 20 }), []);
});

test('Dota from OpenDota: the pro player list, then their last tournament maps; facts are per map', async () => {
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input); urls.push(url);
    if (url.endsWith('/proPlayers')) return json([{ account_id: 111, name: 'Gakgos' }]);
    if (url.includes('/players/111/matches')) return json([
      { kills: 3, deaths: 5, assists: 12, last_hits: 40, start_time: 1917000000, leagueid: 15000 },
      { kills: 7, deaths: 2, assists: 9, last_hits: 55, start_time: 1916900000, leagueid: 15000 },
      { kills: 20, deaths: 1, assists: 1, last_hits: 300, start_time: 1916800000, leagueid: 0 }]);
    return new Response('missing', { status: 404 });
  };
  const history = new PlayerHistory([new OpenDotaHistory(fetchFn, () => now)], null, () => now);
  assert.deepEqual(await history.factsFor({ sport: 'DOTA', playerName: 'gakgos', market: 'maps_1_2_kills', threshold: 9.5 }),
    ['Last 2 maps (OpenDota pro matches, newest first): 3, 7. Average 5.0 per map.',
      'This line covers maps 1 and 2 together: about 10.0 at that average.']);
  assert.ok(urls.some((url) => url.includes('lobby_type=1')), 'tournament lobbies only; a game outside a league is dropped');
  assert.equal(await history.gameLog('DOTA', 'DOTA:g', 'Gakgos', 'maps_1_2_kills'), null, 'a two-map line has no single-row log');
});

test('League of Legends from Leaguepedia: a player’s last pro games by page or in-game name', async () => {
  let asked = '';
  const fetchFn: typeof fetch = async (input) => { asked = String(input); return json({ cargoquery: [
    { title: { Kills: '4', Deaths: '2', Assists: '6', CS: '310', Date: '2030-10-01 09:00:00', Team: 'FLY' } },
    { title: { Kills: '1', Deaths: '3', Assists: '2', CS: '280', Date: '2030-09-30 09:00:00', Team: 'FLY' } }] }); };
  const history = new PlayerHistory([new LeaguepediaHistory(fetchFn, () => now)], null, () => now);
  const log = await history.gameLog('LOL', 'LOL:m', 'Massu', 'creep_score');
  assert.deepEqual(log?.games.map((game) => game.value), [310, 280]);
  assert.ok(decodeURIComponent(asked).includes('ScoreboardPlayers.Link="Massu"'));
});
