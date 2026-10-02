import { boardResponseSchema } from '@crowniq/contracts';
import type { PropLine } from '@crowniq/contracts';
import { evaluateBoard } from '@crowniq/engine';
import type { ModelRegistry } from '@crowniq/engine';
import { boardFunnel } from './board-funnel.js';
import type { BoardFunnel } from './board-funnel.js';
import type { SavedBoard } from './board-cache.js';
import { auditPrizePicksLineTypes, classifyPrizePicksLineTypes, normalizeCachedPrizePicksLines } from './prizepicks-line-types.js';

type MultiplierBucket = { below1: number; exactly1: number; above1: number; missing: number };
export interface SavedBoardAudit {
  evaluatedAt: string;
  funnel: BoardFunnel;
  /** Payout multipliers on alternates already classified by threshold. A Goblin should pay below 1x, a Demon above. */
  tierMultipliers: { GOBLIN: MultiplierBucket; DEMON: MultiplierBucket };
  unknownAlternates: { byReason: Record<string, number>; byMarket: { sport: string; market: string; count: number }[] };
  /** NO_REGULAR_REFERENCE alternates whose Regular line exists under a player name differing only in case, accents or punctuation. */
  nameNearMisses: { count: number; examples: { alternate: string; regular: string; eventId: string; market: string }[] };
}

const looseName = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

/** Re-evaluate a saved board offline at a chosen time. No network calls, no credits. */
export function auditSavedBoard(saved: SavedBoard, models: ModelRegistry, at: Date): SavedBoardAudit {
  const lines = classifyPrizePicksLineTypes(normalizeCachedPrizePicksLines(saved.board.lines));
  const board = { ...saved.board, lines };
  const evaluated = evaluateBoard(board, saved.evidence, models, at);
  const response = boardResponseSchema.parse({ board, analyses: evaluated.analyses,
    rankedLineIds: evaluated.rankedLineIds, builtAt: at.toISOString() });

  const bucket = (): MultiplierBucket => ({ below1: 0, exactly1: 0, above1: 0, missing: 0 });
  const tierMultipliers = { GOBLIN: bucket(), DEMON: bucket() };
  for (const line of lines) {
    if (line.lineType !== 'GOBLIN' && line.lineType !== 'DEMON') continue;
    const counts = tierMultipliers[line.lineType], value = line.payoutMultiplier;
    if (value === undefined) counts.missing++;
    else if (value < 1) counts.below1++;
    else if (value === 1) counts.exactly1++;
    else counts.above1++;
  }

  const lineTypes = auditPrizePicksLineTypes(lines);
  const regulars = new Map<string, PropLine[]>();
  for (const line of lines) {
    if (line.lineType !== 'REGULAR') continue;
    const key = line.eventId + '|' + line.market;
    regulars.set(key, [...regulars.get(key) ?? [], line]);
  }
  const hasRegular = new Set(lines.filter((line) => line.lineType === 'REGULAR')
    .map((line) => [line.eventId, line.playerId, line.market].join('|')));
  const examples: SavedBoardAudit['nameNearMisses']['examples'] = [];
  let nearMisses = 0;
  for (const line of lines) {
    if (line.lineType !== 'UNKNOWN_ALTERNATE' || hasRegular.has([line.eventId, line.playerId, line.market].join('|'))) continue;
    const match = (regulars.get(line.eventId + '|' + line.market) ?? []).find((regular) =>
      regular.playerId !== line.playerId && looseName(regular.playerName) === looseName(line.playerName));
    if (!match) continue;
    nearMisses++;
    if (examples.length < 20) examples.push({ alternate: line.playerName, regular: match.playerName,
      eventId: line.eventId, market: line.market });
  }

  return { evaluatedAt: at.toISOString(),
    funnel: boardFunnel(response, models.requirements(), saved.evidence), tierMultipliers,
    unknownAlternates: { byReason: lineTypes.unknownReasons, byMarket: lineTypes.unknownByMarket },
    nameNearMisses: { count: nearMisses, examples } };
}
