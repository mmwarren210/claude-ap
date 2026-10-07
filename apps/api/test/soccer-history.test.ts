import assert from 'node:assert/strict';
import test from 'node:test';
import { playersFrom, SoccerHistory, soccerFantasy, soccerValue } from '../src/soccer-history.js';

const match = (startTimestamp: number, extra: Record<string, unknown> = {}) => ({ statusType: 'finished', startTimestamp,
  homeTeam: 'Arsenal', awayTeam: 'Chelsea', homeScore: 2, awayScore: 0, lineups: {
    home: { players: [
      { player: { name: 'Bukayo Saka', position: 'F' }, position: 'F', substitute: false, statistics: { minutesPlayed: 90, goals: 1,
        goalAssist: 1, totalShots: 4, onTargetScoringAttempt: 2, totalPass: 40, keyPass: 3, totalClearance: 1, totalTackle: 2,
        totalContest: 5, totalCross: 4, fouls: 2, wasFouled: 3 } },
      { player: { name: 'David Raya', position: 'G' }, position: 'G', substitute: false, statistics: { minutesPlayed: 90, saves: 4 } },
      { player: { name: 'Unused Sub', position: 'D' }, position: 'D', substitute: true, statistics: {} } ] },
    away: { players: [] } }, ...extra });

test('soccer: PrizePicks’ outfield and goalkeeper charts from Sofascore match stats', () => {
  const players = playersFrom(match(1_790_000_000));
  assert.deepEqual(players.map((item) => item.name), ['Bukayo Saka', 'David Raya'], 'unused subs are left out');
  const saka = players[0]!.row, raya = players[1]!.row;
  // 10 + 5 + 4 + 2 + 40×0.05 + 3×0.5 + 1 + 2 + 5 + 4×0.5 − 2×0.5.
  assert.equal(soccerFantasy(saka), 10 + 5 + 4 + 2 + 2 + 1.5 + 1 + 2 + 5 + 2 - 1);
  assert.equal(soccerFantasy(raya), 5 + 8 + 5, 'start, 4 saves, clean sheet');
  assert.equal(soccerValue('tackles', saka), 2);
  assert.equal(soccerValue('sot', saka), 2);
  assert.equal(soccerValue('shots', saka), 4);
  assert.equal(soccerValue('goal_plus_assist', saka), 2);
  assert.equal(soccerValue('fouls_drawn', saka), 3);
  assert.equal(soccerValue('goalie_saves', raya), 4);
  assert.equal(soccerValue('goalie_saves', saka), null);
});

test('soccer: fixtures are looked up once, matched by teams and date, and read before the game', async () => {
  const asked: string[][] = [];
  const day = (d: number) => new Date(Date.UTC(2030, 0, d, 15)).toISOString();
  const history = new SoccerHistory(async (queries) => { asked.push([...queries]);
    return [1, 2, 3, 4, 5].map((d) => match(Date.parse(day(d)) / 1000)).concat([match(Date.parse(day(9)) / 1000, { homeTeam: 'Liverpool' })]); },
  null, () => new Date('2030-01-10T00:00:00Z'), 0);
  const fixtures = [1, 2, 3, 4, 5].map((d) => ({ date: day(d), home: 'Arsenal', away: 'Chelsea' }));
  history.queue(fixtures);
  const result = await history.flush();
  assert.deepEqual(result, { asked: 5, found: 5 });
  assert.equal(asked[0]!.length, 5);
  history.queue(fixtures);
  assert.deepEqual(await history.flush(), { asked: 0, found: 0 }, 'found fixtures are never asked again');
  assert.equal((await history.values('Bukayo Saka', 'shots', day(6)))?.values.length, 5);
  assert.equal((await history.values('Bukayo Saka', 'shots', day(3)))?.values.length, 2, 'only matches before the game');
});
