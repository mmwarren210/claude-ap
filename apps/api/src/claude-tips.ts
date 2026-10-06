import Anthropic from '@anthropic-ai/sdk';
import { TIP_MARKETS } from './tips.js';
import type { Tip, TipDraft, TipReader, TipStatus } from './tips.js';

// Claude reads tip-service screenshots (or pasted text) into rows through a strict tool, and settles them later with a web
// search for the final scores. Display-only: nothing here feeds a score.

const nullable = (type: string) => ({ type: [type, 'null'] });
const tipItem = {
  type: 'object', additionalProperties: false,
  required: ['text', 'sport', 'league', 'selection', 'opponent', 'market', 'line', 'side', 'stat', 'odds', 'eventDate'],
  properties: {
    text: { type: 'string', description: 'The pick exactly as written, without emojis.' },
    sport: { ...nullable('string'), description: 'NFL, NBA, MLB, NHL, NCAAFB, NCAAB, SOCCER, TENNIS, UFC, … or null if unclear.' },
    league: { ...nullable('string'), description: 'League or competition if shown or obvious (e.g. "World Cup qualifier"), else null.' },
    selection: { type: 'string', description: 'The team or player picked, e.g. "Kazakhstan" or "Josh Allen".' },
    opponent: { ...nullable('string'), description: 'The opponent if shown, else null.' },
    market: { type: 'string', enum: [...TIP_MARKETS],
      description: 'MONEYLINE for "ML"/to win; SPREAD for +1.5/-1.5 handicaps; TOTAL for over/under game totals; DOUBLE_CHANCE for "ML or Draw"; DRAW for a draw; PLAYER_PROP for a player stat.' },
    line: { ...nullable('number'), description: 'The handicap or total number (e.g. 1.5 or -1.5), else null.' },
    side: { type: ['string', 'null'], enum: ['OVER', 'UNDER', null], description: 'For totals and props.' },
    stat: { ...nullable('string'), description: 'For player props, the stat (e.g. passing yards), else null.' },
    odds: { ...nullable('number'), description: 'American odds if the post shows them (e.g. -110, +150), else null. Never guess.' },
    eventDate: { ...nullable('string'), description: 'YYYY-MM-DD of the game if the post says (e.g. "Tuesday" → the coming Tuesday from today), else null.' },
  },
};
const readTool: Anthropic.Tool = {
  name: 'report_tips', strict: true,
  description: 'Report every pick in the post once, in order.',
  input_schema: { type: 'object', additionalProperties: false, required: ['source', 'tips'], properties: {
    source: { ...nullable('string'), description: 'The tipster or service name/handle shown in the post, else null.' },
    tips: { type: 'array', items: tipItem } } } as Anthropic.Tool.InputSchema,
};
const gradeTool: Anthropic.Beta.BetaTool = {
  name: 'report_results', strict: true,
  description: 'Report the result of each pick you could settle from final scores you found.',
  input_schema: { type: 'object', additionalProperties: false, required: ['results'], properties: { results: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'status', 'result'], properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['WON', 'LOST', 'PUSH', 'VOID', 'UNKNOWN'] },
      result: { type: 'string', description: 'The final score or stat that settles it, e.g. "Kazakhstan 1–2 Wales".' } } } } } },
};

const readInstructions = 'You read sports betting tips from a screenshot or text a user received from a tip service. List every ' +
  'pick exactly once. Use only what the post shows: never invent odds, dates or opponents. "ML or Draw" is DOUBLE_CHANCE on that ' +
  'team. A "+1.5"/"-1.5" next to a team is a SPREAD with that line. Ignore ads, captions and emojis.';
const gradeInstructions = 'You settle sports betting tips after the games. For each pick, search for the final score or stat of ' +
  'the game nearest to its date. WON/LOST/PUSH by the usual rules (a spread adds the line to the team\'s score; DOUBLE_CHANCE wins ' +
  'on a win or draw; soccer results are after 90 minutes plus stoppage time). VOID if the game was cancelled. UNKNOWN if the game ' +
  'has not finished or you cannot find it. Never guess.';

export class ClaudeTipReader implements TipReader {
  private readonly client: Pick<Anthropic, 'messages' | 'beta'>;
  constructor(options: { apiKey?: string; client?: Pick<Anthropic, 'messages' | 'beta'>; model?: string },
    private readonly model = options.model ?? 'claude-sonnet-5-5') {
    if (!options.client && !options.apiKey) throw new Error('CLAUDE_KEY_REQUIRED');
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, timeout: 90_000, maxRetries: 2 });
  }

  async read(input: { image?: { data: string; mediaType: string }; text?: string; today: string }) {
    const content: Anthropic.ContentBlockParam[] = [];
    if (input.image) content.push({ type: 'image', source: { type: 'base64',
      media_type: input.image.mediaType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: input.image.data } });
    content.push({ type: 'text', text: `Today is ${input.today}.${input.text ? `\n\nPost:\n${input.text}` : ''}\n\nCall report_tips once.` });
    const response = await this.client.messages.create({ model: this.model, max_tokens: 4000, system: readInstructions,
      tools: [readTool], tool_choice: { type: 'tool', name: 'report_tips' }, messages: [{ role: 'user', content }] });
    const block = response.content.find((item) => item.type === 'tool_use' && item.name === 'report_tips');
    if (!block || block.type !== 'tool_use') throw new Error('TIPS_NOT_READ');
    const output = block.input as { source: string | null; tips: TipDraft[] };
    return { source: output.source?.trim() || null, tips: (output.tips ?? []).filter((tip) => tip.selection?.trim()).slice(0, 40) };
  }

  async grade(tips: readonly Tip[], today: string) {
    const list = tips.map((tip) => ({ id: tip.id, pick: tip.text, sport: tip.sport, league: tip.league, selection: tip.selection,
      opponent: tip.opponent, market: tip.market, line: tip.line, side: tip.side, stat: tip.stat,
      date: tip.market_read?.start ?? tip.eventDate ?? tip.createdAt.slice(0, 10), game: tip.market_read?.event ?? null }));
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: JSON.stringify({ today, picks: list }) }];
    for (let turn = 0; turn < 4; turn++) {
      const response = await this.client.beta.messages.create({ model: this.model, max_tokens: 6000,
        system: `${gradeInstructions} When you have searched, call report_results once.`,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }, gradeTool], messages });
      const block = response.content.find((item) => item.type === 'tool_use' && item.name === 'report_results');
      if (block && block.type === 'tool_use') {
        const ids = new Set(tips.map((tip) => tip.id));
        return ((block.input as { results: { id: string; status: TipStatus | 'UNKNOWN'; result: string }[] }).results ?? [])
          .filter((item): item is { id: string; status: Exclude<TipStatus, 'PENDING'>; result: string } =>
            ids.has(item.id) && ['WON', 'LOST', 'PUSH', 'VOID'].includes(item.status));
      }
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason !== 'pause_turn') messages.push({ role: 'user', content: 'Call report_results now.' });
    }
    return [];
  }
}
