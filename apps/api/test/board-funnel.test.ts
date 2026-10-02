import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { analysisSchema, boardResponseSchema, evidenceSchema } from '@crowniq/contracts';
import type { Analysis, Evidence, PropLine } from '@crowniq/contracts';
import { ModelRegistry } from '@crowniq/engine';
import { fixtureAnalysis, fixtureAssessment, fixtureLine, now } from '../../../packages/engine/test/fixtures.js';
import { auditSavedBoard } from '../src/board-audit.js';
import { BoardCache } from '../src/board-cache.js';
import { boardFunnel, outcomeCounts } from '../src/board-funnel.js';

const line = (id: string, overrides: Partial<PropLine> = {}) =>
  fixtureLine({ id, sourceLineId: id, playerId: 'p-' + id, playerName: 'Player ' + id, ...overrides });
const pass = (target: PropLine, reasonCode: string, extra: Partial<Analysis> = {}): Analysis => analysisSchema.parse({
  ...fixtureAnalysis(target), direction: 'PASS', score: null, scoreBreakdown: [], scoreBand: 'PASS', reasonCode, ...extra });
const scored = (target: PropLine, band: string): Analysis =>
  analysisSchema.parse({ ...fixtureAnalysis(target), scoreBand: band });
const evidence = (id: string, kind: string): Evidence => evidenceSchema.parse({ id, entityType: 'PLAYER', entityId: 'x',
  eventId: 'test-event', market: null, kind, finding: 'Synthetic.', sourceName: 'Synthetic', sourceUrl: null,
  sourceType: 'OFFICIAL', retrievedAt: now.toISOString(), expiresAt: '2030-09-24T18:00:00.000Z', quality: 'HIGH',
  confidence: 1, numeric: { value: 1 } });

const requirements = {
  'NFL:passing_yards': { approved: true, required: ['projection:passing_yards', 'status:qb_available'],
    hardRequired: ['projection:passing_yards', 'status:qb_available'] },
  'NFL:player_receptions': { approved: false, required: [], hardRequired: [] },
};

test('the funnel puts every line in exactly one bucket, in order', () => {
  const lines = [
    line('started'), line('nomodel', { market: 'player_kicking_points' }), line('unapproved', { market: 'player_receptions' }),
    line('alt', { lineType: 'UNKNOWN_ALTERNATE' }), line('missing'), line('critical'), line('coverage'),
    // The model favors LESS on a MORE-only line. "twin" has a LESS line at the same number; "solo" does not.
    line('twin', { availableDirections: ['MORE'], threshold: 250 }),
    line('twin-less', { availableDirections: ['LESS'], threshold: 250, playerId: 'p-twin' }),
    line('solo', { availableDirections: ['MORE'], threshold: 260 }),
    line('other'), line('elite'), line('lean'),
  ];
  const ids = new Map(lines.map((item) => [item.id, item]));
  const analyses = [
    pass(ids.get('started')!, 'EVENT_ALREADY_STARTED'), pass(ids.get('nomodel')!, 'MODEL_SUPPORT_INCOMPLETE'),
    pass(ids.get('unapproved')!, 'MODEL_CALIBRATION_UNAPPROVED'), pass(ids.get('alt')!, 'UNCLASSIFIED_ALTERNATE'),
    // Saw a projection but no QB status, so status:qb_available is what is missing.
    pass(ids.get('missing')!, 'STALE_OR_MISSING_EVIDENCE', { evidenceIds: ['proj'] }),
    pass(ids.get('critical')!, 'CRITICAL_STATUS_UNCONFIRMED', { opposingFactors: ['status:weather_clear'] }),
    pass(ids.get('coverage')!, 'INSUFFICIENT_MODEL_COVERAGE'),
    pass(ids.get('twin')!, 'DIRECTION_UNAVAILABLE'), scored(ids.get('twin-less')!, 'PLAYABLE'),
    pass(ids.get('solo')!, 'DIRECTION_UNAVAILABLE'), pass(ids.get('other')!, 'INSUFFICIENT_EDGE'),
    scored(ids.get('elite')!, 'CROWN_ELITE'), scored(ids.get('lean')!, 'LEAN'),
  ];
  const board = boardResponseSchema.parse({ board: { provider: 'prizepicks', fetchedAt: now.toISOString(), lines },
    analyses, rankedLineIds: ['elite', 'twin-less'], builtAt: now.toISOString() });
  const funnel = boardFunnel(board, requirements, [evidence('proj', 'projection:passing_yards')]);
  assert.deepEqual(funnel, {
    started: 13, eventStarted: 1, marketNotModeled: 1,
    modeledButUnapproved: { total: 1, reasons: { MODEL_CALIBRATION_UNAPPROVED: 1 } }, unknownAlternate: 1,
    missingHardEvidence: { total: 2, byKind: { 'status:qb_available': 1, 'status:weather_clear': 1 } },
    coverageBelow60: 1, offeredSideUnfavored: { total: 2, oppositeTwin: 1, alternateSide: 1 },
    otherPass: { total: 1, reasons: { INSUFFICIENT_EDGE: 1 } },
    scored: { total: 3, byBand: { CROWN_ELITE: 1, LEAN: 1, PLAYABLE: 1 } }, rankedCount: 2 });
  const buckets = funnel.eventStarted + funnel.marketNotModeled + funnel.modeledButUnapproved.total + funnel.unknownAlternate +
    funnel.missingHardEvidence.total + funnel.coverageBelow60 + funnel.offeredSideUnfavored.total + funnel.otherPass.total +
    funnel.scored.total;
  assert.equal(buckets, funnel.started);
  // Scored lines are named by band, never all called PLAYABLE.
  const outcomes = outcomeCounts(board);
  assert.equal(outcomes.SCORED_LEAN, 1);
  assert.equal(outcomes.PLAYABLE, undefined);
});

function savedBoard() {
  const alt = (id: string, name: string, threshold: number, payoutMultiplier?: number) => line(id, {
    playerId: 'p-' + name, playerName: name, lineType: 'UNKNOWN_ALTERNATE', sourceMarketKey: 'player_pass_yds_alternate',
    availableDirections: ['MORE'], threshold, ...(payoutMultiplier === undefined ? {} : { payoutMultiplier }) });
  return { board: { provider: 'prizepicks' as const, fetchedAt: now.toISOString(), lines: [
    line('reg', { playerId: 'p-Ja’Marr Chase', playerName: 'Ja’Marr Chase', threshold: 250, availableDirections: ['MORE', 'LESS'] }),
    // Classified by threshold: lower is a Goblin, higher a Demon.
    alt('goblin', 'Ja’Marr Chase', 230, 0.8), alt('demon', 'Ja’Marr Chase', 270, 1.5), alt('demon2', 'Ja’Marr Chase', 280),
    // Same player, different apostrophe: the feed gave it another player id, so it has no Regular reference.
    alt('near', "Ja'Marr Chase", 240),
  ] }, evidence: [], researchStatus: 'OK' as const, lastSuccessfulRefresh: now.toISOString() };
}

test('the saved-board audit reports tier payouts, unclassified alternates and near-miss names', () => {
  const registry = new ModelRegistry();
  registry.register({ sport: 'NFL', market: 'passing_yards', version: 'audit-fixture', calibrationApproved: true,
    requiredEvidenceKinds: ['projection:passing_yards'], assess: ({ phase }) => fixtureAssessment(phase, 'MORE', 88) });
  const audit = auditSavedBoard(savedBoard(), registry, new Date(now.getTime() + 60_000));
  assert.equal(audit.funnel.started, 5);
  assert.deepEqual(audit.tierMultipliers, { GOBLIN: { below1: 1, exactly1: 0, above1: 0, missing: 0 },
    DEMON: { below1: 0, exactly1: 0, above1: 1, missing: 1 } });
  assert.equal(audit.unknownAlternates.byReason.NO_REGULAR_REFERENCE, 1);
  assert.deepEqual(audit.nameNearMisses, { count: 1, examples: [{ alternate: "Ja'Marr Chase", regular: 'Ja’Marr Chase',
    eventId: 'test-event', market: 'passing_yards' }] });
});

test('npm run audit:board reads the saved board offline and prints the funnel', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-audit-'));
  try {
    const file = join(folder, 'board.json');
    await new BoardCache(file).save(savedBoard());
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/audit-saved-board.ts', '--json'],
      { env: { ...process.env, CROWNIQ_BOARD_CACHE_FILE: file, GKR_APPROVED_MODEL_VERSIONS: '', GKR_MODEL_PRESET: 'custom' } });
    const report = JSON.parse(stdout);
    assert.equal(report.funnel.started, 5);
    assert.equal(report.evaluatedAt, new Date(now.getTime() + 60_000).toISOString());
    assert.equal(report.nameNearMisses.count, 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
