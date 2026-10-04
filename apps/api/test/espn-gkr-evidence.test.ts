import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchTarget } from '@crowniq/engine';
import { EspnGkrEvidence, gameLogRows } from '../src/espn-gkr-evidence.js';

const now = new Date('2030-10-04T12:00:00Z');
const target = (playerName: string, market: string, playerId = playerName): ResearchTarget => ({ eventId: 'pp-game:1',
  eventName: 'Blackhawks @ Sabres', eventStartTime: '2030-10-04T23:00:00.000Z', league: 'NHL', playerId, playerName,
  team: 'Blackhawks', opponent: 'Sabres', market, sport: 'NHL', homeTeam: 'Sabres', awayTeam: 'Blackhawks' });
const log = (shots: number[]) => ({ names: ['goals', 'assists', 'points', 'shotsTotal', 'timeOnIcePerGame'],
  events: Object.fromEntries(shots.map((_, index) => [`e${index}`, { gameDate: new Date(Date.parse('2030-09-01') + index * 86_400_000).toISOString() }])),
  seasonTypes: [{ displayName: '2030-31 Regular Season', categories: [{ events: shots.map((value, index) =>
    ({ eventId: `e${index}`, stats: ['0', '1', '1', String(value), '16:30'] })) }] },
  { displayName: '2030-31 Preseason', categories: [{ events: [{ eventId: 'pre', stats: ['9', '9', '18', '20', '20:00'] }] }] }],
  filters: [{ name: 'season', options: [{ value: '2031' }, { value: '2030' }] }] });

test('ESPN game logs read by column name, mm:ss as minutes, preseason left out', () => {
  const rows = gameLogRows(log([2, 3, 4]));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].metrics.shotsTotal, 2);
  assert.equal(rows[0].metrics.timeOnIcePerGame, 16.5);
});

test('NHL players get history evidence and roster availability; an injured player is marked unavailable', async () => {
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('/scoreboard')) return json({ events: [{ id: '77', date: '2030-10-04T23:00Z', competitions: [{ competitors: [
      { team: { id: '2', displayName: 'Buffalo Sabres', name: 'Sabres' } }, { team: { id: '4', displayName: 'Chicago Blackhawks', name: 'Blackhawks' } }] }] }] });
    if (url.includes('/teams/4/roster')) return json({ athletes: [
      { id: '10', fullName: 'Tyler Bertuzzi', status: { type: 'active' }, injuries: [] },
      { id: '11', fullName: 'Hurt Forward', status: { type: 'active' }, injuries: [{ status: 'Out' }] }] });
    if (url.includes('/teams/2/roster')) return json({ athletes: [] });
    if (url.includes('/athletes/10/gamelog')) return json(log([2, 3, 4, 3, 2, 4, 3, 5, 3, 4, 2, 3]));
    if (url.includes('/athletes/11/gamelog')) return json(log([1, 1, 2, 1, 0, 2, 1, 1, 2, 1, 1, 0]));
    return new Response('missing', { status: 404 });
  };
  const adapter = new EspnGkrEvidence(fetchFn, { clock: () => now });
  const evidence = await adapter.research([target('Tyler Bertuzzi', 'shots_on_goal'), target('Hurt Forward', 'shots_on_goal'),
    target('Nobody Here', 'shots_on_goal'), target('Tyler Bertuzzi', 'hits')]);
  const of = (id: string, kind: string) => evidence.find((item) => item.entityId === id && item.kind === kind);
  assert.equal(of('Tyler Bertuzzi', 'status:player_available')?.numeric?.value, 1);
  assert.equal(of('Hurt Forward', 'status:player_available')?.numeric?.value, 0);
  assert.ok(of('Tyler Bertuzzi', 'projection:shots_on_goal'));
  assert.ok(of('Tyler Bertuzzi', 'metric:shot_volume'));
  assert.equal(of('Nobody Here', 'status:player_available'), undefined, 'not on either roster: nothing attached');
  assert.equal(adapter.getHealth().skipped, 1, 'hits are not in ESPN game logs');
  assert.ok(evidence.every((item) => item.sourceType === 'PUBLIC'));
});
