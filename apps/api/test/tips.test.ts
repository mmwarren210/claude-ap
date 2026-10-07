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

test('tips: verdict by EV at the best known price; Pinnacle’s chance wins over Claude’s estimate', async () => {
  const { analysisFor } = await import('../src/tips.js');
  const opinion = { id: 'x', chance: .6, verdict: 'LEAN' as const, marketOdds: 120, oddsSource: 'FanDuel', event: null, start: null, reasons: [] };
  const withPinnacle = analysisFor({ odds: null, market_read: { chance: .4, event: 'A @ B', start, book: 'Pinnacle' } }, opinion, start);
  assert.deepEqual([withPinnacle.chance, withPinnacle.chanceSource, withPinnacle.ev, withPinnacle.verdict], [.4, 'Pinnacle', -.12, 'FADE']);
  const posted = analysisFor({ odds: -110, market_read: null }, opinion, start);
  assert.deepEqual([posted.priceSource, posted.ev, posted.verdict, posted.fairOdds], ['the post', .145, 'PLAY', -150]);
  assert.equal(analysisFor({ odds: null, market_read: null }, { ...opinion, marketOdds: null }, start).verdict, 'LEAN', 'no price: Claude’s verdict');
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
    analyze: async (tips) => tips.map((item) => ({ id: item.id, chance: item.selection === 'England' ? .8 : .5, verdict: 'PASS' as const,
      marketOdds: item.selection === 'England' ? -200 : null, oddsSource: 'DraftKings', event: 'England vs Latvia', start: '2030-10-07T18:45:00Z',
      reasons: ['Strong home form'] })),
    grade: async (tips) => tips.filter((item) => item.selection === 'England').map((item) => ({ id: item.id, status: 'WON' as const, result: 'England 3–0 Latvia' })),
  };
  const store = new TipStore(join(folder, 'tips.json'), () => clock);
  const product = new ProductLedger(join(folder, 'product.json'));
  const owner = await product.register('tips@example.org', 'long-private-passphrase', 'Tipper_1');
  const app = buildServer({ product, clock: () => clock, ownerPublicId: owner.profile.publicId, tips: { store, reader, grader: null } });
  try {
    const { token } = owner;
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject('/v1/tips')).statusCode, 401);
    const upload = await app.inject({ method: 'POST', url: '/v1/tips/upload', headers: auth,
      payload: { image: { data: 'A'.repeat(200), mediaType: 'image/png' } } });
    assert.equal(upload.statusCode, 201);
    assert.equal(upload.json().source, 'bookie___bandit');
    // The analysis runs in the background; wait for it to land.
    let mine = (await app.inject({ url: '/v1/tips', headers: auth })).json();
    for (let tries = 0; tries < 50 && mine.tips.some((item: Tip) => item.analyzing); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20)); mine = (await app.inject({ url: '/v1/tips', headers: auth })).json();
    }
    const england = mine.tips.find((item: Tip) => item.selection === 'England');
    // 80% at -200 (1.5 decimal): EV +20% → PLAY; Kazakhstan has no price → Claude's own verdict.
    assert.deepEqual([england.analysis.verdict, england.analysis.ev, england.analysis.chanceSource, england.analysis.priceSource], ['PLAY', .2, 'Claude', 'DraftKings']);
    assert.equal(mine.tips.find((item: Tip) => item.selection === 'Kazakhstan').analysis.verdict, 'PASS');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/tips/recheck', headers: auth, payload: { ids: [england.id] } })).json().rechecking, 0, 'already read by the AI: never run again');
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
    const outsider = { authorization: `Bearer ${other.token}` };
    assert.equal((await app.inject({ url: '/v1/tips', headers: outsider })).statusCode, 404, 'owner-only for now');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/tips/upload', headers: outsider, payload: { text: 'Spain ML' } })).statusCode, 404);
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
  // Forced tool_choice is a 400 on this model (the owner's uploads failed with it): auto, with the prompt naming the tool.
  assert.deepEqual(sent!.tool_choice, { type: 'auto' });
  // Strict tools reject an enum next to a ['string', 'null'] type (a nullable enum must be anyOf): walk the schema.
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const item = node as { enum?: unknown; type?: unknown };
    assert.ok(!(item.enum && Array.isArray(item.type)), `enum with a type array: ${JSON.stringify(node)}`);
    for (const value of Object.values(node)) walk(value);
  };
  walk((sent as unknown as { tools: unknown[] }).tools);
  assert.deepEqual(await reader.grade([], '2030-10-08'), []);
  // A first answer that skips the tool gets one reminder, then the picks.
  let calls = 0;
  const shy = { messages: { create: async () => (++calls === 1 ? { content: [{ type: 'text', text: 'Here are the picks.' }] }
    : { content: [{ type: 'tool_use', name: 'report_tips', input: { source: null, tips: [draft('Spain', 'MONEYLINE')] } }] }) },
    beta: client.beta };
  assert.equal((await new ClaudeTipReader({ client: shy as never }).read({ text: 'Spain ML', today: '2030-10-07' })).tips.length, 1);
  assert.equal(calls, 2);
});
