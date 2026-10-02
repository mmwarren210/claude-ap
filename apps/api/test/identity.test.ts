import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { boardSchema, evidenceSchema, propLineSchema } from '@crowniq/contracts';
import type { Evidence, PropLine } from '@crowniq/contracts';
import { conservativeCorrelationPolicy, ModelRegistry } from '@crowniq/engine';
import type { ResearchTarget } from '@crowniq/engine';
import { EspnRosterIdentitySource } from '../src/identity/espn-rosters.js';
import { PlayerIdentityResearch } from '../src/identity/player-identity.js';
import { SleeperNflIdentitySource } from '../src/identity/sleeper-nfl.js';
import { JsonCache, matchTeam } from '../src/identity/types.js';
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


const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const espnTeams = (teams: [string, string, string, string][]) => ({ sports: [{ leagues: [{ teams: teams.map(([id, displayName, location, name]) =>
  ({ team: { id, displayName, location, name } })) }] }] });
const routed = (routes: Record<string, unknown>, calls: string[] = []): typeof fetch => async (input) => {
  const url = String(input); calls.push(url);
  return url in routes ? new Response(JSON.stringify(routes[url]), { status: 200 }) : new Response('{}', { status: 404 });
};
const target = (overrides: Partial<ResearchTarget>): ResearchTarget => ({ eventId: 'lac-lal', eventName: 'Los Angeles Clippers @ Los Angeles Lakers',
  eventStartTime: '2030-09-21T02:00:00.000Z', league: 'NBA', playerId: 'nba:harden', playerName: 'James Harden', team: null,
  opponent: null, homeTeam: 'Los Angeles Lakers', awayTeam: 'Los Angeles Clippers', market: 'player_points', sport: 'NBA', ...overrides });
const identityFor = (fetchFn: typeof fetch, withSleeper = false) => {
  const cache = new JsonCache(fetchFn, () => now);
  return new PlayerIdentityResearch([...(withSleeper ? [new SleeperNflIdentitySource(cache)] : []),
    new EspnRosterIdentitySource(cache)], { clock: () => now, cache });
};
const pick = (evidence: readonly Evidence[], playerId: string, kind: string) =>
  evidence.find((item) => item.entityId === playerId && item.kind === kind);

test('team names from other sources match the odds feed exactly or by a unique nickname', () => {
  const teams = [{ displayName: 'LA Clippers', location: 'LA', nickname: 'Clippers' },
    { displayName: 'Los Angeles Lakers', location: 'Los Angeles', nickname: 'Lakers' },
    { displayName: 'Brighton & Hove Albion', location: 'Brighton & Hove Albion', nickname: 'Brighton & Hove Albion' },
    { displayName: 'Manchester United', location: 'Manchester United', nickname: 'Manchester United' },
    { displayName: 'West Ham United', location: 'West Ham United', nickname: 'West Ham United' }];
  assert.equal(matchTeam('Los Angeles Clippers', teams)?.displayName, 'LA Clippers');
  assert.equal(matchTeam('Los Angeles Lakers', teams)?.displayName, 'Los Angeles Lakers');
  assert.equal(matchTeam('Brighton and Hove Albion', teams)?.displayName, 'Brighton & Hove Albion');
  assert.equal(matchTeam('Manchester United', teams)?.displayName, 'Manchester United');
  assert.equal(matchTeam('Newcastle United', teams), null);
});

test('identity covers NBA, WNBA, NHL, MLB and soccer from the two teams in each game', async () => {
  const calls: string[] = [];
  const fetchFn = routed({
    [`${ESPN}/basketball/nba/teams?limit=1000`]: espnTeams([['12', 'LA Clippers', 'LA', 'Clippers'],
      ['13', 'Los Angeles Lakers', 'Los Angeles', 'Lakers'], ['7', 'Denver Nuggets', 'Denver', 'Nuggets']]),
    [`${ESPN}/basketball/nba/teams/12/roster`]: { athletes: [{ id: '3992', fullName: 'James Harden',
      headshot: { href: 'https://a.espncdn.com/i/headshots/nba/players/full/3992.png' } }] },
    [`${ESPN}/basketball/nba/teams/13/roster`]: { athletes: [{ id: '1966', fullName: 'LeBron James' }] },
    // A same-named player outside this game must never be considered.
    [`${ESPN}/basketball/nba/teams/7/roster`]: { athletes: [{ id: '9999', fullName: 'James Harden' }] },
    [`${ESPN}/basketball/wnba/teams?limit=1000`]: espnTeams([['17', 'Las Vegas Aces', 'Las Vegas', 'Aces'],
      ['9', 'New York Liberty', 'New York', 'Liberty']]),
    [`${ESPN}/basketball/wnba/teams/17/roster`]: { athletes: [{ id: '3149391', fullName: "A'ja Wilson" }] },
    [`${ESPN}/basketball/wnba/teams/9/roster`]: { athletes: [] },
    [`${ESPN}/hockey/nhl/teams?limit=1000`]: espnTeams([['6', 'Edmonton Oilers', 'Edmonton', 'Oilers'],
      ['8', 'Calgary Flames', 'Calgary', 'Flames']]),
    [`${ESPN}/hockey/nhl/teams/6/roster`]: { athletes: [{ items: [{ id: '3895074', fullName: 'Connor McDavid' }] }] },
    [`${ESPN}/hockey/nhl/teams/8/roster`]: { athletes: [] },
    [`${ESPN}/baseball/mlb/teams?limit=1000`]: espnTeams([['19', 'Los Angeles Dodgers', 'Los Angeles', 'Dodgers'],
      ['26', 'San Francisco Giants', 'San Francisco', 'Giants']]),
    [`${ESPN}/baseball/mlb/teams/19/roster`]: { athletes: [{ position: 'Pitchers', items: [] },
      { position: 'Designated Hitter', items: [{ id: '39832', fullName: 'Shohei Ohtani' }] }] },
    [`${ESPN}/baseball/mlb/teams/26/roster`]: { athletes: [] },
    [`${ESPN}/soccer/eng.1/teams?limit=1000`]: espnTeams([['359', 'Arsenal', 'Arsenal', 'Arsenal'],
      ['363', 'Chelsea', 'Chelsea', 'Chelsea']]),
    [`${ESPN}/soccer/eng.1/teams/359/roster`]: { athletes: [{ id: '209163', displayName: 'Bukayo Saka' }] },
    [`${ESPN}/soccer/eng.1/teams/363/roster`]: { athletes: [] },
  }, calls);
  const adapter = identityFor(fetchFn);
  const evidence = await adapter.research([
    target({}), target({ market: 'player_assists' }), target({ playerId: 'nba:lebron', playerName: 'LeBron James' }),
    target({ eventId: 'nyl-lva', league: 'WNBA', sport: 'WNBA', playerId: 'wnba:aja', playerName: 'A’ja Wilson',
      homeTeam: 'Las Vegas Aces', awayTeam: 'New York Liberty' }),
    target({ eventId: 'cgy-edm', sport: 'NHL', playerId: 'nhl:mcdavid', playerName: 'Connor McDavid',
      homeTeam: 'Edmonton Oilers', awayTeam: 'Calgary Flames', market: 'points' }),
    target({ eventId: 'sf-lad', sport: 'MLB', playerId: 'mlb:ohtani', playerName: 'Shohei Ohtani',
      homeTeam: 'Los Angeles Dodgers', awayTeam: 'San Francisco Giants', market: 'batter_hits' }),
    target({ eventId: 'che-ars', sport: 'SOCCER', sourceSportKey: 'soccer_epl', playerId: 'soc:saka', playerName: 'Bukayo Saka',
      homeTeam: 'Arsenal', awayTeam: 'Chelsea', market: 'shots_on_goal' }),
    // Individual sports have no team source yet and are skipped, not guessed.
    target({ eventId: 'tennis', sport: 'TENNIS', playerId: 'ten:x', playerName: 'Player X', homeTeam: 'Player X', awayTeam: 'Player Y' }),
  ]);
  // "LA Clippers" on ESPN matches "Los Angeles Clippers" from the odds feed.
  assert.equal(pick(evidence, 'nba:harden', 'identity:team')?.finding, 'Los Angeles Clippers');
  assert.equal(pick(evidence, 'nba:harden', 'identity:photo')?.sourceUrl, 'https://a.espncdn.com/i/headshots/nba/players/full/3992.png');
  assert.equal(pick(evidence, 'nba:lebron', 'identity:team')?.finding, 'Los Angeles Lakers');
  assert.equal(pick(evidence, 'nba:lebron', 'identity:photo')?.sourceUrl, 'https://a.espncdn.com/i/headshots/nba/players/full/1966.png');
  assert.equal(pick(evidence, 'wnba:aja', 'identity:team')?.finding, 'Las Vegas Aces');
  assert.equal(pick(evidence, 'wnba:aja', 'identity:photo')?.sourceUrl, 'https://a.espncdn.com/i/headshots/wnba/players/full/3149391.png');
  assert.equal(pick(evidence, 'nhl:mcdavid', 'identity:team')?.finding, 'Edmonton Oilers');
  assert.equal(pick(evidence, 'mlb:ohtani', 'identity:team')?.finding, 'Los Angeles Dodgers');
  assert.equal(pick(evidence, 'mlb:ohtani', 'identity:photo')?.sourceUrl, 'https://a.espncdn.com/i/headshots/mlb/players/full/39832.png');
  assert.equal(pick(evidence, 'soc:saka', 'identity:team')?.finding, 'Arsenal');
  assert.equal(pick(evidence, 'soc:saka', 'identity:photo')?.sourceUrl, 'https://a.espncdn.com/i/headshots/soccer/players/full/209163.png');
  assert.equal(evidence.some((item) => item.entityId === 'ten:x'), false);
  // One player with two markets is looked up once, and rosters outside the game are never read.
  assert.equal(evidence.filter((item) => item.entityId === 'nba:harden').length, 2);
  assert.equal(calls.some((url) => url.endsWith('/teams/7/roster')), false);
  const health = adapter.getHealth();
  assert.equal(health.status, 'OK');
  assert.equal(health.targets, 6);
  // Cached: a second pass makes no new requests.
  const before = calls.length; await adapter.research([target({})]);
  assert.equal(calls.length, before);
  assert.equal(adapter.getHealth().cacheHits > 0, true);
});

test('NFL tries Sleeper first and falls back to ESPN when Sleeper is down', async () => {
  const nflTeams = { [`${ESPN}/football/nfl/teams?limit=1000`]: espnTeams([['2', 'Buffalo Bills', 'Buffalo', 'Bills'],
      ['15', 'Miami Dolphins', 'Miami', 'Dolphins']]),
    [`${ESPN}/football/nfl/teams/2/roster`]: { athletes: [{ position: 'offense', items: [{ id: '3918298', fullName: 'Josh Allen' }] }] },
    [`${ESPN}/football/nfl/teams/15/roster`]: { athletes: [] } };
  const nfl = target({ eventId: 'mia-buf', sport: 'NFL', playerId: 'nfl:allen', playerName: 'Josh Allen',
    homeTeam: 'Buffalo Bills', awayTeam: 'Miami Dolphins', market: 'passing_yards' });
  const withSleeper = await identityFor(routed({ ...nflTeams, 'https://api.sleeper.app/v1/players/nfl': {
    '4984': { full_name: 'Josh Allen', team: 'BUF' }, '3321': { full_name: 'Josh Allen', team: 'JAX' } } }), true).research([nfl]);
  assert.equal(pick(withSleeper, 'nfl:allen', 'identity:photo')?.sourceUrl, 'https://sleepercdn.com/content/nfl/players/4984.jpg');
  const adapter = identityFor(routed(nflTeams), true);
  const fallback = await adapter.research([nfl]);
  assert.equal(pick(fallback, 'nfl:allen', 'identity:team')?.finding, 'Buffalo Bills');
  assert.equal(pick(fallback, 'nfl:allen', 'identity:photo')?.sourceUrl, 'https://a.espncdn.com/i/headshots/nfl/players/full/3918298.png');
  assert.equal(adapter.getHealth().sources?.['sleeper-nfl']?.status, 'FAILED');
  assert.equal(adapter.getHealth().sources?.['espn-rosters']?.status, 'OK');
});

test('identity skips ambiguous players and reports outages without throwing', async () => {
  const twoTeams = routed({
    [`${ESPN}/basketball/nba/teams?limit=1000`]: espnTeams([['12', 'LA Clippers', 'LA', 'Clippers'],
      ['13', 'Los Angeles Lakers', 'Los Angeles', 'Lakers']]),
    [`${ESPN}/basketball/nba/teams/12/roster`]: { athletes: [{ id: '1', fullName: 'Jalen Green' }] },
    [`${ESPN}/basketball/nba/teams/13/roster`]: { athletes: [{ id: '2', fullName: 'Jalen Green' }] },
  });
  const ambiguous = identityFor(twoTeams);
  assert.deepEqual(await ambiguous.research([target({ playerName: 'Jalen Green' })]), []);
  assert.equal(ambiguous.getHealth().noSources, 1);
  const down = identityFor(async () => new Response('', { status: 503 }));
  assert.deepEqual(await down.research([target({})]), []);
  assert.equal(down.getHealth().status, 'FAILED');
  assert.equal(down.supports(target({ awayTeam: null })), false);
  assert.equal(down.supports(target({ sport: 'SOCCER', sourceSportKey: 'soccer_unknown_league' })), false);
});

test('identity fills the line team and player photo on the published board, preferring the more confident source', async () => {
  const fetchFn = routed({
    [`${ESPN}/basketball/nba/teams?limit=1000`]: espnTeams([['12', 'LA Clippers', 'LA', 'Clippers'],
      ['13', 'Los Angeles Lakers', 'Los Angeles', 'Lakers']]),
    [`${ESPN}/basketball/nba/teams/12/roster`]: { athletes: [{ id: '3992', fullName: 'James Harden' }] },
    [`${ESPN}/basketball/nba/teams/13/roster`]: { athletes: [] },
  });
  const nbaLine = propLineSchema.parse({ id: 'h', provider: 'prizepicks', sourceLineId: 'h', sport: 'NBA', league: 'NBA',
    eventId: 'lac-lal', eventName: 'Los Angeles Clippers @ Los Angeles Lakers', eventStartTime: '2030-09-21T02:00:00.000Z',
    playerId: 'nba:harden', playerName: 'James Harden', team: null, opponent: null, homeTeam: 'Los Angeles Lakers',
    awayTeam: 'Los Angeles Clippers', market: 'player_points', threshold: 24.5, availableDirections: ['MORE', 'LESS'],
    lineType: 'REGULAR', fetchedAt: now.toISOString() });
  const official = evidenceSchema.parse({ ...identity('nba:harden', 'identity:photo', 'Player headshot', 'https://official.example/harden.png'),
    id: 'official-photo', eventId: 'lac-lal', sourceType: 'OFFICIAL', quality: 'HIGH', confidence: 0.95 });
  const espn = identityFor(fetchFn);
  const research = { id: 'both', research: async (targets: readonly ResearchTarget[]) => [...await espn.research(targets), official] };
  const service = new BoardService({ id: 'fixture-provider', fetchPrizePicksLines: async () => [nbaLine],
    normalize: (raw) => raw as PropLine }, research, new ModelRegistry(), () => now);
  const snapshot = await service.refresh();
  assert.deepEqual([snapshot.board.lines[0].team, snapshot.board.lines[0].opponent], ['Los Angeles Clippers', 'Los Angeles Lakers']);
  assert.equal(snapshot.playerMedia?.['nba:harden']?.photoUrl, 'https://official.example/harden.png');
  // Identity never reaches the model: the line's analysis carries no identity evidence.
  const analysis = snapshot.analyses.find((item) => item.lineId === 'h')!;
  assert.equal(analysis.evidenceIds.some((id) => id.startsWith('identity:') || id === 'official-photo'), false);
});
