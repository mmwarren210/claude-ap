import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisSchema, boardResponseSchema, propLineSchema } from '@crowniq/contracts';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { booksPicks, bookViews, DEFAULT_BREAK_EVEN, evPicks } from '../src/context/ev.js';
import { fairPrices, SharpPropsFeed } from '../src/context/sharp-props.js';

const now = new Date('2030-10-04T12:00:00Z');
const row = (book: string, side: 'over' | 'under', probability: number, overrides: Record<string, unknown> = {}) => ({
  sportsbook: book, league: 'nfl', market_type: 'player_passing_yards', selection_type: side, line: 249.5,
  odds_probability: probability, odds_american: side === 'over' ? -150 : 120, player_name: 'Test Passer',
  event_id: 'nfl_game', event_start_time: '2030-10-04T17:00Z', home_team: 'Home', away_team: 'Away', is_live: false,
  is_active: true, ...overrides });

test('a book’s Over and Under at the same number are paired and the vig removed; lone sides and live rows are skipped', () => {
  const prices = fairPrices([row('draftkings', 'over', 0.6, {}), row('draftkings', 'under', 0.45),
    row('hardrock', 'over', 0.62), row('hardrock', 'under', 0.43, { line: 250.5 }),
    row('draftkings', 'over', 0.5, { market_type: 'player_longest_rush' }), row('draftkings', 'under', 0.5, { market_type: 'player_longest_rush' }),
    row('draftkings', 'over', 0.5, { player_name: 'Live Player', is_live: true }), row('draftkings', 'under', 0.5, { player_name: 'Live Player', is_live: true })]);
  assert.equal(prices.length, 1, 'only DraftKings has both sides at 249.5 on a mapped market');
  assert.deepEqual([prices[0].book, prices[0].market, prices[0].fairOver], ['draftkings', 'passing_yards', 0.5714]);
});

test('+EV compares the books’ fair chance at the same number with the break-even, standard lines only, GKR shown alongside', () => {
  const line = propLineSchema.parse({ ...fixtureLine(), id: 'pp:1', sport: 'NFL', league: 'NFL', playerName: 'Test Passer',
    market: 'passing_yards', threshold: 249.5, lineType: 'REGULAR', availableDirections: ['MORE', 'LESS'],
    eventStartTime: '2030-10-04T17:00:00.000Z' });
  const goblin = propLineSchema.parse({ ...line, id: 'pp:2', lineType: 'GOBLIN', availableDirections: ['MORE'] });
  const board = boardResponseSchema.parse({ board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines: [line, goblin] },
    analyses: [analysisSchema.parse({ lineId: 'pp:1', direction: 'MORE', score: 86, scoreBreakdown: [], assessments: [],
      evidenceIds: [], evidenceQuality: 'HIGH', dangerZone: false, ruleChecks: [], supportingFactors: [], opposingFactors: [],
      rationale: 'Fixture', reasonCode: null, modelVersion: 'fixture-1', scoreBand: 'CROWN_STRONG' })],
    rankedLineIds: ['pp:1'], builtAt: now.toISOString() });
  const prices = fairPrices([row('draftkings', 'over', 0.6), row('draftkings', 'under', 0.45),
    row('hardrock', 'over', 0.62), row('hardrock', 'under', 0.43)]);
  const [pick, ...rest] = evPicks(board, prices, now);
  assert.equal(rest.length, 0, 'the Goblin is left out');
  assert.equal(pick.side, 'MORE');
  assert.equal(pick.books.length, 2);
  assert.equal(pick.fairProbability, Math.round(((0.6 / 1.05) + (0.62 / 1.05)) / 2 * 10_000) / 10_000);
  assert.equal(pick.edge, Math.round((pick.fairProbability - DEFAULT_BREAK_EVEN) * 10_000) / 10_000);
  assert.deepEqual(pick.gkr, { direction: 'MORE', score: 86 });
  const views = bookViews(board, prices, now);
  assert.deepEqual([...views.keys()], ['pp:1'], 'the books view covers standard lines only');
  assert.equal(views.get('pp:1')!.fairMore, pick.fairProbability);
  assert.equal(evPicks(board, prices, new Date('2030-10-04T18:00:00Z')).length, 0, 'started games are left out');
});

test('the SharpAPI feed pages with the cursor, sends the key, and keeps old prices when a refresh fails', async () => {
  const calls: string[] = [];
  let fail = false;
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(url.searchParams.get('cursor') ?? 'first');
    assert.equal((init?.headers as Record<string, string>)['X-API-Key'], 'key');
    if (fail) return new Response('{}', { status: 500 });
    const first = !url.searchParams.get('cursor');
    return new Response(JSON.stringify({ data: first ? [row('draftkings', 'over', 0.6)] : [row('draftkings', 'under', 0.45)],
      pagination: { has_more: first, next_cursor: first ? 'next' : undefined } }), { status: 200 });
  }) as typeof fetch;
  const feed = new SharpPropsFeed('key', null, { leagues: ['nfl'], requestGapMs: 0 }, fetchFn, () => now);
  let reported = 0;
  feed.whenRefreshed((prices) => { reported = prices.length; });
  const status = await feed.refresh();
  assert.deepEqual(calls, ['first', 'next']);
  assert.equal(reported, 1, 'each successful refresh is reported for the books history');
  assert.deepEqual([status.prices, status.lastError], [1, null]);
  fail = true;
  const failed = await feed.refresh();
  assert.deepEqual([failed.prices, failed.lastError], [1, 'SHARPAPI_HTTP_500']);
  assert.equal((await new SharpPropsFeed(null, null).refresh()).lastError, 'SHARPAPI_KEY_MISSING');
});

test('Books picks: the books side on lines GKR could not score, at 56% or more, only on an offered side', () => {
  const base = propLineSchema.parse({ ...fixtureLine(), sport: 'NFL', league: 'NFL', market: 'passing_yards', threshold: 249.5,
    lineType: 'REGULAR', availableDirections: ['MORE', 'LESS'], eventStartTime: '2030-10-04T17:00:00.000Z' });
  const lines = ['a', 'b', 'c', 'd', 'e'].map((id) => propLineSchema.parse({ ...base, id, sourceLineId: id, playerId: id }));
  const pass = (lineId: string, reasonCode: string, score: number | null = null) => analysisSchema.parse({ lineId,
    direction: score === null ? 'PASS' : 'MORE', score, scoreBreakdown: [], assessments: [], evidenceIds: [],
    evidenceQuality: 'NONE', dangerZone: false, ruleChecks: [], supportingFactors: [], opposingFactors: [], rationale: 'x',
    reasonCode, modelVersion: null, scoreBand: score === null ? 'PASS' : 'CROWN_STRONG' });
  const board = boardResponseSchema.parse({ board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines },
    analyses: [pass('a', 'STALE_OR_MISSING_EVIDENCE'), pass('b', 'INSUFFICIENT_EDGE'), pass('c', 'MODEL_SUPPORT_INCOMPLETE'),
      pass('d', 'STALE_OR_MISSING_EVIDENCE')], rankedLineIds: [], builtAt: now.toISOString() });
  const view = (fairMore: number) => ({ fairMore, books: [{ book: 'draftkings', fairMore, overAmerican: null, underAmerican: null }] });
  const picks = booksPicks(board, new Map([['a', view(0.42)], ['b', view(0.7)], ['c', view(0.55)], ['d', view(0.6)], ['e', view(0.6)]]));
  assert.deepEqual([...picks.entries()], [['a', { side: 'LESS', fair: 0.58, books: 1 }], ['d', { side: 'MORE', fair: 0.6, books: 1 }],
    ['e', { side: 'MORE', fair: 0.6, books: 1 }]], 'b: GKR passed on the merits; c: under 56%; e: no analysis yet');
});
