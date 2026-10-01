import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { boardSchema, evidenceSchema, propLineSchema } from '@crowniq/contracts';
import type { Evidence, PropLine } from '@crowniq/contracts';
import { conservativeCorrelationPolicy, ModelRegistry } from '@crowniq/engine';
import type { ResearchTarget } from '@crowniq/engine';
import { BoardService } from '../src/board-service.js';
import { CurrentContextResearch } from '../src/current-context.js';
import { ProductLedger } from '../src/product-ledger.js';

const now = new Date('2030-09-20T15:00:00.000Z');

test('NFL identity uses the game sides to separate players who share a name', async () => {
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
    '4984': { full_name: 'Josh Allen', position: 'QB', status: 'Active', injury_status: null, team: 'BUF' },
    '3321': { full_name: 'Josh Allen', position: 'LB', status: 'Active', injury_status: null, team: 'JAX' },
  }), { status: 200 });
  const adapter = new CurrentContextResearch({ fetchFn, clock: () => now, allowedKeys: ['NFL:passing_yards'] });
  const target: ResearchTarget = { eventId: 'buf-mia', eventName: 'Miami Dolphins @ Buffalo Bills',
    eventStartTime: '2030-09-21T17:00:00.000Z', league: 'NFL', playerId: 'nfl:josh', playerName: 'Josh Allen',
    team: null, opponent: null, homeTeam: 'Buffalo Bills', awayTeam: 'Miami Dolphins', market: 'passing_yards', sport: 'NFL' };
  const evidence = await adapter.research([target]);
  assert.equal(evidence.find((item) => item.kind === 'identity:team')?.finding, 'Buffalo Bills');
  assert.equal(evidence.find((item) => item.kind === 'identity:photo')?.sourceUrl,
    'https://sleepercdn.com/content/nfl/players/4984.jpg');
  assert.equal(evidence.find((item) => item.kind === 'status:qb_available')?.numeric?.value, 1);
  // Without game sides the shared name stays ambiguous, so nothing is emitted.
  assert.equal((await adapter.research([{ ...target, homeTeam: null, awayTeam: null }])).length, 0);
});

const line = (id: string, playerId: string, eventId = 'buf-mia', market = 'player_points'): PropLine => propLineSchema.parse({
  id, provider: 'prizepicks', sourceLineId: id, sport: 'NFL', league: 'NFL', eventId, eventName: 'Miami Dolphins @ Buffalo Bills',
  eventStartTime: '2030-09-21T17:00:00.000Z', playerId, playerName: playerId, team: null, opponent: null,
  homeTeam: 'Buffalo Bills', awayTeam: 'Miami Dolphins', market, threshold: 10.5, availableDirections: ['MORE'],
  lineType: 'REGULAR', fetchedAt: now.toISOString() });
const identity = (playerId: string, kind: string, finding: string, sourceUrl = 'https://example.org/source'): Evidence =>
  evidenceSchema.parse({ id: `${kind}:${playerId}`, entityType: 'PLAYER', entityId: playerId, eventId: 'buf-mia', market: null,
    kind, finding, sourceName: 'Fixture source', sourceUrl, sourceType: 'PUBLIC', retrievedAt: now.toISOString(),
    expiresAt: '2030-09-20T15:30:00.000Z', quality: 'MEDIUM', confidence: 0.8, numeric: { value: 1 } });

test('board service sets team only from a matching side and publishes player photos', async () => {
  const board = boardSchema.parse({ provider: 'prizepicks', fetchedAt: now.toISOString(),
    lines: [line('a', 'allen'), line('b', 'waddle'), line('c', 'stranger')] });
  const research = { id: 'fixture', research: async () => [identity('allen', 'identity:team', 'Buffalo Bills'),
    identity('allen', 'identity:photo', 'Player headshot', 'https://sleepercdn.com/content/nfl/players/4984.jpg'),
    identity('waddle', 'identity:team', 'Miami Dolphins'), identity('stranger', 'identity:team', 'Kansas City Chiefs')] };
  const service = new BoardService({ id: 'fixture-provider', fetchPrizePicksLines: async () => board.lines,
    normalize: (raw) => raw as PropLine }, research, new ModelRegistry(), () => now);
  const snapshot = await service.refresh();
  const byId = new Map(snapshot.board.lines.map((item) => [item.id, item]));
  assert.deepEqual([byId.get('a')!.team, byId.get('a')!.opponent], ['Buffalo Bills', 'Miami Dolphins']);
  assert.deepEqual([byId.get('b')!.team, byId.get('b')!.opponent], ['Miami Dolphins', 'Buffalo Bills']);
  // A team that is not one of this game's sides is ignored, never guessed.
  assert.equal(byId.get('c')!.team, null);
  assert.equal(snapshot.playerMedia?.allen?.photoUrl, 'https://sleepercdn.com/content/nfl/players/4984.jpg');
});

test('with team identity and the conservative policy, a valid Crown saves; a 3-leg single game does not', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crowniq-crown-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = new ProductLedger(join(dir, 'ledger.json'), 'CROWN_STRONG', () => now, conservativeCorrelationPolicy);
  const user = await ledger.register('crown@example.org', 'abcdefghijkl', 'Crown_user');
  const legs = [line('x1', 'p1', 'g1'), line('x2', 'p2', 'g2'), line('x3', 'p3', 'g2'), line('x4', 'p4', 'g2')]
    .map((item, index) => ({ ...item, team: index % 2 ? 'Buffalo Bills' : 'Miami Dolphins' }));
  const analysis = (lineId: string) => ({ lineId, direction: 'MORE' as const, score: 90, scoreBreakdown: [], assessments: [],
    evidenceIds: [], evidenceExpiresAt: null, evidenceQuality: 'HIGH' as const, dangerZone: false, ruleChecks: [],
    supportingFactors: [], opposingFactors: [], rationale: 'Fixture.', reasonCode: null, modelVersion: 'FIXTURE-1',
    scoreBand: 'CROWN_STRONG' as const });
  const board = { board: boardSchema.parse({ provider: 'prizepicks', fetchedAt: now.toISOString(), lines: legs }),
    analyses: legs.map((item) => analysis(item.id)), rankedLineIds: legs.map((item) => item.id), builtAt: now.toISOString() };
  const account = (await ledger.authenticate(user.token))!.accountId;
  assert.equal((await ledger.savePrivateCrown(account, ['x1', 'x2'], board, [])).alreadySaved, false);
  await assert.rejects(() => ledger.savePrivateCrown(account, ['x2', 'x3', 'x4'], board, []), /SAME_EVENT_CONCENTRATION/);
});
