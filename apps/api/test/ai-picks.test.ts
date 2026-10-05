import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisSchema, boardResponseSchema } from '@crowniq/contracts';
import { fixtureAnalysis, fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { aiEligible, AiPickService, combineReads, parsePick, realNews } from '../src/ai-picks.js';
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
    { kind: 'role', text: 'Batting second', source_url: 'https://mlb.com/a' },
    { kind: 'vibes', text: 'Made up', source_url: 'https://fake.example/b' }] },
  question, new Set(['https://mlb.com/a']));
  assert.deepEqual([parsed.pick, parsed.confidence, parsed.reasons.map((item) => item.url)], ['MORE', 64, ['https://mlb.com/a', null]]);
  assert.deepEqual(parsed.reasons.map((item) => item.kind), ['role', 'other'], 'an unknown evidence kind files as other');
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
  assert.deepEqual(await service.runOnce(board, [], () => null), { researched: 1, failed: 0, seconds: 0 }, 'daily cap of one');
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

test('second opinions: Scout reads GKR Top Picks without being told GKR pick, and GKR is graded by verdict', async () => {
  const lines = ['top', 'next', 'low'].map((name) => fixtureLine({ id: `line-${name}`, sourceLineId: name, playerId: name,
    playerName: `Player ${name}`, sport: 'MLB', league: 'MLB', market: 'batter_total_bases', threshold: 1.5,
    eventStartTime: '2030-09-24T18:00:00Z', availableDirections: ['MORE', 'LESS'] }));
  const scored = (lineId: string, score: number) => ({ ...fixtureAnalysis(lines.find((line) => line.id === lineId)!, 'MORE', score),
    scoreBand: score >= 92 ? 'CROWN_ELITE' as const : score >= 86 ? 'CROWN_STRONG' as const : score >= 80 ? 'PLAYABLE' as const
      : 'LEAN' as const, modelVersion: 'mlb-test-1.0' });
  const board = boardResponseSchema.parse({ board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines },
    analyses: [scored('line-top', 90), scored('line-next', 85), scored('line-low', 60)],
    rankedLineIds: ['line-top', 'line-next', 'line-low'], builtAt: now.toISOString() });
  const asked: PickQuestion[] = [];
  // ChatGPT agrees on the top pick and disagrees on the next; Claude passes on both and flags news on the top pick.
  const chatgpt: PickResearcher = { provider: 'chatgpt', read: async (q) => { asked.push(q);
    return read('chatgpt', q.player === 'Player top' ? 'MORE' : 'LESS', 70); } };
  const claude: PickResearcher = { provider: 'claude', read: async (q) => ({ ...read('claude', 'PASS', 50),
    lateNews: q.player === 'Player top' ? 'Scratched from the lineup an hour ago.' : '' }) };
  const boxScores = { results: async () => ({ waiting: [], unsupported: [], facts: lines.map((line) => ({ eventId: line.eventId,
    playerId: line.playerId, market: line.market, status: 'FINAL', actual: 2 })) }) };
  const service = new AiPickService([chatgpt, claude], null, { dailyAuto: 5, dailyPerUser: 1, dailySecond: 5 },
    boxScores as never, () => now);
  assert.deepEqual(await service.runOnce(board, [], () => null), { researched: 0, failed: 0, seconds: 2 },
    'only the two Top Picks (score 80+), not the 60');
  assert.ok(asked.every((q) => !JSON.stringify(q).includes('mlb-test') && !('gkr' in q)), 'GKR pick is not in the question');
  const reads = await service.current(board);
  assert.equal(reads.get('line-top')?.kind, 'second');
  assert.deepEqual(reads.get('line-top')?.gkr, { direction: 'MORE', score: 90, modelVersion: 'mlb-test-1.0' });
  assert.equal(reads.get('line-top')?.providers[1]?.lateNews, 'Scratched from the lineup an hour ago.');
  assert.equal(await service.runOnce(board, [], () => null).then((result) => result.seconds), 0, 'researched once per line');
  assert.equal(await service.grade(), 2);
  const status = await service.status();
  assert.equal(status.reads, 0, 'second opinions stay out of the Scout pick record');
  assert.deepEqual(status.secondOpinions.agree, { reads: 1, graded: 1, gkrWins: 1, gkrHitRate: 1 });
  assert.deepEqual(status.secondOpinions.disagree, { reads: 1, graded: 1, gkrWins: 1, gkrHitRate: 1 });
  assert.equal(status.secondOpinions.lateNews, 1);
  // With second opinions off (the default), none run.
  const off = new AiPickService([chatgpt], null, { dailyAuto: 5, dailyPerUser: 1 }, null, () => now);
  assert.equal((await off.runOnce(board, [], () => null)).seconds, 0);
});

test('Scout second opinions reach the sportsbook and market tabs within the same caps; market reads are never box-score graded', async () => {
  const board = boardResponseSchema.parse({ board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines: [] },
    analyses: [], rankedLineIds: [], builtAt: now.toISOString() });
  const bookLine = fixtureLine({ id: 'draftkings:e:p:passing_yards:245.5', eventStartTime: '2030-09-24T18:00:00Z', threshold: 245.5 });
  const marketLine = fixtureLine({ id: 'kalshi:NFL:game:winner', playerId: 'market:Raiders to win', playerName: 'Raiders to win',
    market: 'game_winner', threshold: 0.5, eventStartTime: '2030-09-24T18:00:00Z' });
  const marketQuestion: PickQuestion = { ...question, player: 'Raiders to win', stat: 'wins the game', line: 0.5,
    facts: ['MORE means this side wins.'] };
  const asked: PickQuestion[] = [];
  const researcher: PickResearcher = { provider: 'claude', read: async (q) => { asked.push(q); return read('claude', 'MORE', 62); } };
  let graded = 0;
  const boxScores = { results: async (targets: unknown[]) => { graded += targets.length; return { facts: [], waiting: [], unsupported: [] }; } };
  const service = new AiPickService([researcher], null, { dailyAuto: 5, dailyPerUser: 1, dailySecond: 1, secondPerRun: 5 },
    boxScores as never, () => now);
  service.setExtraSecondOpinions(() => [{ line: marketLine, gkr: { direction: 'MORE', score: null, modelVersion: 'market-edge' },
    question: marketQuestion }, { line: bookLine, gkr: { direction: 'MORE', score: 88, modelVersion: 'm-1.0' } }]);
  assert.equal((await service.runOnce(board, [], () => null)).seconds, 1, 'the daily cap of one holds across the tabs');
  assert.equal(asked[0]?.stat, 'wins the game', 'the market question is asked as given');
  const reads = await service.readFor(marketLine);
  assert.equal(reads?.subject, 'market');
  assert.equal(await service.readFor(bookLine), null, 'over the cap');
  await service.grade();
  assert.equal(graded, 0, 'market reads are never sent to the box-score grader');
});

test('late news that only says there is none is empty; real news stays', () => {
  for (const text of ['No injury designation is currently listed for Dotson.', 'I did not find a fresh role change.',
    'No last-24-hour injury or weather note surfaced.', 'Nothing new on his status.', '']) assert.equal(realNews(text), '', text);
  for (const text of ['Ruled out with a hamstring injury this morning.',
    'No injury news, but the posted lineup leaves Rojo out of the starting XI.']) assert.equal(realNews(text), text, text);
});
