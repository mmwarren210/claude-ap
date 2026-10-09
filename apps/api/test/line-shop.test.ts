import assert from 'node:assert/strict';
import test from 'node:test';
import type { PropLine } from '@crowniq/contracts';
import type { AppLine } from '../src/app-boards.js';
import type { FairPrice } from '../src/context/sharp-props.js';
import { lineShop } from '../src/line-shop.js';

const now = new Date('2030-10-05T12:00:00Z'), start = '2030-10-05T20:00:00Z';
const pp = (id: string, threshold: number, lineType = 'REGULAR') => ({ id, sport: 'NFL', league: 'NFL', playerName: 'Sam Receiver',
  playerId: 'NFL:sam', team: 'BUF', market: 'player_receptions', threshold, lineType, availableDirections: lineType === 'REGULAR'
    ? ['MORE', 'LESS'] : ['MORE'], eventStartTime: start, eventId: 'e1' }) as unknown as PropLine;
const app = (source: 'underdog' | 'pick6', threshold: number, multipliers: AppLine['multipliers'] = null) => ({ id: `${source}:1`, app: source,
  sport: 'NFL', league: 'NFL', playerName: 'Sam Receiver', team: 'BUF', market: 'player_receptions', threshold, lineType: 'REGULAR',
  availableDirections: ['MORE', 'LESS'], multipliers, eventStartTime: start, eventName: 'MIA @ BUF' }) as unknown as AppLine;
const price = (book: string, line: number, fairOver: number): FairPrice => ({ book, sport: 'NFL', player: 'Sam Receiver',
  market: 'player_receptions', line, fairOver, overAmerican: -110, underAmerican: -110, startTime: start, home: null, away: null } as FairPrice);

test('line shop: every app number, easiest per side, the books line, and where GKR’s side is easiest', () => {
  const entries = lineShop([pp('pp1', 5.5), pp('gob', 3.5, 'GOBLIN')], [app('underdog', 4.5), app('pick6', 5.5, { MORE: 1.1 })],
    [price('draftkings', 5.5, 0.48), price('hardrock', 5.5, 0.5), price('hardrock', 4.5, 0.62)],
    new Map([['pp1', { side: 'MORE' as const, by: 'GKR' as const, score: 84 }]]), now);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.deepEqual(entry.offers.map((offer) => `${offer.source}:${offer.threshold}`), ['underdog:4.5', 'prizepicks:5.5', 'pick6:5.5'],
    'the Goblin is left out: its payout differs');
  assert.deepEqual(entry.bestMore, { source: 'underdog', threshold: 4.5 });
  assert.deepEqual(entry.bestLess, { source: 'prizepicks', threshold: 5.5 }, 'a tie with equal payouts keeps the first listed');
  assert.equal(entry.spread, 1);
  assert.equal(entry.booksLine, 5.5);
  assert.equal(entry.booksOver, 0.49);
  assert.deepEqual(entry.pick, { side: 'MORE', by: 'GKR', score: 84, best: { source: 'underdog', threshold: 4.5 } });
});

test('line shop: one app alone with no sportsbook is not worth shopping; started games drop', () => {
  assert.equal(lineShop([pp('pp1', 5.5)], [], [], new Map(), now).length, 0);
  assert.equal(lineShop([pp('pp1', 5.5)], [app('underdog', 4.5)], [], new Map(), new Date('2030-10-05T21:00:00Z')).length, 0);
});

test('line shop: an app ladder (Pick6 alternates) shows one main line per app, so alternates never make a gap', () => {
  const alt = (threshold: number) => ({ ...app('pick6', threshold), id: `pick6:${threshold}`, availableDirections: ['MORE'] }) as unknown as AppLine;
  const entries = lineShop([pp('pp1', 5.5)], [app('pick6', 5.5), alt(2.5), alt(8.5), alt(10.5)],
    [price('draftkings', 5.5, 0.5)], new Map(), now);
  assert.deepEqual(entries[0]!.offers.map((offer) => `${offer.source}:${offer.threshold}`), ['prizepicks:5.5', 'pick6:5.5']);
  assert.equal(entries[0]!.spread, 0);
});
