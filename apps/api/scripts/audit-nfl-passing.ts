import { readFile } from 'node:fs/promises';
import { boardSchema } from '@crowniq/contracts';
import { collectResearch, createGkrRegistry, evaluateBoard } from '@crowniq/engine';
import { NflPassingFileResearch } from '../src/nfl-evidence-file.js';

// Offline replay: no provider calls, no odds credits, no publishing picks.
const [, , boardPath, asOfValue, evidencePath] = process.argv;
if (!boardPath || !asOfValue || !Number.isFinite(Date.parse(asOfValue))) {
  throw new Error('Usage: npm run audit:nfl -- BOARD_JSON AS_OF_ISO [EVIDENCE_JSON]');
}
const now = new Date(asOfValue);
const board = boardSchema.parse(JSON.parse(await readFile(boardPath, 'utf8')));
if (now.getTime() < Date.parse(board.fetchedAt)) {
  throw new Error('Replay time must not precede the saved board snapshot.');
}
const adapter = evidencePath ? new NflPassingFileResearch(evidencePath) : null;
const research = await collectResearch(board, adapter);
const versions = (process.env.GKR_APPROVED_MODEL_VERSIONS ?? '').split(',').map((v) => v.trim());
const evaluated = evaluateBoard(board, research.evidence, createGkrRegistry(versions), now);
const included = new Set(board.lines.filter((line) => line.sport === 'NFL' &&
  ['passing_yards', 'player_pass_attempts'].includes(line.market)).map((line) => line.id));
const reasonCounts: Record<string, number> = {};
for (const analysis of evaluated.analyses.filter((a) => included.has(a.lineId))) {
  const key = analysis.reasonCode ?? analysis.direction;
  reasonCounts[key] = (reasonCounts[key] ?? 0) + 1;
}
const report = {
  kind: 'OFFLINE_NFL_PASSING_PILOT', boardFetchedAt: board.fetchedAt,
  evaluatedAt: now.toISOString(), researchStatus: research.status,
  attributedEvidenceCount: research.evidence.length,
  boardLinesAssessed: evaluated.analyses.length,
  nflPassingLines: included.size,
  reasons: reasonCounts,
  rankedNflPassingLineIds: evaluated.rankedLineIds.filter((id) => included.has(id)),
  // Exact line components and three-pass details remain attached to each analysis.
  nflPassingAnalyses: evaluated.analyses.filter((a) => included.has(a.lineId)),
};
console.log(JSON.stringify(report));
