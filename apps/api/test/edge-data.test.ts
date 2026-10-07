import assert from 'node:assert/strict';
import test from 'node:test';
import type { PropLine } from '@crowniq/contracts';
import type { FairPrice } from '../src/context/sharp-props.js';
import { canonicalMarket, matchBookPrices } from '../src/edge/market-map.js';
import { SnapshotStore } from '../src/edge/snapshots.js';
import type { SnapshotRow } from '../src/edge/snapshots.js';

const start = '2030-01-11T00:00:00Z';
let now = new Date('2030-01-10T12:00:00Z');

test('snapshots: a row only when a price changes; the close is the last price before the start', () => {
  const store = new SnapshotStore(null, () => now);
  const row = (price: number, at: string): SnapshotRow => ({ observedAt: at, source: 'sharpapi', platform: 'draftkings',
    eventKey: 'NBA|home|away|2030-01-11T00', playerKey: 'NBA|alpha guard', market: 'player_points', number: 20.5, side: 'MORE',
    price, startTime: start });
  assert.equal(store.record([row(1.9, '2030-01-10T12:00:00Z')]), 1);
  assert.equal(store.record([row(1.9, '2030-01-10T13:00:00Z')]), 0, 'unchanged: no new row');
  now = new Date('2030-01-10T23:30:00Z');
  assert.equal(store.record([row(1.8, '2030-01-10T23:30:00Z')]), 1);
  const closing = store.closing('NBA|home|away|2030-01-11T00');
  assert.deepEqual(closing.map((item) => [item.price, item.closedAt]), [[1.8, '2030-01-10T23:30:00Z']]);
  assert.equal(store.history('NBA|alpha guard', 'player_points').length, 2);
  now = new Date('2030-01-11T01:00:00Z');
  assert.equal(store.record([row(1.5, '2030-01-11T01:00:00Z')]), 0, 'started games are frozen');
  assert.equal(store.status().rows, 2);
});

const line = (id: string, options: Partial<PropLine> = {}): PropLine => ({ id, provider: 'prizepicks', sourceLineId: id,
  sourceLineIdIsSynthetic: false, sport: 'MLB', league: 'MLB', eventId: 'g1', eventName: 'NYY @ TB', eventStartTime: start,
  playerId: 'p1', playerName: 'Freddy Peralta', team: null, opponent: null, homeTeam: 'Tampa Bay Rays', awayTeam: 'New York Yankees',
  market: 'pitcher_earned_runs', threshold: 1.5, availableDirections: ['MORE', 'LESS'], lineType: 'REGULAR',
  fetchedAt: start, ...options });
const price = (options: Partial<FairPrice> = {}): FairPrice => ({ book: 'draftkings', sport: 'MLB', player: 'Freddy Peralta',
  market: 'earned_runs', line: 1.5, fairOver: 0.5, overAmerican: -120, underAmerican: 100, startTime: start,
  home: 'Tampa Bay Rays', away: 'New York Yankees', ...options });

test('identity: one market table, events within 6 hours with a matching team, ambiguity and mismatches left out', () => {
  assert.equal(canonicalMarket('MLB', 'earned_runs'), 'pitcher_earned_runs');
  const matched = matchBookPrices([line('l1')], [price(), price({ book: 'prizepicks' })], start, ['prizepicks']);
  assert.equal(matched.quotes.length, 1, 'SharpAPI earned_runs matches the board’s pitcher_earned_runs; PrizePicks excluded');
  assert.equal(matched.report.linesMatched, 1);
  // The same name in two games at once can't be told apart.
  const twin = matchBookPrices([line('l1'), line('l2', { eventId: 'g2', homeTeam: 'Tampa Bay Rays', awayTeam: 'Boston Red Sox' })],
    [price()], start);
  assert.equal(twin.report.ambiguous, 1);
  assert.equal(twin.quotes.length, 0);
  // Another team, or a day later: no event.
  assert.equal(matchBookPrices([line('l1')], [price({ home: 'Seattle Mariners', away: 'Houston Astros', startTime: '2030-01-11T02:00:00Z' })],
    start).report.noEvent, 1, 'other teams two hours away');
  assert.equal(matchBookPrices([line('l1', { homeTeam: 'Trojans', awayTeam: 'Golden Eagles' })],
    [price({ home: 'Troy', away: 'Southern Miss' })], start).quotes.length, 1, 'same start: nicknames vs school names');
  assert.equal(matchBookPrices([line('l1')], [price({ startTime: '2030-01-12T00:00:00Z' })], start).report.noEvent, 1);
  // A book line far from the board's number is a different stat, not an edge.
  const far = matchBookPrices([line('l1')], [price({ line: 9.5 })], start);
  assert.equal(far.report.mismatches, 1);
  assert.equal(far.quotes.length, 0);
});

test('9b: a promo line is checked at its original number, or not at all without one; it never anchors another app', async () => {
  const promo = line('p6', { threshold: 0.5 });
  const moved = matchBookPrices([promo], [price({ line: 9.5 })], start, [], new Map([['p6', 9.5]]));
  assert.equal(moved.report.mismatches, 0);
  assert.equal(moved.quotes.length, 1);
  assert.equal(matchBookPrices([promo], [price({ line: 9.5 })], start, [], new Map([['p6', 0.25]])).report.mismatches, 1,
    'a book far from the original number is still a mismatch');
  assert.equal(matchBookPrices([promo], [price({ line: 9.5 })], start, [], new Map([['p6', null]])).report.mismatches, 0);
  assert.equal(matchBookPrices([promo], [price({ line: 9.5 })], start).report.mismatches, 1, 'without the promo flag it is a mismatch');
  const { appLines } = await import('../src/edge/platform-lines.js');
  const { dfsAnchors } = await import('../src/edge/service.js');
  const stored = (id: string, value: number, promoLine?: number) => ({ app: 'pick6', appLineId: id, league: 'NFL', gameId: 'g1',
    player: 'Dak Prescott', team: 'DAL', teamName: null, opponent: 'PHI', stat: 'Passing Yards', line: value, tier: 'REGULAR',
    directions: ['MORE', 'LESS'], startTime: start, imageUrl: null, home: { abbreviation: 'DAL', name: 'Dallas Cowboys' },
    away: { abbreviation: 'PHI', name: 'Philadelphia Eagles' }, multipliers: { MORE: 1.8, LESS: 1.8 },
    ...(promoLine !== undefined ? { promo: { gimme: false, originalLine: promoLine } } : {}) });
  const built = appLines([stored('a', 0.5, 265.5), stored('b', 265.5)] as never, 'pick6', start);
  assert.deepEqual([...built.promos], [['pick6:a', 265.5]]);
  assert.match(String((built.payouts.get('pick6:a')?.MORE as { blocked?: string } | undefined)?.blocked), /promo/);
  assert.equal((built.payouts.get('pick6:b')?.MORE as { blocked?: string } | undefined)?.blocked, undefined);
  const anchors = dfsAnchors([{ platform: 'pick6', lines: built.lines, promos: built.promos }]);
  assert.deepEqual([...anchors.values()].flatMap((byApp) => [...byApp.values()].flat()), [265.5]);
});

test('identity: board abbreviations match full names; one game within 3 hours matches when teams can’t be compared', async () => {
  const { teamsMatch } = await import('../src/edge/market-map.js');
  assert.equal(teamsMatch('NYY', 'New York Yankees'), true);
  assert.equal(teamsMatch('TB', 'Tampa Bay Rays'), true);
  assert.equal(teamsMatch('LAD', 'Los Angeles Dodgers'), true);
  assert.equal(teamsMatch('NYY', 'New York Mets'), false);
  const abbreviated = matchBookPrices([line('l1', { homeTeam: 'TB', awayTeam: 'NYY' })], [price()], start);
  assert.equal(abbreviated.quotes.length, 1);
  const tennis = matchBookPrices([line('l1', { homeTeam: 'Sinner', awayTeam: 'Alcaraz' })],
    [price({ home: 'Jannik Sinner', away: 'Carlos Alcaraz', startTime: '2030-01-11T01:00:00Z' })], start);
  assert.equal(tennis.quotes.length, 1, 'one game for the player within three hours');
  const far = matchBookPrices([line('l1', { homeTeam: 'Seattle', awayTeam: 'Houston' })],
    [price({ home: 'Boston Red Sox', away: 'Texas Rangers', startTime: '2030-01-11T05:00:00Z' })], start);
  assert.equal(far.report.noEvent, 1, 'another team five hours away stays unmatched');
  assert.equal(far.report.noEventSamples.length, 1);
});

test('market audit: the scraper and the books use one key per stat; soccer leagues are soccer', async () => {
  const { canonicalMarket } = await import('../src/edge/market-map.js');
  const { leagueInfo } = await import('../src/scrapers/markets.js');
  assert.equal(canonicalMarket('WNBA', '3ptm'), canonicalMarket('WNBA', 'player_threes'));
  assert.equal(canonicalMarket('WNBA', 'pra'), canonicalMarket('WNBA', 'player_points_rebounds_assists'));
  assert.equal(canonicalMarket('NHL', 'player_assists'), canonicalMarket('NHL', 'assists'));
  assert.equal(canonicalMarket('TENNIS', 'total_games_won'), canonicalMarket('TENNIS', 'games_won'));
  assert.equal(canonicalMarket('MLB', 'po'), canonicalMarket('MLB', 'pitching_outs'));
  assert.equal(canonicalMarket('MLB', 'batter_runs_scored'), canonicalMarket('MLB', 'runs'));
  assert.equal(leagueInfo('LA LIGA').sport, 'SOCCER');
  assert.equal(leagueInfo('NHL1P').sport, 'OTHER', 'period lines stay apart from full-game');
});
