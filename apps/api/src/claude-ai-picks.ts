import Anthropic from '@anthropic-ai/sdk';
import { canonicalUrl } from './web-research.js';
import { parsePick, parseResult, pickInstructions, pickRequest, pickSchema, resultInstructions, resultSchema } from './ai-picks.js';
import type { PickQuestion, PickResearcher, ProviderRead, ResultAnswer, ResultQuestion } from './ai-picks.js';

const reportTool: Anthropic.Beta.BetaTool = {
  name: 'report_pick',
  description: 'Report your verdict on this prop line once, after searching: MORE, LESS or PASS, your confidence, a short ' +
    'summary and up to four reasons with the source page each came from.',
  strict: true,
  input_schema: { ...pickSchema, type: 'object' },
};
const resultTool: Anthropic.Beta.BetaTool = {
  name: 'report_result',
  description: 'Report this player\'s final number for the stat once, after searching, with the page that shows it.',
  strict: true,
  input_schema: { ...resultSchema, type: 'object' },
};

/**
 * Claude's read on a line GKR can't score: Claude searches the web, then reports through a strict tool. A reason's link
 * is kept only when it is a page those searches returned.
 */
export class ClaudePickResearcher implements PickResearcher {
  readonly provider = 'claude' as const;
  private readonly client: Pick<Anthropic, 'beta'>;
  constructor(options: { apiKey?: string; model?: string; client?: Pick<Anthropic, 'beta'>; clock?: () => Date },
    private readonly model = options.model ?? 'claude-opus-5-5', private readonly clock = options.clock ?? (() => new Date())) {
    if (!options.client && !options.apiKey) throw new Error('CLAUDE_KEY_REQUIRED');
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, timeout: 120_000, maxRetries: 2 });
  }

  async read(question: PickQuestion, signal?: AbortSignal): Promise<ProviderRead> {
    const { input, urls } = await this.call(pickInstructions, reportTool, pickRequest(question, this.clock()), signal);
    return parsePick(this.provider, input, question, urls);
  }

  async result(question: ResultQuestion, signal?: AbortSignal): Promise<ResultAnswer> {
    const { input, urls } = await this.call(resultInstructions, resultTool, JSON.stringify({ now: this.clock().toISOString(), ...question }), signal);
    return parseResult(this.provider, input, urls);
  }

  /** Searches, then reports through the strict tool; returns its input and the pages the searches returned. */
  private async call(instructions: string, tool: Anthropic.Beta.BetaTool, content: string, signal?: AbortSignal) {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content }];
    const urls = new Set<string>();
    // A server-tool turn can pause; a turn can also end without the report. Append-only, a few turns at most.
    for (let turn = 0; turn < 4; turn++) {
      const response = await this.client.beta.messages.create({
        model: this.model, max_tokens: 8000,
        system: `${instructions} When you have searched, call ${tool.name} once.`,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }, tool],
        output_config: { effort: 'low' },
        // If a safety check declines, the API retries on a fallback model inside the same call.
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        messages,
      }, { signal });
      if (response.stop_reason === 'refusal') throw new Error('AI_PICK_REFUSED');
      for (const block of response.content) {
        if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
        for (const result of block.content) {
          const url = canonicalUrl(result.url);
          if (url) urls.add(url);
          urls.add(result.url);
        }
      }
      const report = response.content.find((block) => block.type === 'tool_use' && block.name === tool.name);
      if (report && report.type === 'tool_use') return { input: report.input, urls };
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason !== 'pause_turn') messages.push({ role: 'user', content: `Call ${tool.name} now.` });
    }
    throw new Error('AI_PICK_NOT_REPORTED');
  }
}
