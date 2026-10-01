import { randomUUID } from 'node:crypto';
import { savedSelectionSchema } from '@crowniq/contracts';
import type { Analysis, Evidence, PropLine, SavedSelection } from '@crowniq/contracts';

export function snapshotSelection(line: PropLine, analysis: Analysis,
  evidence: readonly Evidence[], now: Date): SavedSelection {
  if (analysis.lineId !== line.id || analysis.direction === 'PASS' || analysis.score === null ||
    !analysis.modelVersion || line.lineType === 'UNKNOWN_ALTERNATE' ||
    !line.availableDirections.includes(analysis.direction) ||
    Date.parse(line.eventStartTime) <= now.getTime() ||
    (analysis.evidenceExpiresAt && Date.parse(analysis.evidenceExpiresAt) <= now.getTime())) {
    throw new Error('INELIGIBLE_SELECTION');
  }
  return savedSelectionSchema.parse({ id: randomUUID(), savedAt: now.toISOString(),
    line, direction: analysis.direction, score: analysis.score,
    contextScore: analysis.contextScore ?? null, dataConfidence: analysis.dataConfidence ?? null,
    scoreBand: analysis.scoreBand ?? null,
    modelVersion: analysis.modelVersion,
    evidenceSnapshot: evidence.filter((item) => analysis.evidenceIds.includes(item.id)),
    grade: 'PENDING', gradedAt: null });
}
