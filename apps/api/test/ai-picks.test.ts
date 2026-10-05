import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisSchema, boardResponseSchema } from '@crowniq/contracts';
import { fixtureAnalysis, fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { aiEligible, AiPickService, combineReads, parsePick, parseResult, realNews, settleResult } from '../src/ai-picks.js';
import type { PickQuestion, PickResearcher, ProviderRead, ResultAnswer } from '../src/ai-picks.js';
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

test('result answers fail closed: no searched page or no real number is NOT_FOUND; two models must match', () => {
  const pages = new Set(['https://hltv.example/match/1']);
  assert.deepEqual(parseResult('claude', { status: 'FINAL', actual: 31, source_url: 'https://hltv.example/match/1' }, pages),
    { provider: 'claude', status: 'FINAL', actual: 31, url: 'https://hltv.example/match/1' });
  assert.equal(parseResult('claude', { status: 'FINAL', actual: 31, source_url: 'https://made.up/page' }, pages).status, 'NOT_FOUND');
  assert.equal(parseResult('claude', { status: 'FINAL', actual: -2, source_url: 'https://hltv.example/match/1' }, pages).status, 'NOT_FOUND');
  const answer = (provider: ResultAnswer['provider'], status: ResultAnswer['status'], actual: number | null): ResultAnswer =>
    ({ provider, status, actual, url: status === 'NOT_FOUND' ? null : `https://${provider}.example/r` });
  assert.deepEqual(settleResult([answer('claude', 'FINAL', 31), answer('chatgpt', 'FINAL', 31)], 2)?.actual, 31);
  assert.equal(settleResult([answer('claude', 'FINAL', 31), answer('chatgpt', 'FINAL', 29)], 2), null, 'numbers differ');
  assert.equal(settleResult([answer('claude', 'FINAL', 31)], 2), null, 'one of two models answered');
  assert.equal(settleResult([answer('claude', 'FINAL', 31)], 1)?.actual, 31, 'a single model stands alone');
  assert.equal(settleResult([answer('claude', 'DNP', null), answer('chatgpt', 'DNP', null)], 2)?.status, 'DNP');
  assert.equal(settleResult([answer('claude', 'NOT_FOUND', null), answer('chatgpt', 'NOT_FOUND', null)], 2), null);
});

test('Scout grades the esports and tennis reads no box score carries, within its daily cap; stale ones void', async () => {
  const later = new Date('2030-09-25T12:00:00Z');
  let clock = now;
  const esports = (id: string, start: string) => fixtureLine({ id, playerId: id, playerName: `Player ${id}`, sport: 'CS2', league: 'CS2',
    market: 'maps_1_2_kills', threshold: 30.5, eventStartTime: start, availableDirections: ['MORE', 'LESS'] });
  const lines = [esports('a', '2030-09-24T14:00:00Z'), esports('b', '2030-09-24T15:00:00Z'), esports('c', '2030-09-24T16:00:00Z')];
  const board = boardResponseSchema.parse({ board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines }, analyses: [],
    rankedLineIds: [], builtAt: now.toISOString() });
  const lookups: string[] = [];
  const fake = (provider: ResultAnswer['provider'], kills: Record<string, number>): PickResearcher => ({ provider,
    read: async () => read(provider, 'MORE', 64),
    result: async (q) => { lookups.push(`${provider}:${q.player}:${q.stat}`);
      const actual = kills[q.player];
      return actual === undefined ? { provider, status: 'NOT_FOUND', actual: null, url: null }
        : { provider, status: 'FINAL', actual, url: `https://${provider}.example/${q.player}` }; } });
  const service = new AiPickService([fake('claude', { 'Player a': 34, 'Player b': 22 }), fake('chatgpt', { 'Player a': 34, 'Player b': 25 })],
    null, { dailyAuto: 5, dailyPerUser: 1, dailyResults: 2 }, null, () => clock);
  await service.runOnce(board, [], () => null);
  clock = later;
  assert.equal(await service.grade(), 1, 'a: both found 34; b: the numbers differ, so it waits');
  assert.equal(lookups.length, 4, 'two lines looked up, within the daily cap of two');
  assert.ok(lookups.every((item) => item.endsWith('maps 1 2 kills')));
  const a = await service.readFor(lines[0]);
  assert.deepEqual([a?.grade, a?.actual, a?.resultSources?.length], ['WIN', 34, 2]);
  assert.equal((await service.status()).today.results, 2);
  clock = new Date('2030-09-29T12:00:00Z');
  assert.equal(await service.grade(), 2, 'four days on, b and c are void');
  assert.equal((await service.readFor(lines[2]))?.grade, 'VOID');
});

test('both researchers look up a result through their strict formats, with the page they found', async () => {
  const asked = { sport: 'CS2', league: 'CS2', event: 'NAVI vs FaZe', startTime: '2030-09-24T14:00:00Z', player: 's1mple',
    team: 'NAVI', opponent: 'FaZe', stat: 'maps 1 2 kills' };
  const client = { beta: { messages: { create: async (params: { tools: { name: string }[] }) => ({ stop_reason: 'tool_use', content: [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://hltv.example/m' }] },
    { type: 'tool_use', name: params.tools[1].name, input: { status: 'FINAL', actual: 33, source_url: 'https://hltv.example/m' } }] }) } } };
  assert.deepEqual(await new ClaudePickResearcher({ client: client as never, clock: () => now }).result(asked),
    { provider: 'claude', status: 'FINAL', actual: 33, url: 'https://hltv.example/m' });
  let name = '';
  const fetchFn: typeof fetch = async (_input, init) => {
    name = (JSON.parse(String(init?.body)) as { text: { format: { name: string } } }).text.format.name;
    return new Response(JSON.stringify({ output: [{ type: 'web_search_call', action: { sources: [{ url: 'https://hltv.example/m' }] } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ status: 'FINAL', actual: 33, source_url: 'https://hltv.example/m' }) }] }] }),
    { status: 200 });
  };
  assert.equal((await new OpenAiPickResearcher('key', 'gpt-5.4-mini', fetchFn, () => now).result(asked)).actual, 33);
  assert.equal(name, 'crowniq_result');
});

test('Scout also reads Underdog and Pick6 lines for players PrizePicks does not list, within the same caps', async () => {
  const board = boardResponseSchema.parse({ board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines: [] },
    analyses: [], rankedLineIds: [], builtAt: now.toISOString() });
  const appLine = fixtureLine({ id: 'ud:abc', playerId: 'LOL:artemis', playerName: 'Artemis', sport: 'LOL', league: 'LOL',
    eventId: 'ud-game:1', market: 'kills_on_maps_1_2', threshold: 8.5, eventStartTime: '2030-09-24T16:00:00Z',
    availableDirections: ['MORE', 'LESS'] });
  const researcher: PickResearcher = { provider: 'claude', read: async () => read('claude', 'LESS', 61) };
  const service = new AiPickService([researcher], null, { dailyAuto: 5, dailyPerUser: 1 }, null, () => now);
  service.setExtraScoutLines(() => [appLine]);
  assert.equal((await service.runOnce(board, [], () => null)).researched, 1);
  const upcoming = await service.upcoming();
  assert.deepEqual(upcoming.map((item) => [item.lineId, item.threshold, item.pick, item.score]), [['ud:abc', 8.5, 'LESS', 61]]);
});

test('the owner queue reads waiting lines soonest first, skips held reads and started games, within its own allowance', async () => {
  const line = (id: string, start: string) => fixtureLine({ id, playerId: id, playerName: id, sport: 'LOL', league: 'LOL',
    eventId: `g-${id}`, market: 'kills', threshold: 4.5, eventStartTime: start, availableDirections: ['MORE', 'LESS'] });
  const lines = [line('late', '2030-09-24T20:00:00Z'), line('soon', '2030-09-24T14:00:00Z'), line('gone', '2030-09-24T11:00:00Z'),
    line('mid', '2030-09-24T16:00:00Z')];
  const asked: string[] = [];
  const researcher: PickResearcher = { provider: 'claude', read: async (q) => { asked.push(q.player); return read('claude', 'MORE', 60); } };
  const service = new AiPickService([researcher], null, { dailyAuto: 0, dailyPerUser: 1, dailyOwner: 2 }, null, () => now);
  assert.equal(await service.enqueueOwner(lines, () => [], () => null), 2, 'the allowance of two; the started game is skipped');
  for (let tries = 0; tries < 50 && (await service.ownerStatus()).running; tries++) await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(asked.sort(), ['mid', 'soon'], 'soonest games first');
  const status = await service.ownerStatus();
  assert.deepEqual([status.done, status.failed, status.usedToday, status.waiting], [2, 0, 2, 0]);
  assert.equal(await service.enqueueOwner(lines, () => [], () => null), 0, 'today’s allowance is used; held reads are skipped');
});

test('every Scout read, its grade and a looked-up result are kept in the archive for good', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { HistoryArchive } = await import('../src/history-archive.js');
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-scout-archive-'));
  try {
    let clock = now;
    const archive = new HistoryArchive(folder, () => clock);
    const line = fixtureLine({ id: 'ud:s1', playerId: 'TENNIS:munar', playerName: 'Jaume Munar', sport: 'TENNIS', league: 'TENNIS',
      eventId: 'ud-game:t1', market: 'total_games_won', threshold: 7.5, eventStartTime: '2030-09-24T16:00:00Z',
      availableDirections: ['MORE', 'LESS'] });
    const researcher: PickResearcher = { provider: 'claude', read: async () => read('claude', 'LESS', 61),
      result: async () => ({ provider: 'claude', status: 'FINAL', actual: 6, url: 'https://atp.example/m1' }) };
    const service = new AiPickService([researcher], null, { dailyAuto: 0, dailyPerUser: 5, archive }, null, () => clock);
    await service.ask('user-1', line, undefined, [], null);
    clock = new Date('2030-09-25T12:00:00Z');
    assert.equal(await service.grade(), 1);
    await archive.append('scout', []);
    const month = (stream: string) => readFile(join(folder, `${stream}-2030-09.jsonl`), 'utf8')
      .then((text) => text.trim().split('\n').map((row) => JSON.parse(row) as Record<string, unknown>));
    const scout = await month('scout');
    assert.deepEqual(scout.map((row) => row.type), ['read', 'grade']);
    assert.equal((scout[0].providers as unknown[]).length, 1, 'both models’ full answers are kept');
    assert.deepEqual([scout[1].grade, scout[1].actual], ['WIN', 6]);
    const [result] = await month('results');
    assert.deepEqual([result.playerName, result.market, result.actual, (result.sourceUrls as string[])[0]],
      ['Jaume Munar', 'total_games_won', 6, 'https://atp.example/m1']);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
