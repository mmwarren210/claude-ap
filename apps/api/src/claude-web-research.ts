import Anthropic from '@anthropic-ai/sdk';
import { logClaudeUsage } from './claude-usage.js';
import type { Evidence } from '@crowniq/contracts';
import { canonicalUrl, findingsToEvidence, outputSchema, webResearchInstructions, webResearchRequest,
  WebResearchRunner } from './web-research.js';
import type { WebResearchRunnerOptions, WebSearchPlan } from './web-research.js';

export interface ClaudeWebResearchOptions extends WebResearchRunnerOptions {
  readonly apiKey?: string;
  readonly model?: string;
  /** A ready client (tests pass a stub); otherwise one is built from `apiKey`. */
  readonly client?: Pick<Anthropic, 'beta'>;
}

const reportTool: Anthropic.Beta.BetaTool = {
  name: 'report_findings',
  description: 'Report every finding from your web searches for this player and event. Call it once, after searching. ' +
    'Each source_url must be a page your searches returned. An empty findings list is a valid report.',
  strict: true,
  input_schema: { ...outputSchema, type: 'object' },
};

/**
 * Claude web research, run next to ChatGPT's. Claude searches with its web search tool and reports through a strict
 * tool; a finding is kept only when its link is one those searches returned. Findings are display-only (the engine
 * never scores AI_STRUCTURED evidence) and Claude never picks a side, scores or projects.
 */
export class ClaudeWebResearchAdapter extends WebResearchRunner {
  readonly id = 'claude-web-search';
  private readonly model: string;
  private readonly client: Pick<Anthropic, 'beta'>;
  constructor(options: ClaudeWebResearchOptions) {
    if (!options.client && !options.apiKey) throw new Error('CLAUDE_RESEARCH_KEY_REQUIRED');
    super(options);
    this.model = options.model ?? 'claude-opus-5-5';
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, timeout: 120_000, maxRetries: 2 });
  }

  protected async search(plan: WebSearchPlan, hints: string[], signal?: AbortSignal):
    Promise<{ evidence: Evidence[]; sourceUrls: string[] }> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: webResearchRequest(plan, hints, this.clock()) }];
    const urls = new Set<string>();
    let searched = false;
    // A server-tool turn can pause; a turn can also end without the report. Append-only, a few turns at most.
    for (let turn = 0; turn < 4; turn++) {
      const response = await this.client.beta.messages.create({
        model: this.model, max_tokens: 8000,
        // Prompt caching: the instructions and tools are the same on every call; later turns resend the search results.
        system: [{ type: 'text', text: `${webResearchInstructions} When you have searched, call report_findings once with every finding.`,
          cache_control: { type: 'ephemeral' } }],
        cache_control: { type: 'ephemeral' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }, reportTool],
        output_config: { effort: 'low' },
        // If a safety check declines, the API retries on a fallback model inside the same call.
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        messages,
      }, { signal });
      logClaudeUsage('web-research', response.usage);
      if (response.stop_reason === 'refusal') throw new Error('WEB_SEARCH_REFUSED');
      for (const block of response.content) {
        if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
        searched = true;
        for (const result of block.content) {
          const url = canonicalUrl(result.url);
          if (url) urls.add(url);
        }
      }
      const report = response.content.find((block) => block.type === 'tool_use' && block.name === reportTool.name);
      if (report && report.type === 'tool_use') {
        if (!searched) throw new Error('WEB_SEARCH_NOT_COMPLETED');
        return findingsToEvidence(report.input, urls, plan, this.clock(), 'web-claude');
      }
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason !== 'pause_turn') {
        messages.push({ role: 'user', content: 'Call report_findings now with the findings from your searches. ' +
          'An empty list is fine.' });
      }
    }
    throw new Error('WEB_SEARCH_NOT_COMPLETED');
  }
}
