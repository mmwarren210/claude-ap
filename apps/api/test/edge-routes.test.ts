import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PropLine } from '@crowniq/contracts';
import { edgeBoardPageSchema, edgeBoardResponseSchema, edgeGenResponseSchema } from '@crowniq/contracts';
import type { OddsProvider } from '@crowniq/engine';
import { SharpPropsFeed } from '../src/context/sharp-props.js';
import type { FairPrice, PickemLine } from '../src/context/sharp-props.js';
import { EdgeLedger } from '../src/edge/ledger.js';
import { SnapshotStore } from '../src/edge/snapshots.js';
import { buildServer } from '../src/server.js';

// Synthetic board and sportsbook prices only; nothing here is a real line or a real result.
const clockTime = new Date('2030-01-10T12:00:00Z');
const start = '2030-01-11T00:00:00Z';
const players = ['Alpha Guard', 'Bravo Wing', 'Charlie Big', 'Delta Forward'];

function lines(fetchedAt: string): PropLine[] {
  return [...players.map((name, index): PropLine => ({
    id: `line-${index}`, provider: 'prizepicks', sourceLineId: `sid-${index}`, sourceLineIdIsSynthetic: false,
    sport: 'NBA', league: 'NBA', eventId: index < 2 ? 'game-a' : 'game-b', eventName: 'Away @ Home', eventStartTime: start,
    playerId: 'player-' + index, playerName: name, team: null, opponent: null, homeTeam: index < 2 ? 'Home A' : 'Home B',
    awayTeam: index < 2 ? 'Away A' : 'Away B', market: 'player_points', threshold: 20.5, availableDirections: ['MORE', 'LESS'],
    lineType: 'REGULAR', fetchedAt })),
  // A Goblin with no confirmed payout factor, and a line nothing prices.
  { id: 'goblin-0', provider: 'prizepicks', sourceLineId: 'g0', sourceLineIdIsSynthetic: false, sport: 'NBA', league: 'NBA',
    eventId: 'game-a', eventName: 'Away @ Home', eventStartTime: start, playerId: 'player-0', playerName: players[0]!, team: null,
    opponent: null, market: 'player_points', threshold: 17.5, availableDirections: ['MORE'], lineType: 'GOBLIN', fetchedAt },
  { id: 'lonely', provider: 'prizepicks', sourceLineId: 'lonely', sourceLineIdIsSynthetic: false, sport: 'NBA', league: 'NBA',
    eventId: 'game-b', eventName: 'Away @ Home', eventStartTime: start, playerId: 'player-9', playerName: 'Echo Bench', team: null,
    opponent: null, market: 'player_steals', threshold: 1.5, availableDirections: ['MORE'], lineType: 'DEMON', fetchedAt }];
}
const prices: FairPrice[] = players.flatMap((name, index) => ['fanduel', 'draftkings', 'prizepicks'].map((book) => ({
  book, sport: 'NBA' as const, player: name, market: 'player_points', line: index === 3 ? 18.5 : 23.5, fairOver: 0.5,
  overAmerican: -115, underAmerican: -105, startTime: start, home: index < 2 ? 'Home A' : 'Home B', away: index < 2 ? 'Away A' : 'Away B' })));
const pickem: PickemLine[] = [{ book: 'prizepicks', league: 'nba', sport: 'NBA', eventId: 'sa-game-c', home: 'Home C', away: 'Away C',
  startTime: start, player: 'Foxtrot Center', marketType: 'player_rebounds', market: 'player_rebounds', line: 9.5,
  sides: ['LESS', 'MORE'], american: -137, alternate: false, stale: false, observedAt: null }];

test('Edge routes: every line read or No read, leave-one-out, Gen, slips and owner status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crowniq-edge-'));
  const clock = () => clockTime;
  const provider: OddsProvider<PropLine> = { id: 'fixture-edge', fetchPrizePicksLines: async () => lines(clock().toISOString()),
    normalize: (raw) => raw };
  const sharpFile = join(directory, 'sharp.json');
  await writeFile(sharpFile, JSON.stringify({ fetchedAt: clockTime.toISOString(), prices, pickem }));
  const ledger = new EdgeLedger(join(directory, 'edge.json'), clock);
  const snapshots = new SnapshotStore(null, clock);
  const app = buildServer({ provider, adminToken: 'fixture-token', clock, sharpProps: new SharpPropsFeed(null, sharpFile),
    edge: { ledger, snapshots } });
  const auth = { authorization: 'Bearer fixture-token' }, pull = { ...auth, 'x-confirm-provider-cost': 'yes' };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/refresh', headers: pull })).statusCode, 200);
    const response = await app.inject('/v1/edge?view=all');
    assert.equal(response.statusCode, 200);
    const edge = edgeBoardResponseSchema.parse(response.json());
    assert.equal(edge.counts.quotes, 8, 'FanDuel and DraftKings count; PrizePicks never prices itself');
    assert.equal(edge.counts.sharp, 5, 'the 4 regular lines and the Goblin');
    assert.ok(edge.picks.every((pick) => pick.platform === 'prizepicks'));
    assert.deepEqual(edge.picks.filter((pick) => pick.playerName === 'Delta Forward').map((pick) => pick.side), ['LESS']);
    const goblin = edge.picks.find((pick) => pick.lineId === 'goblin-0')!;
    assert.equal(goblin.edge, null, 'no payout factor confirmed: hit chance only');
    assert.ok(edge.slips.length > 0);
    // The sport chips: entries from that sport only, while the pick list stays whole.
    const sportOnly = edgeBoardResponseSchema.parse((await app.inject(`/v1/edge?slipSport=${edge.picks[0]!.sport}`)).json());
    assert.ok(sportOnly.slips.length > 0 && sportOnly.slips.every((slip) => slip.legs.every((leg) => leg.sport === edge.picks[0]!.sport)));
    const otherSport = edgeBoardResponseSchema.parse((await app.inject('/v1/edge?slipSport=NO_SUCH_SPORT')).json());
    assert.equal(otherSport.slips.length, 0, 'no picks in that sport, no entries');
    assert.ok(otherSport.picks.length > 0, 'the pick list is not cut by the slip sport');

    const page = edgeBoardPageSchema.parse((await app.inject('/v1/edge/board?limit=50')).json());
    assert.equal(page.total, 7, '4 regular lines, a Goblin, the line nothing prices, and the line only SharpAPI lists');
    const noRead = page.rows.filter((row) => row.kind === 'NO_READ');
    assert.deepEqual(noRead.map((row) => row.kind === 'NO_READ' && row.line.lineId).sort(),
      ['lonely', 'sharpapi:pp:sa-game-c:foxtrot-center:player_rebounds:9.5']);
    assert.ok(noRead.every((row) => row.kind === 'NO_READ' && row.line.note.startsWith('No read: no sportsbook price')));

    const genRaw = (await app.inject({ method: 'POST', url: '/v1/edge/gen',
      payload: { type: 'POWER', size: 2, count: 2 } })).json();
    const gen = edgeGenResponseSchema.parse(genRaw);
    // The Goblin stays out until Goblins & Demons is turned on.
    assert.ok(gen.slips.every((slip) => slip.legs.every((leg) => !leg.lineId.includes('goblin'))));
    assert.ok(gen.slips.length >= 1);
    assert.ok(gen.slips.every((slip) => new Set(slip.legs.map((leg) => leg.eventId)).size >= 2));
    const growth = edgeGenResponseSchema.parse((await app.inject({ method: 'POST', url: '/v1/edge/gen',
      payload: { type: 'POWER', size: 2, count: 2, objective: 'growth' } })).json());
    assert.ok(growth.slips.every((slip) => (slip.kellyFraction ?? 0) > 0 && (slip.growth ?? 0) > 0));
    assert.ok(growth.notes.some((note) => note.includes('Kelly')));

    // Hard Rock is held out of ranked picks and Gen until the side-bias check clears it (9b).
    const held = await app.inject({ method: 'POST', url: '/v1/edge/gen', payload: { platform: 'hardrock', type: 'PARLAY', size: 2 } });
    assert.ok(held.json().notes.some((note: string) => note.includes('on hold')), held.body);
    const heldTop = await app.inject('/v1/edge?platform=hardrock');
    assert.ok(heldTop.statusCode !== 200 || heldTop.json().picks.length === 0);
    const slip = await app.inject({ method: 'POST', url: '/v1/edge/slip', payload: { type: 'POWER', lineIds: ['line-0', 'line-2'] } });
    assert.equal(slip.statusCode, 200);
    // The ticket's own payouts replace the chart: EV uses exactly what the app showed, with no swap suggested.
    const ticket = (await app.inject({ method: 'POST', url: '/v1/edge/slip',
      payload: { type: 'POWER', lineIds: ['line-0', 'line-2'], payouts: { '2': 6, '1': 0 } } })).json().slip;
    assert.deepEqual(ticket.entry.payouts, { '2': 6 });
    assert.ok(Math.abs(ticket.expectedReturn - ticket.hitDistribution[2] * 6) < 1e-3);
    assert.equal(ticket.suggestion, undefined);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/edge/slip',
      payload: { type: 'POWER', lineIds: ['line-0', 'line-2'], payouts: { '2': -1 } } })).statusCode, 400);
    assert.equal((await app.inject('/v1/edge/line/lonely')).json().code, 'EDGE_LINE_UNPRICED');
    assert.equal((await app.inject('/v1/edge/player/player-0')).json().picks.length, 2);
    assert.equal((await app.inject('/v1/owner/edge/status')).statusCode, 404, 'owner only');
    const status = (await app.inject({ url: '/v1/admin/edge/status', headers: auth })).json();
    assert.equal(status.status.report.plusEv > 0, true);
    assert.equal(status.status.report.sharpApi.added, 1);
    assert.equal((await app.inject('/v1/edge/performance')).statusCode, 200);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
