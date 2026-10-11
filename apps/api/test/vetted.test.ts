import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TipStore } from '../src/tips.js';

test('Vetted lists only PLAY tips and never the tipster, the post text or the uploader', async () => {
  const now = new Date('2026-10-11T12:00:00Z'), store = new TipStore(null, () => now);
  const draft = { text: 'From @SecretTipster: Lakers ML', sport: 'NBA', league: 'NBA', selection: 'Lakers', opponent: 'Celtics',
    market: 'MONEYLINE' as const, line: null, side: null, stat: null, odds: 120, eventDate: '2026-10-12' };
  const tips = await store.add('owner-account', 'SecretTipster', [draft, { ...draft, selection: 'Celtics' }], [null, null]);
  const analysis = (verdict: 'PLAY' | 'PASS') => ({ verdict, chance: .5, chanceSource: 'Claude' as const, price: 120, priceSource: 'the post',
    ev: .1, fairOdds: 100, reasons: ['Injury news'], event: 'Celtics at Lakers', start: null, analyzedAt: now.toISOString() });
  await store.setAnalyses(tips.map((tip) => tip.id), new Map([[tips[0].id, analysis('PLAY')], [tips[1].id, analysis('PASS')]]));
  const vetted = await store.vetted();
  assert.equal(vetted.picks.length, 1);
  assert.equal(vetted.picks[0].selection, 'Lakers');
  const json = JSON.stringify(vetted);
  assert.ok(!json.includes('SecretTipster') && !json.includes('owner-account') && !json.includes('From @'));
});

test('Vetted scoreboard: record, units at the price, streak', async () => {
  const now = new Date('2026-10-11T12:00:00Z'), store = new TipStore(null, () => now);
  const draft = { text: 'x', sport: 'NBA', league: 'NBA', selection: 'A', opponent: null, market: 'MONEYLINE' as const, line: null,
    side: null, stat: null, odds: 150, eventDate: null };
  const tips = await store.add('o', 's', [draft, draft, draft], [null, null, null]);
  const analysis = { verdict: 'PLAY' as const, chance: .5, chanceSource: 'Claude' as const, price: 150, priceSource: 'the post', ev: .25,
    fairOdds: 100, reasons: [], event: null, start: null, analyzedAt: now.toISOString() };
  await store.setAnalyses(tips.map((tip) => tip.id), new Map(tips.map((tip) => [tip.id, analysis])));
  await store.update('o', tips[0].id, { status: 'WON' });
  await store.update('o', tips[1].id, { status: 'LOST' });
  const { scoreboard } = await store.vetted();
  assert.equal(scoreboard.allTime.won, 1); assert.equal(scoreboard.allTime.lost, 1);
  assert.equal(scoreboard.allTime.units, 0.5);
  assert.equal(scoreboard.pending, 1);
  assert.equal(scoreboard.streak?.length, 1);
});
