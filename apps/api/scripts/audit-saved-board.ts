import 'dotenv/config';
import { createGkrRegistry, statHistoryReadyVersions } from '@crowniq/engine';
import { auditSavedBoard } from '../src/board-audit.js';
import { BoardCache } from '../src/board-cache.js';

// Offline audit of the saved board: no provider calls, no research, no credits, nothing published.
// Usage: npm run audit:board -- [--at ISO_TIME] [--json]
const args = process.argv.slice(2);
const atIndex = args.indexOf('--at');
const file = process.env.CROWNIQ_BOARD_CACHE_FILE ?? 'tmp/board-cache.json';
const saved = await new BoardCache(file).load();
if (!saved) throw new Error(`No saved board at ${file} (set CROWNIQ_BOARD_CACHE_FILE).`);
const at = atIndex >= 0 ? new Date(args[atIndex + 1] ?? '') : new Date(Date.parse(saved.board.fetchedAt) + 60_000);
if (!Number.isFinite(at.getTime())) throw new Error('Usage: npm run audit:board -- [--at ISO_TIME] [--json]');

const configured = (process.env.GKR_APPROVED_MODEL_VERSIONS ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const versions = process.env.GKR_MODEL_PRESET === 'stat_history_v1' ? [...configured, ...statHistoryReadyVersions] : configured;
const audit = auditSavedBoard(saved, createGkrRegistry(versions), at);

if (args.includes('--json')) {
  console.log(JSON.stringify(audit, null, 2));
} else {
  const f = audit.funnel, row = (label: string, value: number, detail = '') =>
    console.log(`${label.padEnd(34)}${String(value).padStart(8)}${detail ? '  ' + detail : ''}`);
  const list = (counts: Record<string, number>) => Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`Saved board ${file}, fetched ${saved.board.fetchedAt}, evaluated at ${audit.evaluatedAt}\n`);
  console.log('FUNNEL (each line counted once, in this order)');
  row('Lines on board', f.started);
  row('Game already started', f.eventStarted);
  row('Market has no model', f.marketNotModeled);
  row('Model not approved', f.modeledButUnapproved.total, list(f.modeledButUnapproved.reasons));
  row('Unclassified alternate', f.unknownAlternate);
  row('Missing required evidence', f.missingHardEvidence.total, list(f.missingHardEvidence.byKind));
  row('Evidence covers under 60%', f.coverageBelow60);
  row('Model favors the other side', f.offeredSideUnfavored.total,
    `opposite twin ${f.offeredSideUnfavored.oppositeTwin}, alternate only ${f.offeredSideUnfavored.alternateSide}`);
  row('Other passes', f.otherPass.total, list(f.otherPass.reasons));
  row('Scored', f.scored.total, list(f.scored.byBand));
  row('Ranked (best line per player)', f.rankedCount);
  console.log('\nPAYOUT MULTIPLIERS ON CLASSIFIED ALTERNATES (<1 / =1 / >1 / missing)');
  for (const tier of ['GOBLIN', 'DEMON'] as const) {
    const t = audit.tierMultipliers[tier];
    console.log(`${tier.padEnd(8)}${t.below1} / ${t.exactly1} / ${t.above1} / ${t.missing}`);
  }
  console.log('\nUNCLASSIFIED ALTERNATES');
  console.log('By reason: ' + list(audit.unknownAlternates.byReason));
  for (const item of audit.unknownAlternates.byMarket.slice(0, 15)) console.log(`  ${item.sport} ${item.market}: ${item.count}`);
  console.log(`\nNO_REGULAR_REFERENCE alternates whose Regular line has a near-identical name: ${audit.nameNearMisses.count}`);
  for (const item of audit.nameNearMisses.examples) console.log(`  "${item.alternate}" vs "${item.regular}" (${item.market})`);
}
