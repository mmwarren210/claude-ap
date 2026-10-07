import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisSchema, boardResponseSchema, propLineSchema } from '@crowniq/contracts';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { booksPicks, bookViews, DEFAULT_BREAK_EVEN, evPicks } from '../src/context/ev.js';
import { expectedGoals, fairPrices, normalizeRow, scorerFairPrices, SharpPropsFeed } from '../src/context/sharp-props.js';

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
    const url = new URL(String(input));
    calls.push(`${url.searchParams.get('market_type') ? 'games:' : ''}${url.searchParams.get('cursor') ?? 'first'}`);
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
  assert.deepEqual(calls, ['first', 'next'], 'player props, paged (game lines were only for Kalshi)');
  assert.equal(reported, 1, 'each successful refresh is reported for the books history');
  assert.deepEqual([status.prices, status.lastError], [1, null]);
  fail = true;
  const failed = await feed.refresh();
  assert.deepEqual([failed.prices, failed.lastError], [1, 'SHARPAPI_HTTP_500']);
  assert.equal((await new SharpPropsFeed(null, null).refresh()).lastError, 'SHARPAPI_KEY_MISSING');
});

test('anytime goal scorer Yes/No becomes the over/under of 0.5 goals (NHL goals were unpriced)', () => {
  const scorer = (side: string, probability: number) => normalizeRow(row('draftkings', 'over', probability,
    { league: 'nhl', market_type: 'anytime_goal_scorer', selection_type: side, line: null }));
  const [price] = fairPrices([scorer('yes', 0.3), scorer('no', 0.75)]);
  assert.deepEqual([price?.sport, price?.market, price?.line], ['NHL', 'goals', 0.5]);
  assert.equal(price?.fairOver, Math.round(0.3 / 1.05 * 10_000) / 10_000);
  const other = row('draftkings', 'over', 0.5, { market_type: 'player_passing_yards' });
  assert.equal(normalizeRow(other), other, 'other markets pass through');
});

test('anytime goal scorer: one-sided Yes prices de-vigged per game against the goal total', () => {
  const base = { sportsbook: 'fanduel', league: 'nhl', event_id: 'g1', event_start_time: '2030-10-04T23:00Z', home_team: 'Home',
    away_team: 'Away', is_live: false, is_active: true };
  // Fair scoring rates for 36 skaters summing to 5.8 goals; the book shades every Yes up by 25%.
  const rates = Array.from({ length: 36 }, (_, index) => 0.05 + 0.3 * ((index * 7) % 36) / 36);
  const scale = 5.8 / rates.reduce((a, b) => a + b, 0);
  const fair = rates.map((rate) => 1 - Math.exp(-rate * scale));
  const rows = fair.map((p, index) => ({ ...base, market_type: 'anytime_goal_scorer', selection_type: 'other', line: null,
    player_name: `Skater ${index}`, odds_probability: p * 1.25 }));
  // A 6.5 total priced so the Poisson mean is 5.8 / 0.97.
  const mean = 5.8 / 0.97;
  let term = Math.exp(-mean), cdf = term;
  for (let k = 1; k <= 6; k++) { term *= mean / k; cdf += term; }
  const over = 1 - cdf;
  const games = [{ book: 'pinnacle', league: 'nhl', sport: 'hockey', eventId: 'g1', home: 'Home', away: 'Away', startTime: base.event_start_time,
    market: 'total' as const, line: 6.5, side: 'over' as const, probability: over * 1.03, american: null },
  { book: 'pinnacle', league: 'nhl', sport: 'hockey', eventId: 'g1', home: 'Home', away: 'Away', startTime: base.event_start_time,
    market: 'total' as const, line: 6.5, side: 'under' as const, probability: (1 - over) * 1.03, american: null }];
  assert.ok(Math.abs(expectedGoals(games).get('g1')! - mean) < 1e-3);
  const prices = scorerFairPrices(rows, games);
  assert.equal(prices.length, 36);
  assert.deepEqual([prices[0]!.sport, prices[0]!.market, prices[0]!.line], ['NHL', 'goals', 0.5]);
  for (const [index, price] of prices.entries()) assert.ok(Math.abs(price.fairOver - fair[index]!) < 0.002, `skater ${index}`);
  assert.equal(scorerFairPrices(rows, []).length, 0, 'no total, no guess');
  assert.equal(scorerFairPrices(rows.slice(0, 5), games).length, 0, 'an incomplete player list is left out');
  assert.equal(scorerFairPrices(rows.map((row) => ({ ...row, sportsbook: 'draftkings' })), games).length, 0,
    'DraftKings "anytime" rows carry first-goal prices');
  assert.equal(scorerFairPrices(rows.map((row) => ({ ...row, league: 'germany_-_bundesliga' })), games).length, 0, 'NHL only');
});

test('the SharpAPI feed waits out a 429 and keeps going instead of dropping the refresh', async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
    return new Response(JSON.stringify({ data: [row('draftkings', 'over', 0.6), row('draftkings', 'under', 0.45)],
      pagination: { has_more: false } }), { status: 200 });
  }) as typeof fetch;
  const status = await new SharpPropsFeed('key', null, { leagues: ['nfl'], requestGapMs: 0, retryScale: 0 }, fetchFn, () => now).refresh();
  assert.equal(calls, 2);
  assert.deepEqual([status.prices, status.lastError], [1, null]);
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

test('+EV from nearby numbers: between two numbers a book prices, or a one-sided floor from a harder number', async () => {
  const { chanceAt } = await import('../src/context/ev.js');
  const p = (line: number, fairOver: number) => ({ book: 'hardrock', sport: 'NFL', player: 'A', market: 'm', line, fairOver,
    overAmerican: null, underAmerican: null, startTime: '2030-10-05T20:00:00Z', home: null, away: null }) as const;
  assert.deepEqual(chanceAt([p(23.5, 0.6), p(25.5, 0.4)], 24.5)!.fairMore, 0.5, 'halfway between');
  assert.equal(chanceAt([p(23.5, 0.6), p(25.5, 0.4)], 24.5)!.how, 'BETWEEN');
  assert.deepEqual({ ...chanceAt([p(25.5, 0.58)], 24.5)!, price: undefined }, { fairMore: 0.58, how: 'FLOOR', side: 'MORE', price: undefined },
    'Over 25.5 at 58% means Over 24.5 is at least 58%');
  assert.equal(chanceAt([p(23.5, 0.42)], 24.5)!.side, 'LESS', 'Under 23.5 is harder than Under 24.5');
  assert.equal(chanceAt([p(30.5, 0.5)], 24.5), null, 'too far away');
  assert.equal(chanceAt([p(20.5, 0.8), p(28.5, 0.2)], 24.5)?.how, undefined, 'numbers more than 3 apart are not bridged');
});

test('tennis: Hard Rock’s player total games is that player’s games won; DraftKings’ set-level total games is left out', async () => {
  const { fairPrices } = await import('../src/context/sharp-props.js');
  const row = (sportsbook: string, market_type: string, selection_type: string, line: number, p: number) => ({ sportsbook, league: 'atp',
    market_type, selection_type, line, odds_probability: p, odds_american: -110, player_name: 'A Player', event_id: 'e',
    event_start_time: '2030-10-05T20:00Z', is_live: false, is_active: true });
  const prices = fairPrices([row('hardrock', 'player_total_games', 'over', 11.5, 0.5), row('hardrock', 'player_total_games', 'under', 11.5, 0.5),
    row('draftkings', 'player_total_games', 'over', 7.5, 0.5), row('draftkings', 'player_total_games', 'under', 7.5, 0.5),
    row('draftkings', 'player_games_won', 'over', 11.5, 0.5), row('draftkings', 'player_games_won', 'under', 11.5, 0.5)]);
  assert.deepEqual(prices.map((price) => `${price.book}:${price.market}:${price.line}`).sort(),
    ['draftkings:games_won:11.5', 'hardrock:games_won:11.5']);
});
