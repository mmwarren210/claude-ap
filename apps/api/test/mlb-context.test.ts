import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { batterRate, leagueRates, MlbGames, mlbAdjustment, parseContext, pitcherMatchup, pitcherRates, proplineEventId, weatherFactor } from '../src/mlb-context.js';
import type { Game, PropLineHistory } from '../src/propline-history.js';
import type { PropLineClient } from '../src/scrapers/propline.js';

const raw = { home_team: 'Milwaukee Brewers', away_team: 'Los Angeles Dodgers', venue: 'American Family Field', roof_type: null, is_indoor: false,
  home_probable_pitcher: 'Home Ace', away_probable_pitcher: 'Away Arm', home_probable_pitcher_hand: 'R', away_probable_pitcher_hand: 'L',
  weather: { temperature_f: 90, precip_probability_pct: 70, wind_speed_mph: 4 } };
const start = (i: number, stats: Record<string, number>): Game => ({ at: new Date(Date.parse('2030-09-24T00:00:00Z') - (i + 1) * 5 * 86_400_000).toISOString(),
  opponent: null, stats: { pitcher_started: 1, ...stats } });
const average = Array.from({ length: 40 }, (_, i) => start(i, { outs: 18, hits_allowed: 6, walks_allowed: 2, strikeouts: 6, earned_runs: 3 }));
const leaky = Array.from({ length: 10 }, (_, i) => start(i, { outs: 15, hits_allowed: 10, walks_allowed: 3, strikeouts: 3, earned_runs: 6 }));

test('PropLine game context: open-air parks only count as outdoor, and the game id comes from the line', () => {
  assert.equal(proplineEventId('pp-game:propline:348401'), '348401');
  assert.equal(parseContext('1', raw)!.outdoor, true);
  assert.equal(parseContext('1', { ...raw, roof_type: 'Retractable' })!.outdoor, false, 'a retractable roof may be closed');
  assert.equal(parseContext('1', { ...raw, is_indoor: true, roof_type: 'Dome' })!.outdoor, false);
  assert.equal(batterRate('batter_hits'), 'hits');
  assert.equal(batterRate('hitter_ks'), 'strikeouts');
  assert.equal(batterRate('batter_home_runs'), 'earnedRuns');
  assert.equal(batterRate('sb'), null);
});

test('the opposing starter reads against the league, shrunk, and moves a batter\'s line but not a pitcher\'s', () => {
  const league = leagueRates([average, average])!;
  const rates = new Map([['away arm', pitcherRates('Away Arm', leaky, league, Date.parse('2030-09-24T00:00:00Z'))!]]);
  const game = parseContext('1', raw)!;
  const batter = fixtureLine({ sport: 'MLB', league: 'MLB', market: 'batter_hits', team: 'Milwaukee Brewers' });
  const read = pitcherMatchup(batter, batter.team, game, rates, league)!;
  assert.equal(read.pitcher, 'Away Arm', 'a home batter faces the away starter');
  assert.ok(read.ratio > 1.3 && read.ratio < 1.6, `leaky starter allows more hits (${read.ratio})`);
  assert.equal(pitcherMatchup({ market: 'pitcher_strikeouts' }, batter.team, game, rates, league), null);
  assert.equal(pitcherMatchup(batter, 'Milwaukee Brewers', game, new Map(), league), null, 'unknown starter');
  const adjustment = mlbAdjustment(batter, batter.team, game, rates, league)!;
  assert.ok(adjustment.factor > 1.1, 'starter (capped at +10%) and warm weather together');
  assert.ok(adjustment.reasons.some((reason) => reason.startsWith('Facing Away Arm (LHP)')));
  assert.ok(adjustment.reasons.some((reason) => /rain/.test(reason)));
});

test('warm air lifts home runs most, leaves strikeouts alone, and only outdoors', () => {
  const game = parseContext('1', raw)!;
  assert.equal(weatherFactor({ market: 'batter_home_runs' }, game)!.factor.toFixed(2), '1.12', 'capped at 12%');
  assert.equal(weatherFactor({ market: 'batter_total_bases' }, game)!.factor.toFixed(2), '1.04');
  assert.equal(weatherFactor({ market: 'pitcher_strikeouts' }, game), null);
  assert.equal(weatherFactor({ market: 'batter_home_runs' }, { ...game, outdoor: false }), null);
  assert.ok(weatherFactor({ market: 'batter_home_runs' }, { ...game, temperatureF: 50 })!.factor < 1);
});

test('MLB games refresh each game at most hourly and learn starters and batters\' teams from cached games', async () => {
  const asked: string[] = [];
  const client = { get: async (path: string) => { asked.push(path); return raw; } } as unknown as PropLineClient;
  const batterGames: Game[] = ['Chicago Cubs', 'Cincinnati Reds', 'St. Louis Cardinals'].map((away, i) => ({ at: `2030-09-2${i + 1}T00:00:00.000Z`,
    opponent: null, stats: { hits: 1, at_bats: 4 }, home: 'Milwaukee Brewers', away }));
  const history = { ready: async () => undefined, cachedGames: () => [average, average], cachedFor: async (line: { playerName: string }) =>
    line.playerName === 'Away Arm' ? leaky : line.playerName === 'Test Player' ? batterGames : null } as unknown as PropLineHistory;
  let now = new Date('2030-09-24T12:00:00Z');
  const games = new MlbGames(client, history, () => now);
  const line = fixtureLine({ sport: 'MLB', league: 'MLB', market: 'batter_hits', team: null, eventId: 'pp-game:propline:42', eventStartTime: '2030-09-25T00:00:00Z' });
  await games.refresh([line]);
  await games.refresh([line]);
  assert.equal(asked.length, 1, 'asked once within the hour');
  assert.equal(games.matchup(line)?.pitcher, 'Away Arm', 'the batter\'s team comes from his cached games');
  assert.ok(games.adjustment(line)!.factor > 1);
  now = new Date('2030-09-24T13:30:00Z');
  await games.refresh([line]);
  assert.equal(asked.length, 2);
  assert.equal(games.context('pp-game:other:1'), null);
});

test('a pitching stat PropLine didn\'t record is unknown, not zero', () => {
  const partial = Array.from({ length: 30 }, (_, i) => start(i, i % 2 ? { outs: 18, hits_allowed: 6, walks_allowed: 2, strikeouts: 6, earned_runs: 3 }
    : { outs: 18, hits_allowed: 6, strikeouts: 6, earned_runs: 3 }));
  const league = leagueRates([partial, average])!;
  assert.equal(league.walks.toFixed(3), (2 / 26).toFixed(3), 'starts without a walks entry are left out');
  assert.equal(league.strikeouts.toFixed(3), (6 / 26).toFixed(3));
});
