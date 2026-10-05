import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Analysis, BoardResponse, EdgePick, PropLine } from '@crowniq/contracts';
import { headToHeadReportSchema } from '@crowniq/contracts';
import { buildReport, HeadToHeadLedger, wilson } from '../src/head-to-head.js';
import type { HeadToHeadLine } from '../src/head-to-head.js';

// Synthetic lines, analyses and results only.
const start = '2030-01-11T00:00:00Z';
const line = (id: string, player: string, direction: 'MORE' | 'LESS', threshold = 20.5): PropLine => ({
  id, provider: 'prizepicks', sourceLineId: id, sourceLineIdIsSynthetic: false, sport: 'NBA', league: 'NBA',
  eventId: 'game', eventName: 'A @ B', eventStartTime: start, playerId: player, playerName: player, team: null,
  opponent: null, market: 'player_points', threshold, availableDirections: [direction], lineType: 'REGULAR',
  fetchedAt: '2030-01-10T12:00:00Z' });
const analysis = (lineId: string, direction: 'MORE' | 'LESS' | 'PASS', score: number | null): Analysis => ({
  lineId, direction, score, scoreBreakdown: [], assessments: [], evidenceIds: [], evidenceQuality: 'HIGH',
  dangerZone: false, ruleChecks: [], supportingFactors: [], opposingFactors: [], rationale: 'fixture',
  reasonCode: direction === 'PASS' ? 'INSUFFICIENT_EDGE' : null, modelVersion: 'fixture',
  scoreBand: score === null ? 'PASS' : score >= 86 ? 'CROWN_STRONG' : score >= 80 ? 'PLAYABLE' : 'LEAN' });
const pick = (player: string, side: 'MORE' | 'LESS', probability: number, rating: EdgePick['rating']): EdgePick => ({
  key: player, lineId: `${player}-${side}`, oppositeLineId: `${player}-${side === 'MORE' ? 'LESS' : 'MORE'}`,
  sport: 'NBA', league: 'NBA', eventId: 'game', eventName: 'A @ B', eventStartTime: start, playerId: player,
  playerName: player, market: 'player_points', threshold: 20.5, lineType: 'REGULAR', side, probability,
  pushProbability: 0, oppositeProbability: 1 - probability, breakEven: .5421, edge: probability - .5421,
  requiredPayoutFactor: .5421 / probability, edgeScore: 80, rating, tier: 'SHARP',
  projection: { mean: 22, median: 22, sd: 6, family: 'NEGBIN' }, lineGap: 1,
  sources: { market: null, stats: null, ladder: null }, reasons: [], warnings: [], calibrated: false, modelVersion: 'EDGE-1.0' });

function board(analyses: Analysis[]): BoardResponse {
  const players = ['agree', 'disagree', 'gkr-only', 'edge-only'];
  return { board: { provider: 'prizepicks', fetchedAt: '2030-01-10T12:00:00Z',
    lines: players.flatMap((player) => [line(`${player}-MORE`, player, 'MORE'), line(`${player}-LESS`, player, 'LESS')]) },
  analyses, rankedLineIds: [], builtAt: '2030-01-10T12:00:00Z' };
}

test('head-to-head snapshots both engines on the same lines and grades them from one result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crowniq-h2h-'));
  let now = new Date('2030-01-10T12:00:00Z');
  const ledger = new HeadToHeadLedger(join(directory, 'h2h.json'), () => now);
  try {
    const analyses = [analysis('agree-MORE', 'MORE', 88), analysis('agree-LESS', 'PASS', null),
      analysis('disagree-MORE', 'MORE', 82), analysis('gkr-only-LESS', 'LESS', 74),
      analysis('edge-only-MORE', 'PASS', null)];
    const picks = [pick('agree', 'MORE', .61, 'STRONG'), pick('disagree', 'LESS', .6, 'STRONG'),
      pick('gkr-only', 'MORE', .53, 'NONE'), pick('edge-only', 'MORE', .58, 'VALUE')];
    assert.deepEqual(await ledger.record(board(analyses), picks, .5421), { tracked: 4 });
    // A later refresh where GKR's evidence expired: its earlier call must be kept (sticky).
    now = new Date('2030-01-10T20:00:00Z');
    await ledger.record(board([analysis('agree-MORE', 'PASS', null)]), picks, .5421);

    let report = headToHeadReportSchema.parse(await ledger.report());
    assert.equal(report.overlap.both, 2);
    assert.equal(report.overlap.disagree, 1);
    assert.equal(report.overlap.gkrOnly, 1);
    assert.equal(report.overlap.edgeOnly, 1);
    assert.equal(report.tiers.all.gkr.calls, 3);
    assert.equal(report.tiers.all.edge.calls, 3);
    assert.equal(report.tiers.top.gkr.calls, 2, 'GKR top = score 80+');
    assert.equal(report.tiers.top.edge.calls, 2, 'Edge top = STRONG or ELITE');
    assert.equal(report.recentDisagreements[0].winner, 'PENDING');

    now = new Date('2030-01-11T08:00:00Z');
    const fact = (playerId: string, actual: number) => ({ eventId: 'game', playerId, market: 'player_points',
      status: 'FINAL' as const, actual, sourceName: 'fixture', sourceUrl: 'https://example.com',
      completedAt: '2030-01-11T03:00:00Z' });
    assert.deepEqual(await ledger.grade([fact('agree', 25), fact('disagree', 15), fact('gkr-only', 30),
      fact('edge-only', 22)]), { graded: 4 });
    report = headToHeadReportSchema.parse(await ledger.report());
    // agree: both win. disagree: actual 15 < 20.5, so Edge (LESS) wins and GKR (MORE) loses.
    // gkr-only: GKR LESS loses at 30. edge-only: Edge MORE wins at 22.
    assert.deepEqual([report.tiers.all.gkr.wins, report.tiers.all.gkr.losses], [1, 2]);
    assert.deepEqual([report.tiers.all.edge.wins, report.tiers.all.edge.losses], [3, 0]);
    assert.deepEqual([report.overlap.edgeWins, report.overlap.gkrWins], [1, 0]);
    assert.equal(report.recentDisagreements[0].winner, 'EDGE');
    const winUnits = 1 / .5421 - 1;
    assert.ok(Math.abs(report.tiers.all.edge.units - 3 * winUnits) < .02);
    assert.ok(Math.abs(report.tiers.all.gkr.units - (winUnits - 2)) < .02);
    assert.equal(report.leader.engine, 'TOO_EARLY');
    assert.equal(report.daily.length, 1);
    assert.equal(report.daily[0].edgeGraded, 3);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); }
});

test('leader needs enough graded calls and reports significance', () => {
  const make = (index: number, gkrWins: boolean, edgeWins: boolean): HeadToHeadLine => ({
    id: String(index), sport: 'NBA', league: 'NBA', eventId: 'e' + index, eventName: 'x', eventStartTime: start,
    playerId: 'p' + index, playerName: 'p', market: 'player_points', threshold: 20.5, firstSeenAt: start, lastSeenAt: start,
    gkr: { side: gkrWins ? 'MORE' : 'LESS', score: 85, band: 'PLAYABLE', top: true, calledAt: start },
    edge: { side: edgeWins ? 'MORE' : 'LESS', probability: .6, edge: .06, rating: 'STRONG', tier: 'SHARP', top: true, calledAt: start },
    closeMore: .6, breakEven: .5421, outcome: 'FINAL', actual: 25, gradedAt: start, resultSource: 'fixture' });
  // 400 lines: Edge right 62%, GKR right 50%.
  const lines = Array.from({ length: 400 }, (_, index) => make(index, index % 2 === 0, index % 50 < 31));
  const report = buildReport(lines, new Date(start));
  assert.equal(report.leader.engine, 'EDGE');
  assert.ok(report.leader.pValue! < .05);
  assert.ok(report.tiers.all.edge.ci95![0] > .5);
  const [low, high] = wilson(50, 100)!;
  assert.ok(low < .5 && high > .5);
});
