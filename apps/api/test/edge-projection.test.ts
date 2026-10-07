import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PropLine } from '@crowniq/contracts';
import { priceBoard } from '@crowniq/edge';
import type { GameLine } from '../src/context/feeds.js';
import { GameEnvironment, restEffects, restFactor } from '../src/edge/environment.js';
import { EdgeLedger } from '../src/edge/ledger.js';

// Synthetic games, rows and picks only.
const start = '2030-01-11T00:00:00Z';
const line = (options: Partial<PropLine> = {}): PropLine => ({ id: 'l1', provider: 'prizepicks', sourceLineId: 'l1',
  sourceLineIdIsSynthetic: false, sport: 'NBA', league: 'NBA', eventId: 'g', eventName: 'Away A @ Home A', eventStartTime: start,
  playerId: 'p1', playerName: 'Alpha Guard', team: 'Home A', opponent: null, market: 'player_points', threshold: 24.5,
  availableDirections: ['MORE', 'LESS'], lineType: 'REGULAR', fetchedAt: '2030-01-10T12:00:00Z', ...options });
const game = (home: string, away: string, total: number, spread: number, league = 'NBA'): GameLine[] =>
  (['total', 'spread'] as const).map((market) => ({ league, home, away, startTime: start, market, line: market === 'total' ? total : spread,
    homePrice: null, awayPrice: null, homeFair: null, awayFair: null, sourceUrl: null }));
const slate = [...game('Home A', 'Away A', 240, -10), ...game('Home B', 'Away B', 220, 0), ...game('Home C', 'Away C', 220, 0),
  ...game('Home D', 'Away D', 220, 0)];

test('environment: a team implied to score more lifts volume stats, capped at ±10%; no league baseline means no change', () => {
  const environment = new GameEnvironment(slate);
  const home = environment.factor(line())!;
  // Home A implied 125 vs a 110 league median: (125/110)^0.5 ≈ 1.066.
  assert.ok(Math.abs(home.factor - Math.sqrt(125 / 110)) < 1e-9);
  assert.match(home.reasons[0]!, /expected to score 115|expected to score 125/);
  const away = environment.factor(line({ team: 'Away A' }))!;
  assert.ok(away.factor < home.factor, 'the underdog is implied to score less');
  assert.equal(environment.factor(line({ team: 'Home B' })), null, 'a typical game changes nothing');
  assert.equal(environment.factor(line({ team: null })), null);
  assert.equal(new GameEnvironment(game('Home A', 'Away A', 240, -10)).factor(line()), null, 'one game is no baseline');
  const extreme = new GameEnvironment([...game('Home A', 'Away A', 400, -60), ...slate.slice(2)]).factor(line())!;
  assert.equal(extreme.factor, 1.1);
  // Scoring events move one for one with the team's expected scoring, within ±25%.
  const td = new GameEnvironment(slate).factor(line({ market: 'anytime_tds' }))!;
  assert.ok(Math.abs(td.factor - 125 / 110) < 1e-9);
  assert.equal(new GameEnvironment([...game('Home A', 'Away A', 400, -60), ...slate.slice(2)]).factor(line({ market: 'goals' }))!.factor, 1.25);
});

test('rest: the back-to-back effect is kept only with 30+ games and an interval that excludes no effect', () => {
  // Pairs of games a day apart, three days between pairs: every odd game is a back-to-back.
  const rows = (b2bValue: number) => Array.from({ length: 20 }, (_, index) => ({
    occurredAt: new Date(Date.parse('2029-11-01T00:00:00Z') + (Math.floor(index / 2) * 96 + (index % 2) * 24) * 3600_000).toISOString(),
    metrics: {}, marketValues: { player_points: index % 2 ? b2bValue + (index % 4) - 1 : 20 + (index % 3) } }));
  const players = (count: number, value: number) => Array.from({ length: count }, () => ({ sport: 'NBA', rows: rows(value) }));
  const effects = restEffects(players(4, 15));
  const effect = effects.get('NBA:player_points')!;
  assert.ok(effect.n >= 30 && effect.coefficient < 1 && effect.high < 1);
  assert.equal(restEffects(players(2, 15)).size, 0, 'under 30 back-to-back games');
  assert.equal(restEffects(players(4, 19.5)).size, 0, 'no clear effect');
  assert.equal(restEffects([{ sport: 'MLB', rows: rows(15) }]).size, 0, 'baseball plays every day; no rest effect');
  const lastGame = Date.parse(start) - 20 * 3600_000;
  assert.equal(restFactor(line(), lastGame, effects)!.factor, effect.coefficient);
  assert.equal(restFactor(line(), Date.parse(start) - 48 * 3600_000, effects), null);
  assert.equal(restFactor(line(), null, effects), null);
});

test('pricing: the stats adjustment moves the stats mean; a low honesty weight widens the stats read', () => {
  const now = new Date('2030-01-10T12:00:00Z');
  const values = [25, 24, 26, 25, 23, 27, 25, 24, 26, 25];
  const base = priceBoard({ lines: [line()], now, values: () => values }).picks[0]!;
  const lifted = priceBoard({ lines: [line()], now, values: () => values,
    statsAdjust: () => ({ factor: 1.08, reasons: ['Game total test'] }) }).picks[0]!;
  assert.ok(lifted.sources.stats!.mean > base.sources.stats!.mean * 1.07);
  assert.ok(lifted.probability > base.probability);
  assert.ok(lifted.reasons.some((reason) => reason.includes('Game total test')));
  // The regular line's own number no longer counts toward its price (leave-one-out), so a doubted stats read shows as a
  // less confident probability (on a line well below the player's average) rather than a smaller share of the blend.
  const clear = priceBoard({ lines: [line({ threshold: 20.5 })], now, values: () => values }).picks[0]!;
  const doubted = priceBoard({ lines: [line({ threshold: 20.5 })], now, values: () => values, statsWeight: () => .25 }).picks[0]!;
  assert.equal(doubted.side, 'MORE');
  assert.ok(doubted.probability < clear.probability, 'a doubted stats read is less confident');
});

test('honesty gate: a stats model that misses by more than the books loses weight, shrunk toward 1', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'edge-honesty-'));
  try {
    const pick = (index: number, sport: string, statsMean: number) => ({ id: `${sport}${index}`, platform: 'prizepicks', key: `k${index}`,
      lineId: `l${index}`, sport, league: sport, eventId: 'g', eventName: 'A @ H', eventStartTime: start, playerId: 'p', playerName: 'P',
      team: null, homeTeam: null, awayTeam: null, market: 'player_points', threshold: 20.5, lineType: 'REGULAR', side: 'MORE',
      tier: 'SHARP', rating: 'STRONG', firstProbability: .6, probability: .6, breakEven: .55, edge: .05, firstSeenAt: start,
      lastSeenAt: start, modelVersion: 'x', outcome: 'WIN', actual: 22, gradedAt: start, resultSource: 'x', statsMean, marketMean: 21 });
    const picks = [...Array.from({ length: 100 }, (_, index) => pick(index, 'NBA', 26)),
      ...Array.from({ length: 100 }, (_, index) => pick(index, 'NHL', 23)), ...Array.from({ length: 10 }, (_, index) => pick(index, 'MLB', 40))];
    await writeFile(join(directory, 'ledger.json'), JSON.stringify({ version: 1, picks }));
    const weights = await new EdgeLedger(join(directory, 'ledger.json')).honesty();
    // NBA: books miss by 1, stats by 4 → measured (1/4)² = 0.0625, shrunk with 100 picks of prior to ≈ 0.53.
    assert.ok(Math.abs(weights.get('NBA:player_points')! - (100 * .0625 + 100) / 200) < 1e-9);
    assert.equal(weights.get('NHL:player_points'), 1, 'stats as good as the books keep full weight');
    assert.equal(weights.has('MLB:player_points'), false, 'under 30 graded picks');
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});

test('backtest: projection 2.0 (with a learned back-to-back effect) beats the current projection where the effect is real', async () => {
  const { backtestHistory } = await import('../src/edge/service.js');
  let seed = 9;
  const uniform = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed + .5) / 2 ** 32; };
  const rows = Array.from({ length: 40 }, (_, player) => Array.from({ length: 30 }, (_, game) => {
    const b2b = game % 3 === 1, base = 18 + player % 10;
    const at = Date.parse('2029-11-01T00:00:00Z') + (Math.floor(game / 3) * 120 + (game % 3) * 24 + (game % 3 === 2 ? 24 : 0)) * 3600_000;
    const points = Math.max(0, Math.round(base * (b2b ? .75 : 1) + (uniform() - .5) * 8));
    return { id: `${player}-${game}`, sport: 'NBA' as const, playerId: `p${player}`, playerName: `Player ${player}`, sourcePlayerId: null,
      eventId: `e${player}-${game}`, occurredAt: new Date(at).toISOString(), metrics: { pts: points, minutes: 32 }, marketValues: {},
      sourceKind: 'BOX_SCORE' as never, sourceName: 'test', sourceUrl: 'https://example.test', sourceType: 'PUBLIC' as const,
      importedAt: '2029-12-01T00:00:00Z', modelVersion: null, line: null, direction: null, lineScore: null, dataConfidence: null };
  })).flat();
  const summary = backtestHistory(rows);
  const points = summary.byMarket['NBA:player_points']!;
  assert.ok(points.games > 500);
  assert.ok(points.v2.mae < points.edge.mae, `2.0 MAE ${points.v2.mae} vs current ${points.edge.mae}`);
  assert.ok(points.v2.logScore > points.edge.logScore);
  assert.equal(summary.acceptance['NBA:player_points'], points.v2Best);
  assert.equal(summary.acceptance['MLB:batter_hits'], null, 'no history for that market');
});
