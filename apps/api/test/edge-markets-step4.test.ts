import assert from 'node:assert/strict';
import test from 'node:test';
import { fairPrices, scorerFairPrices, shotsAudit, tennisTotalPrices } from '../src/context/sharp-props.js';
import type { GamePrice } from '../src/context/sharp-props.js';
import { canonicalMarket } from '../src/edge/market-map.js';
import { lineMarket, marketKey, segmentBase } from '../src/scrapers/markets.js';

// Step 4: markets the books price that Edge didn't read. Synthetic rows only.
const start = '2030-10-08T00:00:00Z';
const row = (extra: Record<string, unknown>) => ({ sportsbook: 'fanduel', league: 'nfl', event_id: 'g1', event_start_time: start,
  home_team: 'Home', away_team: 'Away', is_live: false, is_active: true, player_name: 'Test Receiver', ...extra });

test('4c: partial-game lines share one key across PrizePicks boards, Underdog/Pick6 labels and SharpAPI', () => {
  assert.equal(marketKey('NFL', '1H Rec Yards', 'underdog'), '1h_player_reception_yds');
  assert.equal(lineMarket({ league: 'NFL1H', stat: 'Rec Yards', marketKey: null, app: 'prizepicks' }), '1h_player_reception_yds');
  assert.deepEqual(segmentBase('NHL1P'), { sport: 'NHL', segment: '1P' });
  assert.equal(segmentBase('NFL'), null);
  assert.equal(canonicalMarket('NCAAFB', marketKey('NCAAFB', '1H Rush + Rec TD Scorer', 'pick6')), canonicalMarket('NCAAFB', '1h_anytime_tds'));
  const [price] = fairPrices([row({ market_type: '1st_half_player_receiving_yards', selection_type: 'over', line: 30.5, odds_probability: .52, odds_american: -110 }),
    row({ market_type: '1st_half_player_receiving_yards', selection_type: 'under', line: 30.5, odds_probability: .52, odds_american: -110 })]);
  assert.equal(price?.market, '1h_player_reception_yds', 'the segment stays in the key, never the full-game market');
  const [longest] = fairPrices([row({ market_type: 'player_longest_reception', selection_type: 'over', line: 21.5, odds_probability: .5 }),
    row({ market_type: 'player_longest_reception', selection_type: 'under', line: 21.5, odds_probability: .5 })]);
  assert.equal(longest?.market, 'player_reception_longest');
});

test('4a: anytime TD Yes prices de-vigged per game against expected rush + receiving TDs from the total', () => {
  // A 47.5 total priced 50/50 → 47.5 expected points → ~5 rush + rec TDs. 24 players; the book shades every Yes up by 30%.
  const rates = Array.from({ length: 24 }, (_, index) => .05 + .5 * ((index * 5) % 24) / 24);
  const scale = 47.5 * .105 / rates.reduce((a, b) => a + b, 0), fair = rates.map((rate) => 1 - Math.exp(-rate * scale));
  const rows = fair.map((p, index) => row({ market_type: 'anytime_touchdown_scorer', selection_type: 'other', line: null,
    player_name: `Player ${index}`, odds_probability: Math.min(.95, p * 1.3) }));
  const game = (side: 'over' | 'under'): GamePrice => ({ book: 'draftkings', league: 'nfl', sport: 'football', eventId: 'g1', home: 'Home',
    away: 'Away', startTime: start, market: 'total', line: 47.5, side, probability: .524, american: -110 });
  const prices = scorerFairPrices(rows, [game('over'), game('under')]);
  assert.equal(prices.length, 24);
  assert.deepEqual([prices[0]!.sport, prices[0]!.market, prices[0]!.line], ['NFL', 'anytime_tds', 0.5]);
  for (const [index, price] of prices.entries()) assert.ok(Math.abs(price.fairOver - fair[index]!) < .01, `player ${index}`);
  assert.equal(scorerFairPrices(rows.slice(0, 6), [game('over'), game('under')]).length, 0, 'an incomplete list is left out');
});

test('4d: tennis total games from the match total, for both players; 4e: NHL shots vs shots on goal compared before mapping', () => {
  const game = (side: 'over' | 'under', probability: number): GamePrice => ({ book: 'fanduel', league: 'atp', sport: 'tennis', eventId: 't1',
    home: 'Ana Player', away: 'Bea Player', startTime: start, market: 'total', line: 22.5, side, probability, american: -110 });
  const prices = tennisTotalPrices([game('over', .55), game('under', .5)]);
  assert.deepEqual(prices.map((price) => [price.player, price.market, price.line]), [['Ana Player', 'total_games', 22.5], ['Bea Player', 'total_games', 22.5]]);
  assert.equal(prices[0]!.fairOver, Math.round(.55 / 1.05 * 10_000) / 10_000);
  const nhl = (market: string, line: number, player = 'Skater A') => ({ sportsbook: 'fanduel', league: 'nhl', market_type: market, selection_type: 'over', line, player_name: player });
  const audit = shotsAudit([nhl('player_shots', 2.5), nhl('player_shots_on_goal', 2.5), nhl('player_shots', 3.5, 'Skater B'), nhl('player_shots_on_goal', 3.5, 'Skater B')]);
  assert.deepEqual([audit.players, audit.medianGap], [2, 0]);
});

test('4a follow-up: a TD group finds its game total by teams and date when the event ids differ', () => {
  const rates = Array.from({ length: 20 }, (_, index) => .08 + .4 * index / 20);
  const scale = 44.5 * .105 / rates.reduce((a, b) => a + b, 0);
  const rows = rates.map((rate, index) => row({ event_id: 'nfl_home_away_b2', market_type: 'anytime_touchdown_scorer', selection_type: 'other',
    line: null, player_name: `P${index}`, odds_probability: (1 - Math.exp(-rate * scale)) * 1.25 }));
  const game = (side: 'over' | 'under'): GamePrice => ({ book: 'fanduel', league: 'nfl', sport: 'football', eventId: 'nfl_home_away', home: 'Home',
    away: 'Away', startTime: start, market: 'total', line: 44.5, side, probability: .524, american: -110 });
  assert.equal(scorerFairPrices(rows, [game('over'), game('under')]).length, 20);
});

test('step 6: UFC total rounds for both fighters; KBO totals and run lines as game lines; uncovered sports say so', async () => {
  const { fightTotals, sharpGameLines } = await import('../src/context/sharp-props.js');
  const { uncoveredSport } = await import('../src/edge/service.js');
  const fight = (side: string, p: number) => ({ sportsbook: 'draftkings', league: 'ufc', event_id: 'f1', market_type: 'total_rounds', selection_type: side,
    line: 2.5, odds_probability: p, odds_american: -110, home_team: 'Fighter One', away_team: 'Fighter Two', event_start_time: start, is_live: false });
  const prices = fightTotals([fight('over', .6), fight('under', .45)]);
  assert.deepEqual(prices.map((price) => [price.player, price.sport, price.market, price.line]), [['Fighter One', 'OTHER', 'total_rounds', 2.5], ['Fighter Two', 'OTHER', 'total_rounds', 2.5]]);
  const kbo = (market: 'total' | 'spread', side: GamePrice['side'], line: number): GamePrice => ({ book: 'fanduel', league: 'kbo', sport: 'baseball',
    eventId: 'k1', home: 'Home K', away: 'Away K', startTime: start, market, line, side, probability: .5, american: -110 });
  assert.deepEqual(sharpGameLines([kbo('total', 'over', 9.5), kbo('total', 'under', 9.5), kbo('spread', 'home', -1.5), kbo('spread', 'away', 1.5)])
    .map((line) => [line.league, line.market, line.line]), [['KBO', 'total', 9.5], ['KBO', 'spread', -1.5]]);
  assert.ok(uncoveredSport({ sport: 'OTHER', league: 'EUROGOLF' }) && uncoveredSport({ sport: 'OTHER', league: 'NPB' }) && uncoveredSport({ sport: 'DARTS', league: 'PDC' }));
  assert.equal(uncoveredSport({ sport: 'OTHER', league: 'UFC' }), false);
});

test('step 7: the stale replay sums alerts, closing-line value and win rate; a seeded tracker sees the first refresh’s move', async () => {
  const { staleSummary } = await import('../src/edge/service.js');
  assert.deepEqual(staleSummary([{ probability: .6, closeProbability: .64, outcome: 'WIN' }, { probability: .58, closeProbability: .56, outcome: 'LOSS' },
    { probability: .61, closeProbability: null, outcome: null }]), { alerts: 3, closed: 2, averageClv: .01, graded: 2, winRate: .5 });
  assert.deepEqual(staleSummary([]), { alerts: 0, closed: 0, averageClv: null, graded: 0, winRate: null });
  const { MovementTracker } = await import('../src/edge/movement.js');
  const tracker = new MovementTracker();
  const price = (book: string, line: number) => ({ book, sport: 'NBA' as const, player: 'Alpha Guard', market: 'player_points', line, fairOver: .5,
    overAmerican: -110, underAmerican: -110, startTime: start, home: 'Home', away: 'Away' });
  const t0 = Date.parse('2030-10-07T20:00:00Z');
  // The saved prices seed the tracker at startup; the first live refresh then shows three books moving: steam.
  tracker.observe(['draftkings', 'fanduel', 'hardrock'].map((book) => price(book, 20.5)), t0);
  assert.equal(tracker.observe(['draftkings', 'fanduel', 'hardrock'].map((book) => price(book, 23.5)), t0 + 15 * 60_000), 3);
  assert.equal(tracker.summary('NBA', 'Alpha Guard', 'player_points', t0 + 16 * 60_000)?.steam, true);
});

test('step 8: soccer under any league label, college basketball and Underdog stat names reach a box-score reader; splits never', async () => {
  const { boxScoreReader } = await import('../src/box-score-results.js');
  const line = (sport: string, league: string, market: string) => ({ id: 'l', provider: 'prizepicks', sourceLineId: 'l', sourceLineIdIsSynthetic: false,
    sport, league, eventId: 'e', eventName: 'A @ H', eventStartTime: start, playerId: 'p', playerName: 'P', team: null, opponent: null, market,
    threshold: 1.5, availableDirections: ['MORE'], lineType: 'REGULAR', fetchedAt: start }) as never;
  assert.ok(boxScoreReader(line('SOCCER', 'LA LIGA', 'shots')), 'soccer graded whatever the league label');
  assert.ok(boxScoreReader(line('NCAAB', 'CBB', 'player_points')));
  assert.ok(boxScoreReader(line('NFL', 'NFL', 'rush_plus_rec_tds')) ?? boxScoreReader(line('NFL', 'NFL', 'anytime_tds')), 'canonical stat name');
  assert.equal(boxScoreReader(line('NFL', 'NFL1H', 'player_reception_yds')), null, 'a 1st-half board is never graded from full-game stats');
  assert.equal(boxScoreReader(line('NFL', 'NFL', '1h_player_reception_yds')), null);
});

test('step 9: lopsided +EV two refreshes running flags a platform; two balanced ones clear it; tennis games rungs off the books’ numbers aren’t ranked', async () => {
  const { nextSideBias } = await import('../src/edge/service.js');
  const pick = (side: 'MORE' | 'LESS', market = 'total_games') => ({ edge: .05, rating: 'VALUE' as const, side, sport: 'TENNIS' as const, market });
  const lopsided = [...Array.from({ length: 9 }, () => pick('LESS')), pick('MORE')];
  let bias = nextSideBias(null, lopsided);
  assert.deepEqual([bias.streak, bias.side, bias.share], [1, 'LESS', .9]);
  bias = nextSideBias(bias, lopsided);
  assert.equal(bias.streak, 2, 'flagged');
  assert.deepEqual(bias.markets, { 'TENNIS:total_games': 9 });
  const balanced = [...Array.from({ length: 6 }, () => pick('LESS')), ...Array.from({ length: 5 }, () => pick('MORE'))];
  bias = nextSideBias(nextSideBias(bias, balanced), balanced);
  assert.deepEqual([bias.streak, bias.clean], [0, 2], 'cleared after two balanced refreshes');
  assert.equal(nextSideBias(null, [pick('LESS')]).share, null, 'too few +EV picks to judge');

  const { priceBoard } = await import('@crowniq/edge');
  const tennis = { id: 't', provider: 'prizepicks', sourceLineId: 't', sourceLineIdIsSynthetic: false, sport: 'TENNIS', league: 'TENNIS', eventId: 'm',
    eventName: 'A vs B', eventStartTime: start, playerId: 'p', playerName: 'Ana Player', team: null, opponent: null, market: 'total_games', threshold: 26.5,
    availableDirections: ['MORE', 'LESS'], lineType: 'REGULAR', fetchedAt: '2030-10-07T12:00:00Z' } as never;
  const quote = (book: string) => ({ bookmaker: book, sport: 'TENNIS', eventId: 'm', sourceMarketKey: 'total_games', market: 'total_games',
    playerName: 'Ana Player', point: 22.5, overPrice: 1.91, underPrice: 1.91, fetchedAt: '2030-10-07T12:00:00Z' }) as never;
  const [read] = priceBoard({ lines: [tennis], quotes: [quote('fanduel'), quote('draftkings')], now: new Date('2030-10-07T12:00:00Z'),
    platform: 'hardrock', sidePayout: () => ({ kind: 'ODDS', decimal: 1.4 }) }).picks;
  assert.equal(read!.rating, 'NONE');
  assert.ok(read!.warnings.some((warning) => warning.includes('two humps')));
});

// Game totals as the book feed gives them (both sides, raw implied chance).
const totalsFrom = (events: readonly { id: string; home_team: string; away_team: string; point: number }[], league: string): GamePrice[] =>
  events.flatMap((event) => (['over', 'under'] as const).map((side) => ({ book: 'fanduel', league, sport: league === 'nfl' ? 'NFL' : 'NCAAFB',
    eventId: `book:${event.id}`, home: event.home_team, away: event.away_team, startTime: start, market: 'total' as const, line: event.point,
    side, probability: 1 / 1.91, american: null })));

test('TD totals: a second book total fills a game; the later-listed total wins where both exist', async () => {
  const event = (point: number) => [{ id: 'abc', home_team: 'Home', away_team: 'Away', point }];
  const odds = totalsFrom(event(47.5), 'nfl');
  const rates = Array.from({ length: 24 }, (_, index) => .05 + .5 * ((index * 5) % 24) / 24);
  const scale = 47.5 * .105 / rates.reduce((a, b) => a + b, 0), fair = rates.map((rate) => 1 - Math.exp(-rate * scale));
  const rows = fair.map((p, index) => row({ market_type: 'anytime_touchdown_scorer', selection_type: 'other', line: null,
    player_name: `Player ${index}`, odds_probability: Math.min(.95, p * 1.3) }));
  const filled = scorerFairPrices(rows, odds);
  assert.equal(filled.length, 24, 'the total prices the game');
  for (const [index, price] of filled.entries()) assert.ok(Math.abs(price.fairOver - fair[index]!) < .01);
  // A total of 40.5 for the same game listed after the 47.5 outranks it.
  const sharp = (side: 'over' | 'under'): GamePrice => ({ book: 'draftkings', league: 'nfl', sport: 'football', eventId: 'g1', home: 'Home',
    away: 'Away', startTime: start, market: 'total', line: 40.5, side, probability: .524, american: -110 });
  const both = scorerFairPrices(rows, [...totalsFrom(event(47.5), 'nfl'), sharp('over'), sharp('under')]);
  assert.ok(both[0]!.fairOver < filled[0]!.fairOver, 'fewer expected points, lower TD chances');
});

test('TD totals: team names that differ between sources still find their one game that day', async () => {
  const odds = totalsFrom([{ id: 'x', home_team: 'Detroit Lions', away_team: 'Arizona Cardinals', point: 47.5 }], 'nfl');
  const rates = Array.from({ length: 24 }, (_, index) => .05 + .5 * ((index * 5) % 24) / 24);
  const scale = 47.5 * .105 / rates.reduce((a, b) => a + b, 0), fair = rates.map((rate) => 1 - Math.exp(-rate * scale));
  const rows = fair.map((p, index) => row({ event_id: 'nfl_cardinals_lions_b2', home_team: 'Detroit Lions', away_team: 'ARI Cardinals',
    market_type: 'anytime_touchdown_scorer', selection_type: 'other', line: null, player_name: `Player ${index}`, odds_probability: Math.min(.95, p * 1.3) }));
  assert.equal(scorerFairPrices(rows, odds).length, 24);
  const college = rows.map((item) => ({ ...item, home_team: 'Georgia', away_team: 'Duke' }));
  assert.equal(scorerFairPrices(college, totalsFrom([{ id: 'y', home_team: 'Georgia Tech Yellow Jackets',
    away_team: 'Clemson Tigers', point: 47.5 }], 'ncaaf')).length, 0, 'Georgia is not Georgia Tech when the other team differs');
});
