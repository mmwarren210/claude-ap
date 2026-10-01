import { readFile, stat } from 'node:fs/promises';
import { evidenceSchema } from '@crowniq/contracts';
import type { Evidence } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchTarget } from '@crowniq/engine';
import { z } from 'zod';

const fileSchema = z.object({
  format: z.literal('crowniq-nfl-passing-evidence-v1'),
  evidence: z.array(evidenceSchema).max(30000),
}).strict();

/** Owner-supplied, attributed pregame findings. No guesses or AI-only numeric inputs. */
export class NflPassingFileResearch implements ResearchAdapter {
  readonly id = 'nfl-passing-evidence-file';
  constructor(private readonly path: string) {}

  async research(targets: readonly ResearchTarget[]): Promise<readonly Evidence[]> {
    if ((await stat(this.path)).size > 5_000_000) throw new Error('EVIDENCE_FILE_TOO_LARGE');
    const document = fileSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    const matching = new Map(targets.filter((target) => target.sport === 'NFL' &&
      ['passing_yards', 'player_pass_attempts'].includes(target.market))
      .map((target) => [JSON.stringify([target.eventId, target.playerId, target.market]), target]));
    const ids = new Set<string>();
    return document.evidence.filter((item) => {
      if (ids.has(item.id)) throw new Error('DUPLICATE_EVIDENCE_ID');
      ids.add(item.id);
      if (item.sourceType === 'AI_STRUCTURED' || !item.sourceUrl ||
        !['metric:', 'projection:', 'status:', 'risk:', 'historical:'].some((prefix) =>
          item.kind.startsWith(prefix))) throw new Error('UNTRUSTED_PILOT_EVIDENCE');
      const keys = item.market === null ? ['passing_yards', 'player_pass_attempts'] : [item.market];
      const target = keys.map((market) => matching.get(JSON.stringify([
        item.eventId, item.entityId, market]))).find(Boolean);
      // Event/team findings cannot be safely joined while player-team IDs are unknown.
      if (item.entityType !== 'PLAYER' || !target) return false;
      if (Date.parse(item.retrievedAt) >= Date.parse(target.eventStartTime) ||
        Date.parse(item.expiresAt) <= Date.parse(item.retrievedAt)) {
        throw new Error('INVALID_PREGAME_EVIDENCE_TIME');
      }
      return true;
    });
  }
}
