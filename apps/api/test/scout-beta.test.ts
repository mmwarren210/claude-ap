import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureAnalysis, fixtureLine } from '../../../packages/engine/test/fixtures.js';
import type { AiRead, ProviderRead } from '../src/ai-picks.js';
import { betaFor, outNews } from '../src/scout-beta.js';

const line = fixtureLine();
const analysis = { ...fixtureAnalysis(line, 'MORE', 86), modelVersion: 'GKR-NFL-1.0' };
const provider = (pick: ProviderRead['pick'], kinds: NonNullable<ProviderRead['reasons'][number]['kind']>[], lateNews = ''): ProviderRead =>
  ({ provider: 'claude', pick, confidence: 70, summary: '', lateNews,
    reasons: kinds.map((kind) => ({ kind, text: `${kind} reason`, url: null })) });
const read = (pick: AiRead['pick'], score: number | null, agreement: AiRead['agreement'], providers: ProviderRead[]): AiRead =>
  ({ lineId: line.id, threshold: line.threshold, pick, score, agreement, providers, researchedAt: '', eventStartTime: '',
    lineSnapshot: line, source: 'auto', kind: 'second', grade: 'PENDING', actual: null });

test('GKR Beta: late news passes, agreement on matchup or role moves the score up to 8, form alone moves nothing', () => {
  assert.deepEqual(betaFor(analysis, null)?.change, 'SAME');
  assert.equal(betaFor(analysis, null)?.scouted, false);
  const benched = read('PASS', null, 'BOTH', [provider('PASS', ['role'], 'ESPN lineup leaves him out of the starting XI.')]);
  assert.equal(outNews(benched), 'ESPN lineup leaves him out of the starting XI.');
  assert.deepEqual([betaFor(analysis, benched)?.direction, betaFor(analysis, benched)?.change], ['PASS', 'LATE_NEWS_PASS']);
  const backs = betaFor(analysis, read('MORE', 75, 'BOTH', [provider('MORE', ['matchup', 'recent_form'])]))!;
  assert.deepEqual([backs.direction, backs.score, backs.shift, backs.change], ['MORE', 94, 8, 'UP']);
  const opposes = betaFor(analysis, read('LESS', 60, 'BOTH', [provider('LESS', ['role'])]))!;
  assert.deepEqual([opposes.direction, opposes.score, opposes.shift], ['MORE', 84, -2], 'a side stays GKR’s; the score drops');
  assert.equal(betaFor(analysis, read('MORE', 80, 'BOTH', [provider('MORE', ['recent_form', 'history'])]))!.shift, 0,
    'form and history are already in GKR');
  assert.equal(betaFor(analysis, read('MORE', 80, 'ONE', [provider('MORE', ['matchup'])]))!.shift, 0, 'one model is not enough');
  assert.equal(betaFor({ ...analysis, direction: 'PASS', score: null }, benched), null, 'Beta never plays a GKR pass');
  assert.equal(outNews(read('MORE', 70, 'BOTH', [provider('MORE', ['injury_news'], 'Questionable but expected to play.')])), null);
});
