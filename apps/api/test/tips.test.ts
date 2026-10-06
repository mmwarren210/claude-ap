import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameLine } from '../src/context/feeds.js';
import { ProductLedger } from '../src/product-ledger.js';
import { buildServer } from '../src/server.js';
import { marketRead, sourceRecord, TipGrader, TipStore } from '../src/tips.js';
import type { Tip, TipDraft, TipReader } from '../src/tips.js';

// Synthetic tips and prices only.
const draft = (selection: string, market: TipDraft['market'], line: number | null = null, odds: number | null = null): TipDraft => ({
  text: `${selection} ${market}`, sport: 'SOCCER', league: null, selection, opponent: null, market, line, side: null, stat: null, odds, eventDate: null });
const start = '2030-10-07T18:45:00Z';
const game = (market: GameLine['market'], line: number | null, homeFair: number, awayFair: number): GameLine => ({ league: 'UEFA', home: 'Wales',
  away: 'Kazakhstan', startTime: start, market, line, homePrice: null, awayPrice: null, homeFair, awayFair, sourceUrl: null });

test('tips: Pinnacle chance for moneyline, team-or-draw, and a spread at Pinnacle’s number', () => {
  const lines = [game('moneyline', null, .7, .1), game('spread', -1.5, .45, .55)], from = Date.parse('2030-10-07T12:00:00Z');
  assert.equal(marketRead(draft('Wales', 'MONEYLINE'), lines, from)!.chance, .7);
  assert.equal(marketRead(draft('Kazakhstan', 'DOUBLE_CHANCE'), lines, from)!.chance, .3, 'win or draw: 0.1 + 0.2');
  assert.equal(marketRead(draft('Kazakhstan', 'SPREAD', 1.5), lines, from)!.chance, .55);
  assert.equal(marketRead(draft('Kazakhstan', 'SPREAD', 2.5), lines, from), null, 'not Pinnacle’s number');
  assert.equal(marketRead(draft('Iceland', 'MONEYLINE'), lines, from), null);
});

test('tips: a service’s record counts wins, units at the posted odds, and wins over what the market expected', () => {
  const tip = (status: Tip['status'], odds: number | null, chance: number | null) => ({ ...draft('X', 'MONEYLINE', null, odds), status,
    market_read: chance === null ? null : { chance, event: 'A @ B', start, book: 'Pinnacle' as const } }) as Tip;
  const record = sourceRecord([tip('WON', 150, .4), tip('LOST', -110, .6), tip('WON', null, .5), tip('PENDING', null, null)]);
  assert.deepEqual([record.won, record.lost, record.pending, record.hitRate], [2, 1, 1, .667]);
  assert.equal(record.units, .5, '+1.5 then −1');
  assert.equal(record.vsMarket, .5, '2 wins against 1.5 expected');
});

test('tips routes: upload a screenshot, see it under its service, mark and remove; grading settles finished games', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-tips-'));
  let clock = new Date('2030-10-07T12:00:00Z');
  const reader: TipReader = {
    read: async () => ({ source: 'bookie___bandit', tips: [draft('Kazakhstan', 'SPREAD', 1.5), draft('England', 'MONEYLINE')] }),
    grade: async (tips) => tips.filter((item) => item.selection === 'England').map((item) => ({ id: item.id, status: 'WON' as const, result: 'England 3–0 Latvia' })),
  };
  const store = new TipStore(join(folder, 'tips.json'), () => clock);
  const product = new ProductLedger(join(folder, 'product.json'));
  const app = buildServer({ product, clock: () => clock, tips: { store, reader, grader: null } });
  try {
    const { token } = await product.register('tips@example.org', 'long-private-passphrase', 'Tipper_1');
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject('/v1/tips')).statusCode, 401);
    const upload = await app.inject({ method: 'POST', url: '/v1/tips/upload', headers: auth,
      payload: { image: { data: 'A'.repeat(200), mediaType: 'image/png' } } });
    assert.equal(upload.statusCode, 201);
    assert.equal(upload.json().source, 'bookie___bandit');
    const mine = (await app.inject({ url: '/v1/tips', headers: auth })).json();
    assert.equal(mine.tips.length, 2);
    assert.equal(mine.sources.bookie___bandit.pending, 2);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/tips/upload', headers: auth, payload: {} })).statusCode, 400);
    const kaz = mine.tips.find((item: Tip) => item.selection === 'Kazakhstan');
    assert.equal((await app.inject({ method: 'PATCH', url: `/v1/tips/${kaz.id}`, headers: auth, payload: { status: 'LOST', source: 'Bandit' } })).statusCode, 200);
    clock = new Date('2030-10-08T16:00:00Z');
    assert.equal(await new TipGrader(store, reader, () => clock).runOnce(), 1);
    const after = (await app.inject({ url: '/v1/tips', headers: auth })).json();
    assert.deepEqual([after.sources.Bandit.won, after.sources.Bandit.lost, after.sources.Bandit.pending], [1, 1, 0]);
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/tips/${kaz.id}`, headers: auth })).statusCode, 200);
    const other = await product.register('other@example.org', 'another-private-password', 'Other_2');
    assert.equal((await app.inject({ url: '/v1/tips', headers: { authorization: `Bearer ${other.token}` } })).json().tips.length, 0, 'tips are private');
  } finally { await app.close(); await rm(folder, { recursive: true, force: true, maxRetries: 5 }); }
});

test('Claude tip reader sends the screenshot and reads the strict tool output', async () => {
  const { ClaudeTipReader } = await import('../src/claude-tips.js');
  let sent: { messages: { content: { type: string }[] }[]; tool_choice: unknown } | null = null;
  const client = { messages: { create: async (body: never) => { sent = body;
    return { content: [{ type: 'tool_use', name: 'report_tips', input: { source: ' bookie___bandit ', tips: [draft('Spain', 'MONEYLINE'), { ...draft('', 'OTHER') }] } }] }; } },
    beta: { messages: { create: async () => ({ content: [], stop_reason: 'end_turn' }) } } };
  const reader = new ClaudeTipReader({ client: client as never });
  const read = await reader.read({ image: { data: 'AAAA', mediaType: 'image/png' }, today: '2030-10-07' });
  assert.equal(read.source, 'bookie___bandit');
  assert.deepEqual(read.tips.map((tip) => tip.selection), ['Spain'], 'blank rows dropped');
  assert.equal(sent!.messages[0]!.content[0]!.type, 'image');
  assert.deepEqual(sent!.tool_choice, { type: 'tool', name: 'report_tips' });
  assert.deepEqual(await reader.grade([], '2030-10-08'), []);
});
