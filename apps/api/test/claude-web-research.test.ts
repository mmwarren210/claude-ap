import assert from 'node:assert/strict';
import test from 'node:test';
import type { Board } from '@crowniq/contracts';
import { researchTargetsFor } from '@crowniq/engine';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { ClaudeWebResearchAdapter } from '../src/claude-web-research.js';
import { CombinedWebResearch, mergeAgreedFindings } from '../src/web-research.js';
import type { WebResearchService } from '../src/web-research.js';

const at = new Date('2030-09-24T12:00:00.000Z');
const source = 'https://www.nfl.com/stats/player-stats';
const board: Board = { provider: 'prizepicks', fetchedAt: at.toISOString(), lines: [fixtureLine()] };
const finding = (url = source) => ({ category: 'injury', claim: 'The quarterback is listed as a full participant.',
  source_url: url, published_at: '2030-09-24T10:00:00.000Z' });
const searchResult = { type: 'web_search_tool_result', tool_use_id: 'srv_1',
  content: [{ type: 'web_search_result', url: source, title: 'Stats', page_age: null, encrypted_content: 'x' }] };
const report = (findings: unknown[]) => ({ type: 'tool_use', id: 'tool_1', name: 'report_findings', input: { findings } });

/** A stand-in for the Anthropic client that replays canned responses and records each request. */
function stub(responses: { stop_reason: string; content: unknown[] }[]) {
  const requests: Record<string, unknown>[] = [];
  const client = { beta: { messages: { create: async (params: Record<string, unknown>) => {
    requests.push(structuredClone(params));
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next;
  } } } };
  return { client: client as unknown as ConstructorParameters<typeof ClaudeWebResearchAdapter>[0]['client'], requests };
}

test('Claude keeps only findings whose link its own searches returned, as display-only web evidence', async () => {
  const { client, requests } = stub([{ stop_reason: 'tool_use',
    content: [searchResult, report([finding(), finding('https://invented.example.com/fake')])] }]);
  const claude = new ClaudeWebResearchAdapter({ client, clock: () => at });
  const evidence = await claude.research(researchTargetsFor(board));
  assert.equal(evidence.length, 1);
  assert.match(evidence[0].id, /^web-claude:/);
  assert.deepEqual([evidence[0].sourceUrl, evidence[0].sourceType, evidence[0].kind], [source, 'AI_STRUCTURED', 'web:injury']);
  const request = requests[0];
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.fallbacks, 'default');
  assert.deepEqual((request.tools as { name: string }[]).map((tool) => tool.name), ['web_search', 'report_findings']);
  assert.equal(claude.getHealth().status, 'OK');
});

test('a paused turn is resumed, and a report without any search is not trusted', async () => {
  const paused = stub([{ stop_reason: 'pause_turn', content: [searchResult] },
    { stop_reason: 'tool_use', content: [report([finding()])] }]);
  const resumed = await new ClaudeWebResearchAdapter({ client: paused.client, clock: () => at })
    .research(researchTargetsFor(board));
  assert.equal(resumed.length, 1);
  assert.equal((paused.requests[1].messages as unknown[]).length, 2, 'the paused turn is appended, not rewritten');
  const unsearched = stub([{ stop_reason: 'tool_use', content: [report([finding()])] }]);
  const claude = new ClaudeWebResearchAdapter({ client: unsearched.client, clock: () => at });
  assert.deepEqual(await claude.research(researchTargetsFor(board)), []);
  assert.equal(claude.getHealth().failures, 1);
});

test('a refusal counts as a failed search', async () => {
  const refused = stub([{ stop_reason: 'refusal', content: [] }]);
  const claude = new ClaudeWebResearchAdapter({ client: refused.client, clock: () => at });
  assert.deepEqual(await claude.research(researchTargetsFor(board)), []);
  assert.equal(claude.getHealth().failures, 1);
});

test('ChatGPT and Claude run side by side; a finding both make is kept once and marked as agreed', async () => {
  const base = { id: 'web:a', entityType: 'PLAYER', entityId: 'p', eventId: 'e', market: null, kind: 'web:injury',
    finding: 'Listed as a full participant.', sourceName: 'www.nfl.com', sourceUrl: source, sourceType: 'AI_STRUCTURED',
    retrievedAt: at.toISOString(), expiresAt: '2030-09-24T13:00:00.000Z', quality: 'LOW', confidence: 0.5 } as const;
  const merged = mergeAgreedFindings([[base], [{ ...base, id: 'web-claude:b' },
    { ...base, id: 'web-claude:c', kind: 'web:weather' }]]);
  assert.equal(merged.length, 2);
  assert.match(merged[0].finding, /Both scouts found this/);
  assert.equal(merged[1].finding, base.finding);
  assert.deepEqual([merged[0].quality, merged[0].confidence], ['LOW', 0.5], 'agreement never raises a score input');

  const provider = (id: string, run: () => Promise<typeof merged>): WebResearchService => ({ id, maxSearchesPerRun: 10,
    research: run, getHealth: () => ({ status: 'OK', targets: 1, searches: 1, cacheHits: 0, skipped: 0, failures: 0,
      noSources: 0, lastRunAt: null }), getCatalogSummary: () => ({ searches: 1, citedWebsites: 1 }),
    getCatalog: async () => ({ total: 0, searches: [] }) });
  const both = new CombinedWebResearch([provider('openai-web-search', async () => [base]),
    provider('claude-web-search', async () => { throw new Error('down'); })]);
  assert.equal(both.id, 'openai-web-search+claude-web-search');
  assert.equal(both.maxSearchesPerRun, 20);
  assert.deepEqual((await both.research([])).map((item) => item.id), ['web:a'], 'one provider failing does not stop the other');
});
