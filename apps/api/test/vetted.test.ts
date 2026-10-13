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
  const tips = await store.add('o', 's', [draft, { ...draft, selection: 'B' }, { ...draft, selection: 'C' }], [null, null, null]);
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

test('duplicates are never re-checked or re-graded, Vetted shows them once with the first submitter', async () => {
  const { analyzeTips } = await import('../src/tips.js');
  const now = new Date('2026-10-11T12:00:00Z'), store = new TipStore(null, () => now);
  const draft = { text: 'x', sport: 'NBA', league: 'NBA', selection: 'Lakers', opponent: 'Celtics', market: 'MONEYLINE' as const,
    line: null, side: null, stat: null, odds: 120, eventDate: '2026-10-12' };
  let analyzed = 0;
  const reader = { read: async () => ({ source: null, tips: [] }), grade: async () => [],
    analyze: async (tips: readonly { id: string }[]) => { analyzed += tips.length;
      return tips.map((tip) => ({ id: tip.id, chance: .55, verdict: 'PLAY' as const, marketOdds: 120, oddsSource: null, event: null, start: null, reasons: [] })); } };
  const first = await store.add('a', 'svc', [draft, draft], [null, null], 'alice');
  await analyzeTips(store, reader, first, () => now);
  assert.equal(analyzed, 1, 'the same pick twice in one upload is checked once');
  const second = await store.add('b', 'svc', [draft], [null], 'bob');
  await analyzeTips(store, reader, second, () => now);
  assert.equal(analyzed, 1, 'a later upload of the same pick reuses the verdict');
  const vetted = await store.vetted();
  assert.equal(vetted.picks.length, 1);
  assert.equal(vetted.picks[0].submittedBy, 'alice');
  const settled = await store.settle([{ id: first[0].id, status: 'WON', result: 'Lakers won' }]);
  assert.equal(settled, 3, 'one grade settles every copy');
});

test('a PLAY that Edge calls FADE at the tip price stays out of Vetted (owner sees it as hidden); a PASS stays with its check', async () => {
  const now = new Date('2026-10-11T12:00:00Z'), store = new TipStore(null, () => now);
  const prop = { text: 'x', sport: 'NBA', league: 'NBA', selection: 'LeBron James', opponent: null, market: 'PLAYER_PROP' as const,
    line: 25.5, side: 'OVER' as const, stat: 'points', odds: null, eventDate: '2026-10-12' };
  const tips = await store.add('o', 's', [prop, { ...prop, selection: 'Anthony Davis' }], [null, null]);
  const analysis = { verdict: 'PLAY' as const, chance: .6, chanceSource: 'Claude' as const, price: null, priceSource: null, ev: null,
    fairOdds: -150, reasons: [], event: null, start: null, analyzedAt: now.toISOString() };
  await store.setAnalyses(tips.map((tip) => tip.id), new Map(tips.map((tip) => [tip.id, analysis])));
  assert.equal((await store.uncheckedPlays()).length, 2);
  // (the third tip is added below)
  const third = await store.add('o', 's', [{ ...prop, selection: 'Austin Reaves' }], [null]);
  await store.setAnalyses([third[0].id], new Map([[third[0].id, analysis]]));
  await store.setModelChecks(new Map([[tips[0].id, { edge: 'PLAY' as const, gkr: 'LEAN' as const }],
    [tips[1].id, { edge: 'FADE' as const, gkr: 'FADE' as const }], [third[0].id, { edge: 'PASS' as const, gkr: 'PASS' as const }]]));
  const vetted = await store.vetted();
  assert.deepEqual(vetted.picks.map((pick) => pick.selection).sort(), ['Austin Reaves', 'LeBron James']);
  assert.deepEqual(vetted.picks.find((pick) => pick.selection === 'LeBron James')?.checks, { edge: 'PLAY', gkr: 'LEAN', edgeChance: null, gkrChance: null, breakEven: null, gkr2: null });
  assert.deepEqual(vetted.hidden.map((pick) => pick.selection), ['Anthony Davis']);
  assert.equal((await store.uncheckedPlays()).length, 0);
});

test('model reads are judged at the tip own price, not the PrizePicks bar', async () => {
  const { modelRead } = await import('../src/tip-models.js');
  const pick = { side: 'MORE', probability: .55, oppositeProbability: .45, breakEven: .577, market: 'points', threshold: 25.5 } as never;
  assert.equal(modelRead({ side: 'OVER' }, pick, 'prizepicks').verdict, 'PASS');
  assert.equal(modelRead({ side: 'OVER' }, pick, 'prizepicks', -110).verdict, 'LEAN');
  assert.equal(modelRead({ side: 'OVER' }, pick, 'prizepicks', +120).verdict, 'PLAY');
});

test('GKR or Edge can approve a pick the AI passed on; an AI FADE still keeps it off', async () => {
  const now = new Date('2026-10-11T12:00:00Z'), store = new TipStore(null, () => now);
  const prop = { text: 'x', sport: 'NFL', league: 'NFL', selection: 'Bo Nix', opponent: null, market: 'PLAYER_PROP' as const,
    line: 43.5, side: 'OVER' as const, stat: 'rushing yards', odds: null, eventDate: '2026-10-12' };
  const tips = await store.add('o', 's', [prop, { ...prop, selection: 'Mark Andrews' }], [null, null]);
  const analysis = (verdict: 'PASS' | 'FADE') => ({ verdict, chance: .48, chanceSource: 'Claude' as const, price: null, priceSource: null,
    ev: null, fairOdds: 108, reasons: [], event: null, start: null, analyzedAt: now.toISOString() });
  await store.setAnalyses(tips.map((tip) => tip.id), new Map([[tips[0].id, analysis('PASS')], [tips[1].id, analysis('FADE')]]));
  assert.equal((await store.uncheckedPlays()).length, 2, 'every analyzed prop gets the GKR/Edge check');
  await store.setModelChecks(new Map(tips.map((tip) => [tip.id, { edge: 'PLAY' as const, gkr: 'PLAY' as const, edgeChance: .61, gkrChance: .63, breakEven: .577 }])));
  const vetted = await store.vetted();
  assert.deepEqual(vetted.picks.map((pick) => pick.selection), ['Bo Nix']);
  assert.deepEqual(vetted.picks[0].approvedBy, ['GKR+', 'Edge']);
});

test('a better line is suggested from the boards when the posted prop is not worth it', async () => {
  const { suggestFor } = await import('../src/tip-models.js');
  const tip = { market: 'PLAYER_PROP' as const, selection: 'Jacob Misiorowski', stat: 'Pitcher Strikeouts' };
  const pick = (threshold: number, edge: number | null, extra = {}) => ({ playerName: 'Jacob Misiorowski', market: 'pitcher_strikeouts',
    threshold, side: 'LESS', lineType: 'REGULAR', probability: .6, breakEven: .542, edge, ...extra }) as never;
  const best = suggestFor(tip, [pick(7.5, .01), pick(8.5, .07), pick(6.5, null), pick(9.5, .05, { playerName: 'Someone Else' })], 'underdog');
  assert.equal(best?.line, 8.5); assert.equal(best?.platform, 'underdog');
  assert.equal(suggestFor(tip, [pick(7.5, .01)], 'underdog'), null, 'no line clears the bar: a true pass, nothing suggested');
});

test('Vetted labels the gkr check GKR+ and carries GKR 2\'s side and score (Beta, never deciding)', async () => {
  const { approvalOf } = await import('../src/tips.js');
  const tip = { analysis: null, modelCheck: { edge: 'PASS' as const, gkr: 'PLAY' as const, checkedAt: '', rejected: false, v: 3,
    gkr2: { side: 'LESS' as const, score: 90 } } };
  assert.deepEqual(approvalOf(tip as never).approvedBy, ['GKR+']);
  const without = { ...tip, modelCheck: { ...tip.modelCheck, gkr: 'PASS' as const } };
  assert.equal(approvalOf(without as never).approved, false, 'GKR 2 alone never approves a pick');
});
