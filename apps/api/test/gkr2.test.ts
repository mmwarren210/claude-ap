import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceSchema } from '@crowniq/contracts';
import { createGkrRegistry, marketDefinitions } from '@crowniq/engine';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { createGkr2Registry, Gkr2, gkr2Definition, gkr2Evidence, opponentIndex, playerTeam } from '../src/gkr2.js';
import type { Game } from '../src/propline-history.js';
import { PropLineHistory } from '../src/propline-history.js';
import type { PropLineClient } from '../src/scrapers/propline.js';
import type { GameLine } from '../src/context/feeds.js';

const day = (n: number) => new Date(Date.parse('2030-09-24T00:00:00Z') - n * 86_400_000).toISOString();
const receiver = (team: string, opponents: readonly string[], targets: (i: number) => number): Game[] =>
  opponents.map((opponent, i) => ({ at: day(i + 1), opponent: null, home: i % 2 ? team : opponent, away: i % 2 ? opponent : team,
    stats: { receiving_targets: targets(i), receptions: Math.round(targets(i) * .7), receiving_yards: targets(i) * 8 } }));

test('a GKR 2 model is GKR\'s model with the opponent read', () => {
  const definition = marketDefinitions.find((item) => item.version === 'GKR-NFL-PLAYER-RECEPTIONS-1.3')!;
  const g2 = gkr2Definition(definition);
  assert.equal(g2.version, 'GKR-NFL-PLAYER-RECEPTIONS-1.3-G2');
  assert.deepEqual(g2.factors, definition.factors, 'its matchup factor takes the opponent read');
  assert.equal(g2.lessAware, false, 'factors keep GKR\'s reading');
  const hoops = gkr2Definition(marketDefinitions.find((item) => item.version === 'GKR-WNBA-POINTS-SH4-1.0')!);
  assert.deepEqual(hoops.factors, [['historical_volume', 45], ['minutes', 27], ['stability', 18], ['opponent_allowed', 10]],
    'a model with no opponent factor gets one at a tenth of the weight');
  const live = createGkrRegistry(['GKR-NFL-PLAYER-RECEPTIONS-1.3']);
  const registry = createGkr2Registry(live.versions(), (key) => key === 'NFL:player_receptions');
  assert.equal(registry.resolve({ sport: 'NFL', market: 'player_receptions' })?.version, 'GKR-NFL-PLAYER-RECEPTIONS-1.3-G2');
  assert.equal(registry.resolve({ sport: 'NFL', market: 'passing_yards' }), null, 'only approved models get a GKR 2 version');
});

test('the player\'s team is the side in most of their games, and the opponent index compares each opponent with players\' usual output', () => {
  const opponents = ['Soft Tigers', 'Hard Bears', 'Soft Tigers', 'Hard Bears', 'Other Owls', 'Soft Tigers', 'Hard Bears', 'Other Owls'];
  const players = Array.from({ length: 12 }, (_, p) => receiver(`Team ${p} Hawks${p}`, opponents,
    (i) => opponents[i] === 'Soft Tigers' ? 9 : opponents[i] === 'Hard Bears' ? 3 : 6));
  assert.equal(playerTeam(players[0]!), 'Team 0 Hawks0');
  const index = opponentIndex(players, 'receiving_targets');
  assert.ok(index.get('tigers')! > 1.2, `soft defense gives more (${index.get('tigers')})`);
  assert.ok(index.get('bears')! < .8, `hard defense gives less (${index.get('bears')})`);
});

test('GKR 2 evidence fills the model\'s named factors from box scores, adds the opponent and game script, and leans recent', () => {
  const definition = gkr2Definition(marketDefinitions.find((item) => item.version === 'GKR-NFL-PLAYER-RECEPTIONS-1.3')!);
  const games = receiver('Home Hawks', Array.from({ length: 12 }, () => 'Away Owls'), (i) => i < 4 ? 10 : 5);
  const line = fixtureLine({ market: 'player_receptions', threshold: 4.5, team: 'Home Hawks', opponent: 'Away Owls', eventStartTime: '2030-09-25T00:00:00Z' });
  const lines: GameLine[] = [
    { league: 'NFL', home: 'Home Hawks', away: 'Away Owls', startTime: '2030-09-25T00:00:00Z', market: 'total', line: 52, homePrice: -110, awayPrice: -110, homeFair: .5, awayFair: .5, sourceUrl: null },
    { league: 'NFL', home: 'Home Hawks', away: 'Away Owls', startTime: '2030-09-25T00:00:00Z', market: 'spread', line: -6, homePrice: -110, awayPrice: -110, homeFair: .5, awayFair: .5, sourceUrl: null }];
  const evidence = gkr2Evidence(line, games, { opponents: new Map([['owls', 1.2]]), games: lines, leagueTeamTotal: 22 },
    new Date('2030-09-24T12:00:00Z'), definition);
  const value = (kind: string) => evidence.find((item) => item.kind === kind)?.numeric;
  assert.ok(value('metric:target_floor')!.value > value('metric:target_floor')!.baseline!, 'targets up lately');
  assert.ok(value('metric:catch_rate'), 'rates read too');
  assert.deepEqual(value('metric:matchup_coverage'), { value: 1.2, baseline: 1 });
  assert.equal(value('metric:game_script'), undefined, 'this model has no game-script factor');
  const projection = value('projection:player_receptions')!;
  const flat = games.map((game) => game.stats.receptions!).reduce((a, b) => a + b, 0) / games.length;
  assert.ok(projection.value > flat * 1.1, `recent games and a soft opponent lift the projection (${projection.value} vs ${flat})`);
  assert.ok(evidence.every((item) => !JSON.stringify(item).includes('4.5')), 'the line is never read');
});

test('GKR 2 scores a board from cached PropLine games only and adds GKR\'s evidence', async () => {
  const games = receiver('Home Hawks', Array.from({ length: 12 }, () => 'Away Owls'), (i) => i < 4 ? 10 : 7);
  const asked: string[] = [];
  const client = { get: async (path: string) => { asked.push(path);
    return { games: games.map((game) => ({ commence_time: game.at, status: 'final', home_team: game.home, away_team: game.away, stats: game.stats })) }; } } as unknown as PropLineClient;
  const now = new Date('2030-09-24T12:00:00Z');
  const history = new PropLineHistory(client, null, () => 'football_nfl', {}, () => now.getTime());
  const live = createGkrRegistry(['GKR-NFL-PLAYER-RECEPTIONS-1.3']);
  const registry = createGkr2Registry(live.versions(), () => true);
  const gkr2 = new Gkr2(history, () => registry, null, () => now);
  const line = fixtureLine({ market: 'player_receptions', threshold: 4.5, team: 'Home Hawks', opponent: 'Away Owls', eventStartTime: '2030-09-25T00:00:00Z' });
  assert.deepEqual(await gkr2.analyses([line], []), [], 'nothing cached: no read and no request');
  assert.equal(asked.length, 0);
  await history.gamesFor(line);
  const available = evidenceSchema.parse({ id: 'status', entityType: 'PLAYER', entityId: line.playerId, eventId: line.eventId, market: null,
    kind: 'status:player_available', finding: 'Active.', sourceName: 'ESPN', sourceUrl: 'https://espn.com', sourceType: 'PUBLIC',
    retrievedAt: '2030-09-24T11:00:00.000Z', expiresAt: '2030-09-24T23:00:00.000Z', quality: 'HIGH', confidence: .9, numeric: { value: 1 } });
  const [analysis] = await gkr2.analyses([line], [available]);
  assert.equal(analysis?.modelVersion, 'GKR-NFL-PLAYER-RECEPTIONS-1.3-G2');
  assert.equal(analysis?.direction, 'MORE', `${analysis?.reasonCode} ${analysis?.rationale}`);
  const [blocked] = await gkr2.analyses([line], []);
  assert.equal(blocked?.reasonCode, 'STALE_OR_MISSING_EVIDENCE', 'GKR\'s availability gate still holds');
});

test('Edge moves its stats projection by half the opponent read, within 8%, and the read finds the opponent from the game', async () => {
  const { opponentFactor } = await import('../src/edge/service.js');
  const { OpponentReads } = await import('../src/gkr2.js');
  assert.equal(opponentFactor(null), null);
  assert.equal(opponentFactor({ opponent: 'Owls', index: 1.01 }), null, 'under 1% is left out');
  assert.equal(opponentFactor({ opponent: 'Owls', index: 1.1 })!.factor.toFixed(2), '1.05');
  assert.equal(opponentFactor({ opponent: 'Owls', index: 1.5 })!.factor, 1.08);
  assert.equal(opponentFactor({ opponent: 'Owls', index: .5 })!.factor, .92);
  const opponents = ['Soft Tigers', 'Hard Bears', 'Soft Tigers', 'Hard Bears', 'Soft Tigers', 'Hard Bears'];
  const cached = Array.from({ length: 10 }, (_, p) => receiver(`Team ${p} Hawks${p}`, opponents, (i) => opponents[i] === 'Soft Tigers' ? 9 : 3));
  const history = { sportKey: () => 'football_nfl', cachedGames: () => cached } as unknown as PropLineHistory;
  const reads = new OpponentReads(history);
  const line = fixtureLine({ market: 'player_receptions', team: 'Home Hawks', opponent: null, homeTeam: 'Home Hawks', awayTeam: 'Soft Tigers' });
  const read = reads.read(line);
  assert.equal(read?.opponent, 'Soft Tigers');
  assert.ok(read!.index > 1.2);
  assert.equal(reads.read({ ...line, homeTeam: null, awayTeam: null }), null, 'no opponent known');
});
