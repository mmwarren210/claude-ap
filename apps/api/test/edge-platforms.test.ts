import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoardResponse, PropLine } from '@crowniq/contracts';
import { DEFAULT_PAYOUTS } from '@crowniq/contracts';
import type { FairPrice } from '../src/context/sharp-props.js';
import type { StoredLine } from '../src/scrapers/line-store.js';
import { EdgeService } from '../src/edge/service.js';

// Synthetic boards only: nothing here is a real line or price.
const now = new Date('2030-01-10T12:00:00Z'), start = '2030-01-11T00:00:00Z';
const players = ['Alpha Guard', 'Bravo Wing', 'Charlie Big', 'Delta Forward'];
const ppLine = (name: string, index: number): PropLine => ({ id: `pp-${index}`, provider: 'prizepicks', sourceLineId: `s${index}`,
  sourceLineIdIsSynthetic: false, sport: 'NBA', league: 'NBA', eventId: index < 2 ? 'g-a' : 'g-b', eventName: 'A @ B', eventStartTime: start,
  playerId: `p${index}`, playerName: name, team: null, opponent: null, homeTeam: index < 2 ? 'Home A' : 'Home B',
  awayTeam: index < 2 ? 'Away A' : 'Away B', market: 'player_points', threshold: 20.5, availableDirections: ['MORE', 'LESS'],
  lineType: 'REGULAR', fetchedAt: start });
const board = { board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines: players.map(ppLine) }, analyses: [],
  builtAt: now.toISOString() } as unknown as BoardResponse;
const price = (book: string, name: string, index: number, line: number, over: number, under: number): FairPrice => ({ book, sport: 'NBA',
  player: name, market: 'player_points', line, fairOver: .5, overAmerican: over, underAmerican: under, startTime: start,
  home: index < 2 ? 'Home A' : 'Home B', away: index < 2 ? 'Away A' : 'Away B', observedAt: now.toISOString() });
const prices = players.flatMap((name, index) => [price('fanduel', name, index, 23.5, -115, -105), price('betrivers', name, index, 23.5, -120, 100),
  price('draftkings', name, index, 20.5, 150, -180), price('hardrock', name, index, 22.5, 120, -150)]);
const stored = (app: 'underdog' | 'pick6' | 'dabble', name: string, index: number, multipliers: Record<string, number>, gimme = false): StoredLine => ({
  app, appLineId: `${app}-${index}`, league: 'NBA', gameId: index < 2 ? 'g-a' : 'g-b', player: name, team: null, teamName: null, opponent: null,
  stat: 'Points', marketKey: 'player_points', line: 20.5, tier: 'REGULAR', directions: ['MORE', 'LESS'], startTime: start, imageUrl: null,
  home: { abbreviation: index < 2 ? 'HA' : 'HB', name: index < 2 ? 'Home A' : 'Home B' }, away: { abbreviation: 'AW', name: index < 2 ? 'Away A' : 'Away B' },
  multipliers, ...(gimme ? { promo: { gimme: true, originalLine: null } } : {}),
  firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), confirmedBy: ['zen'] } as unknown as StoredLine);

test('Edge P2: every platform priced against its own payout, a platform never prices itself', async () => {
  const service = new EdgeService({ board: () => board, payouts: DEFAULT_PAYOUTS, clock: () => now,
    sharp: { prices: async () => prices, pickem: async () => [] },
    appBoards: { active: async (app) => players.map((name, index) => stored(app as 'underdog' | 'pick6' | 'dabble', name, index,
      app === 'underdog' ? { MORE: index === 0 ? 1.1 : 1, LESS: 1 } : { MORE: 1, LESS: 1 }, app === 'pick6' && index === 1)) } });
  const [pp, ud, p6, dk, hr] = await Promise.all((['prizepicks', 'underdog', 'pick6', 'draftkings', 'hardrock'] as const)
    .map((platform) => service.snapshot(platform)));
  assert.equal(pp!.response.picks.length, 4);
  assert.ok(pp!.response.picks.every((pick) => pick.side === 'MORE' && pick.edge! > 0), 'books put these players over 20.5');
  // Underdog: the 1.1× pick needs the entry's break-even divided by 1.1.
  const boosted = ud!.response.picks.find((pick) => pick.playerName === 'Alpha Guard')!;
  assert.equal(boosted.payoutMultiplier, 1.1);
  assert.ok(Math.abs(boosted.breakEven - ud!.response.referenceEntry.breakEven / 1.1) < 1e-3);
  // DK Pick'em: no confirmed chart, so chances but no edges (and the gimme is a promo).
  assert.ok(p6!.response.picks.length > 0 && p6!.response.picks.every((pick) => pick.edge === null));
  // DraftKings: its own price never counts; each side against its own odds, with EV and Kelly.
  assert.ok(dk!.response.picks.every((pick) => pick.decimalOdds && pick.ev !== undefined && pick.kelly !== undefined));
  assert.ok(dk!.response.picks.every((pick) => pick.sources.market?.books.every((quote) => quote.bookmaker !== 'draftkings')));
  assert.ok(hr!.response.picks.every((pick) => pick.sources.market?.books.every((quote) => quote.bookmaker !== 'hardrock')));
  assert.equal(dk!.response.entries[0]!.type, 'PARLAY');
  assert.equal(hr!.response.entries.at(-1)!.size, 20);
  assert.equal(service.status().reports.draftkings!.platform, 'draftkings');
  // Dabble: priced against its own all-hit chart (2 picks pay 3x, so each needs about 57.7%).
  const db = await service.snapshot('dabble');
  assert.ok(db!.response.picks.length > 0 && db!.response.picks.every((pick) => pick.edge !== null));
  assert.ok(Math.abs(db!.response.entries.find((entry) => entry.size === 2)!.breakEven - Math.sqrt(1 / 3)) < 1e-3);
  // A pick'em app with no chart at all still gets chances only (no payout is invented).
  const bare = new EdgeService({ board: () => board, payouts: { ...DEFAULT_PAYOUTS, dabble: { POWER: {}, FLEX: {} } }, clock: () => now,
    sharp: { prices: async () => prices, pickem: async () => [] },
    appBoards: { active: async (app) => players.map((name, index) => stored(app as 'dabble', name, index, { MORE: 1, LESS: 1 })) } });
  assert.ok((await bare.snapshot('dabble'))!.response.picks.every((pick) => pick.edge === null && pick.rating === 'NONE'));
});

test('after a restart the first Edge pass is quick (shown, not recorded) and the full pass follows on the next call', async () => {
  const recorded: number[] = [];
  let slow = true;
  const service = new EdgeService({ board: () => board, payouts: DEFAULT_PAYOUTS, clock: () => now,
    sharp: { prices: async () => prices, pickem: async () => [] },
    // A slow history lookup (as just after a restart) on the first pass only.
    values: () => slow ? new Promise(() => undefined) : Promise.resolve(null),
    ledger: { record: async (picks: readonly unknown[]) => { recorded.push(picks.length); }, calibrationRows: async () => [],
      weakTiers: async () => new Set<string>(), honesty: async () => new Map<string, number>(), byIds: async () => new Map() } as never });
  const started = Date.now();
  const first = await service.snapshot('prizepicks');
  assert.ok(first && first.response.picks.length > 0, 'picks show without waiting for history');
  assert.ok(Date.now() - started < 15_000);
  assert.deepEqual(recorded, [], 'the quick pass is never recorded');
  slow = false;
  await service.snapshot('prizepicks');
  await new Promise((done) => setTimeout(done, 50));
  for (let i = 0; i < 50 && !recorded.length; i++) { await service.snapshot('prizepicks'); await new Promise((done) => setTimeout(done, 20)); }
  assert.ok(recorded.length > 0, 'the full pass records');
});
