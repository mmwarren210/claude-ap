import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisSchema, boardResponseSchema } from '@crowniq/contracts';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { aiEligible, AiPickService, combineReads, parsePick } from '../src/ai-picks.js';
import type { PickQuestion, PickResearcher, ProviderRead } from '../src/ai-picks.js';
import { ClaudePickResearcher } from '../src/claude-ai-picks.js';
import { OpenAiPickResearcher } from '../src/openai-ai-picks.js';

const now = new Date('2030-09-24T12:00:00Z');
const question: PickQuestion = { sport: 'MLB', league: 'MLB', event: 'Braves @ Dodgers', startTime: '2030-09-24T23:00:00Z',
  player: 'Shohei Ohtani', team: 'Dodgers', opponent: 'Braves', stat: 'batter total bases', line: 1.5, lineType: 'REGULAR',
  sides: ['MORE', 'LESS'], facts: [] };
const read = (provider: ProviderRead['provider'], pick: ProviderRead['pick'], confidence: number): ProviderRead =>
  ({ provider, pick, confidence, summary: '', reasons: [] });

test('answers fail closed: a side the line lacks, low confidence or junk becomes PASS; unknown links are dropped', () => {
  assert.equal(parsePick('claude', { pick: 'LESS', confidence: 70 }, { ...question, sides: ['MORE'] }, null).pick, 'PASS');
  assert.equal(parsePick('claude', { pick: 'MORE', confidence: 52 }, question, null).pick, 'PASS');
  assert.equal(parsePick('claude', { pick: 'OVER', confidence: 90 }, question, null).pick, 'PASS');
  const parsed = parsePick('chatgpt', { pick: 'MORE', confidence: 64, summary: 'Hot bat.', reasons: [
    { text: 'Batting second', source_url: 'https://mlb.com/a' }, { text: 'Made up', source_url: 'https://fake.example/b' }] },
  question, new Set(['https://mlb.com/a']));
  assert.deepEqual([parsed.pick, parsed.confidence, parsed.reasons.map((item) => item.url)], ['MORE', 64, ['https://mlb.com/a', null]]);
});

test('reads combine: agreement averages, one PASS marks down, opposite sides PASS', () => {
  assert.deepEqual(combineReads([read('chatgpt', 'MORE', 60), read('claude', 'MORE', 66)]), { pick: 'MORE', score: 63, agreement: 'BOTH' });
  assert.deepEqual(combineReads([read('chatgpt', 'LESS', 70), read('claude', 'PASS', 50)]), { pick: 'LESS', score: 60, agreement: 'ONE' });
  assert.deepEqual(combineReads([read('chatgpt', 'MORE', 58), read('claude', 'PASS', 50)]), { pick: 'PASS', score: null, agreement: 'ONE' },
    'marked down below 55 is a PASS');
  assert.deepEqual(combineReads([read('chatgpt', 'MORE', 60), read('claude', 'LESS', 62)]), { pick: 'PASS', score: null, agreement: 'SPLIT' });
  assert.deepEqual(combineReads([read('claude', 'LESS', 58)]), { pick: 'LESS', score: 58, agreement: 'SINGLE' });
});

test('only lines GKR could not score qualify; reads are cached, capped per user and per day, and graded apart', async () => {
  const lines = ['a', 'b', 'c'].map((name, index) => fixtureLine({ id: `line-${name}`, sourceLineId: name, playerId: name,
    playerName: `Player ${name}`, sport: 'MLB', league: 'MLB', market: 'batter_total_bases', threshold: 1.5,
    eventStartTime: `2030-09-24T${String(14 + index).padStart(2, '0')}:00:00Z`, availableDirections: ['MORE', 'LESS'] }));
  const pass = (lineId: string, reasonCode: string) => analysisSchema.parse({ lineId, direction: 'PASS', score: null,
    scoreBand: 'PASS', scoreBreakdown: [], assessments: [], evidenceIds: [], evidenceQuality: 'NONE', evidenceExpiresAt: null,
    dangerZone: false, ruleChecks: [], supportingFactors: [], opposingFactors: [], rationale: 'x', reasonCode, modelVersion: null });
  const board = boardResponseSchema.parse({ board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines },
    analyses: [pass('line-a', 'MODEL_SUPPORT_INCOMPLETE'), pass('line-b', 'DIRECTION_UNAVAILABLE'), pass('line-c', 'STALE_OR_MISSING_EVIDENCE')],
    rankedLineIds: [], builtAt: now.toISOString() });
  assert.equal(aiEligible(lines[1], board.analyses[1]), false, 'GKR passed on the merits');
  let calls = 0;
  const fake = (provider: ProviderRead['provider'], pick: ProviderRead['pick']): PickResearcher =>
    ({ provider, read: async () => { calls++; return read(provider, pick, 64); } });
  const service = new AiPickService([fake('chatgpt', 'MORE'), fake('claude', 'MORE')], null,
    { dailyAuto: 1, dailyPerUser: 1 }, null, () => now);
  assert.deepEqual(await service.runOnce(board, [], () => null), { researched: 1, failed: 0 }, 'daily cap of one');
  assert.equal(calls, 2);
  const reads = await service.current(board);
  assert.deepEqual([...reads.keys()], ['line-a'], 'earliest eligible line first');
  assert.equal(reads.get('line-a')?.score, 64);
  assert.equal((await service.ask('user-1', lines[1], board.analyses[1], [], null)).error, 'GKR_SCORES_THIS_LINE');
  assert.equal((await service.ask('user-1', lines[0], board.analyses[0], [], null)).read?.lineId, 'line-a', 'cached, no new call');
  assert.equal(calls, 2);
  assert.ok((await service.ask('user-1', lines[2], board.analyses[2], [], null)).read);
  assert.equal((await service.ask('user-1', fixtureLine({ id: 'line-d', eventStartTime: '2030-09-24T20:00:00Z' }), undefined, [], null)).error,
    'DAILY_LIMIT_REACHED');
});

test('Claude reports through the strict tool after searching, and keeps only links it found', async () => {
  const requests: unknown[] = [];
  const client = { beta: { messages: { create: async (params: unknown) => { requests.push(params); return {
    stop_reason: 'tool_use', content: [
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://www.mlb.com/news/x' }] },
      { type: 'tool_use', name: 'report_pick', input: { pick: 'LESS', confidence: 61, summary: 'Tough lefty.',
        reasons: [{ text: 'Faces a lefty', source_url: 'https://www.mlb.com/news/x' }] } }] }; } } } };
  const researcher = new ClaudePickResearcher({ client: client as never, clock: () => now });
  const result = await researcher.read(question);
  assert.deepEqual([result.pick, result.confidence, result.reasons[0].url], ['LESS', 61, 'https://www.mlb.com/news/x']);
  const sent = requests[0] as { model: string; tools: { type?: string; name: string }[]; fallbacks: string };
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.fallbacks, 'default');
  assert.deepEqual(sent.tools.map((tool) => tool.name), ['web_search', 'report_pick']);
});

test('ChatGPT answers in the strict JSON format with web search', async () => {
  let sent: Record<string, unknown> = {};
  const fetchFn: typeof fetch = async (_input, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ output: [
    { type: 'web_search_call', action: { sources: [{ url: 'https://espn.com/y' }] } },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ pick: 'MORE', confidence: 58, summary: 's',
      reasons: [{ text: 'r', source_url: 'https://espn.com/y' }] }) }] }] }), { status: 200 }); };
  const result = await new OpenAiPickResearcher('key', 'gpt-5.4-mini', fetchFn, () => now).read(question);
  assert.deepEqual([result.provider, result.pick, result.reasons[0].url], ['chatgpt', 'MORE', 'https://espn.com/y']);
  assert.equal((sent.text as { format: { strict: boolean } }).format.strict, true);
});
