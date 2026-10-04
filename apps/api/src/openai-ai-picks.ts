import { setTimeout as delay } from 'node:timers/promises';
import { parsePick, pickInstructions, pickRequest, pickSchema } from './ai-picks.js';
import type { PickQuestion, PickResearcher, ProviderRead } from './ai-picks.js';

/** The pages a Responses API answer's web searches consulted. */
function searchedUrls(body: unknown): Set<string> {
  const urls = new Set<string>();
  const output = body && typeof body === 'object' ? (body as { output?: unknown }).output : null;
  for (const item of Array.isArray(output) ? output : []) {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const sources = entry.type === 'web_search_call' ? (entry.action as { sources?: unknown } | undefined)?.sources : null;
    for (const source of Array.isArray(sources) ? sources : []) {
      const url = source && typeof source === 'object' ? (source as { url?: unknown }).url : null;
      if (typeof url === 'string') urls.add(url);
    }
    for (const part of Array.isArray(entry.content) ? entry.content : []) {
      for (const note of Array.isArray((part as { annotations?: unknown }).annotations) ? (part as { annotations: unknown[] }).annotations : []) {
        const url = note && typeof note === 'object' ? (note as { url?: unknown }).url : null;
        if (typeof url === 'string') urls.add(url);
      }
    }
  }
  return urls;
}
const outputText = (body: unknown) => {
  const output = body && typeof body === 'object' ? (body as { output?: unknown }).output : null;
  for (const item of Array.isArray(output) ? output : []) for (const part of Array.isArray((item as { content?: unknown }).content)
    ? (item as { content: unknown[] }).content : []) {
    const text = part && typeof part === 'object' ? (part as { text?: unknown }).text : null;
    if (typeof text === 'string') return text;
  }
  return null;
};

/** ChatGPT's read on a line GKR can't score (OpenAI Responses API with web search and a strict JSON answer). */
export class OpenAiPickResearcher implements PickResearcher {
  readonly provider = 'chatgpt' as const;
  constructor(private readonly apiKey: string, private readonly model = 'gpt-5.4-mini',
    private readonly fetchFn: typeof fetch = fetch, private readonly clock: () => Date = () => new Date()) {
    if (!apiKey) throw new Error('OPENAI_KEY_REQUIRED');
  }

  async read(question: PickQuestion, signal?: AbortSignal): Promise<ProviderRead> {
    const body = JSON.stringify({ model: this.model, store: false, max_output_tokens: 1500, max_tool_calls: 3,
      tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'],
      text: { format: { type: 'json_schema', name: 'crowniq_pick', strict: true, schema: pickSchema } },
      input: [{ role: 'developer', content: pickInstructions }, { role: 'user', content: pickRequest(question, this.clock()) }] });
    for (let attempt = 0; attempt < 3; attempt++) {
      const timeout = AbortSignal.timeout(60_000);
      const response = await this.fetchFn('https://api.openai.com/v1/responses', { method: 'POST', body,
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      if (response.ok) {
        const result = await response.json() as unknown, text = outputText(result);
        if (!text) throw new Error('AI_PICK_EMPTY');
        return parsePick(this.provider, JSON.parse(text), question, searchedUrls(result));
      }
      if ((response.status !== 429 && response.status < 500) || attempt === 2) throw new Error(`AI_PICK_HTTP_${response.status}`);
      await delay(1000 * (attempt + 1), undefined, { signal });
    }
    throw new Error('AI_PICK_RETRIES_EXHAUSTED');
  }
}
