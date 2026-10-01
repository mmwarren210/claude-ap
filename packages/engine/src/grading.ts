import { nflPassingResultSchema, savedSelectionSchema } from '@crowniq/contracts';
import type { NflPassingResult, SavedSelection } from '@crowniq/contracts';

/** Grade the saved threshold and direction; never consult today's board or recompute its score. */
export function gradeNflPassingSelection(selection: SavedSelection, raw: NflPassingResult,
  now: Date): SavedSelection {
  const result = nflPassingResultSchema.parse(raw);
  const saved = savedSelectionSchema.parse(selection);
  const { line } = saved;
  if (line.sport !== 'NFL' || !['passing_yards', 'player_pass_attempts'].includes(line.market) ||
    line.eventId !== result.eventId || line.playerId !== result.playerId ||
    line.market !== result.market) throw new Error('RESULT_IDENTITY_MISMATCH');
  if (Date.parse(result.completedAt) <= Date.parse(line.eventStartTime) ||
    Date.parse(result.completedAt) > Date.parse(result.retrievedAt) ||
    Date.parse(result.retrievedAt) > now.getTime()) throw new Error('RESULT_TIME_INVALID');
  if (saved.grade !== 'PENDING') throw new Error('SELECTION_ALREADY_GRADED');
  const outcome = result.status !== 'FINAL' ? 'DNP_VOID' :
    result.observedValue === line.threshold ? 'PUSH' :
    (saved.direction === 'MORE' ? result.observedValue! > line.threshold :
      result.observedValue! < line.threshold) ? 'WIN' : 'LOSS';
  return savedSelectionSchema.parse({ ...saved, grade: outcome, gradedAt: now.toISOString(),
    gradeDetail: { observedValue: result.observedValue, sourceName: result.sourceName,
      sourceUrl: result.sourceUrl, completedAt: result.completedAt, status: result.status } });
}
