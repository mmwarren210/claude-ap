import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Analysis, BoardResponse, EdgePick, EngineRecord, HeadToHeadReport, PlayableDirection } from '@crowniq/contracts';
import { profileFor } from '@crowniq/edge';
import type { StatRow } from '@crowniq/edge';
import type { ResultFact } from './product-ledger.js';

/** One standard PrizePicks line (player, market, number) with each engine's final pre-start call. */
export interface HeadToHeadLine {
  id: string; sport: string; league: string; eventId: string; eventName: string; eventStartTime: string;
  playerId: string; playerName: string; market: string; threshold: number;
  firstSeenAt: string; lastSeenAt: string;
  gkr: { side: PlayableDirection; score: number | null; band: string | null; top: boolean; calledAt: string } | null;
  edge: { side: PlayableDirection; probability: number; edge: number | null; rating: string; tier: string;
    top: boolean; calledAt: string } | null;
  /** Edge's latest pre-start probability of MORE when sportsbooks priced the line (the closing market view). */
  closeMore: number | null;
  breakEven: number;
  outcome: 'PENDING' | 'FINAL' | 'VOID'; actual: number | null; gradedAt: string | null; resultSource: string | null;
}

interface Data { version: 1; lines: HeadToHeadLine[] }

const DAY = 86400_000;
const lineKey = (eventId: string, playerId: string, market: string, threshold: number) =>
  [eventId, playerId, market, threshold].join('|');

/** GKR's call for a player/market/number from its analyses of the MORE and LESS line ids. */
export function gkrCall(analyses: ReadonlyMap<string, Analysis>, lineIds: readonly (string | null)[]):
  { direction: Analysis['direction']; score: number | null; scoreBand: NonNullable<Analysis['scoreBand']> | null; reasonCode: string | null } | null {
  const found = lineIds.map((id) => id ? analyses.get(id) : undefined).filter((item): item is Analysis => !!item);
  if (!found.length) return null;
  const called = found.find((item) => item.direction !== 'PASS');
  const chosen = called ?? found[0];
  return { direction: chosen.direction, score: chosen.score, scoreBand: chosen.scoreBand ?? null, reasonCode: chosen.reasonCode };
}

type Side = 'WIN' | 'LOSS' | 'PUSH';
const result = (side: PlayableDirection, threshold: number, actual: number): Side =>
  actual === threshold ? 'PUSH' : (side === 'MORE' ? actual > threshold : actual < threshold) ? 'WIN' : 'LOSS';

/** Wilson 95% interval for a hit rate. */
export function wilson(wins: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.96, p = wins / n, denominator = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Head-to-head ledger: on every Edge pricing pass it snapshots GKR's and Edge's calls on the same standard lines,
 * then grades both from the same result. Calls are sticky: an engine's latest pre-start side is kept even if a later
 * refresh drops it (for example when GKR evidence expires near game time), so neither engine is penalized for that.
 */
export class HeadToHeadLedger {
  private chain: Promise<unknown> = Promise.resolve();
  private cache: Data | null = null;
  constructor(private readonly path: string, private readonly clock: () => Date = () => new Date()) {}

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const out = this.chain.then(task); this.chain = out.catch(() => undefined); return out;
  }
  private async read(): Promise<Data> {
    if (this.cache) return this.cache;
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Data;
      if (value.version !== 1 || !Array.isArray(value.lines)) throw new Error('INVALID_HEAD_TO_HEAD_LEDGER');
      this.cache = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cache = { version: 1, lines: [] };
    }
    return this.cache;
  }
  private async write(data: Data) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(data), { mode: 0o600 }); await rename(temporary, this.path); }
    finally { await rm(temporary, { force: true }); }
    this.cache = data;
  }

  /** Snapshot both engines on every standard line either engine calls. */
  async record(board: BoardResponse, picks: readonly EdgePick[], breakEven: number): Promise<{ tracked: number }> {
    return this.exclusive(async () => {
      const now = this.clock(), iso = now.toISOString();
      const data = await this.read();
      const byId = new Map(data.lines.map((line) => [line.id, line]));
      const analyses = new Map(board.analyses.map((analysis) => [analysis.lineId, analysis]));
      const edgeByKey = new Map(picks.filter((pick) => pick.lineType === 'REGULAR')
        .map((pick) => [lineKey(pick.eventId, pick.playerId, pick.market, pick.threshold), pick]));
      // Group the board's standard lines so GKR is read across both the MORE and LESS line ids.
      const groups = new Map<string, typeof board.board.lines>();
      for (const line of board.board.lines) {
        if (line.lineType !== 'REGULAR' || Date.parse(line.eventStartTime) <= now.getTime()) continue;
        const key = lineKey(line.eventId, line.playerId, line.market, line.threshold);
        groups.set(key, [...(groups.get(key) ?? []), line]);
      }
      let changed = 0;
      for (const [key, lines] of groups) {
        const first = lines[0];
        const gkr = gkrCall(analyses, lines.map((line) => line.id));
        const pick = edgeByKey.get(key);
        const gkrCalled = gkr && gkr.direction !== 'PASS';
        const edgeCalled = pick && pick.edge !== null && pick.rating !== 'NONE';
        let entry = byId.get(key);
        if (!entry && !gkrCalled && !edgeCalled) continue;
        if (entry && entry.outcome !== 'PENDING') continue;
        if (!entry) {
          entry = { id: key, sport: first.sport, league: first.league, eventId: first.eventId, eventName: first.eventName,
            eventStartTime: first.eventStartTime, playerId: first.playerId, playerName: first.playerName,
            market: first.market, threshold: first.threshold, firstSeenAt: iso, lastSeenAt: iso, gkr: null, edge: null,
            closeMore: null, breakEven, outcome: 'PENDING', actual: null, gradedAt: null, resultSource: null };
          data.lines.push(entry); byId.set(key, entry);
        }
        entry.lastSeenAt = iso; entry.breakEven = breakEven;
        if (gkrCalled) entry.gkr = { side: gkr.direction as PlayableDirection, score: gkr.score, band: gkr.scoreBand ?? null,
          top: (gkr.score ?? 0) >= 80, calledAt: iso };
        if (edgeCalled) entry.edge = { side: pick.side, probability: pick.probability, edge: pick.edge, rating: pick.rating,
          tier: pick.tier, top: pick.rating === 'STRONG' || pick.rating === 'ELITE', calledAt: iso };
        if (pick && (pick.tier === 'SHARP' || pick.tier === 'MARKET')) {
          entry.closeMore = pick.side === 'MORE' ? pick.probability : pick.oppositeProbability;
        }
        changed++;
      }
      for (const line of data.lines) {
        if (line.outcome === 'PENDING' && Date.parse(line.eventStartTime) < now.getTime() - 5 * DAY) {
          line.outcome = 'VOID'; line.resultSource = 'NO_RESULT_AVAILABLE'; line.gradedAt = iso;
        }
      }
      data.lines = data.lines.filter((line) => Date.parse(line.eventStartTime) > now.getTime() - 365 * DAY);
      if (changed) await this.write(data);
      return { tracked: changed };
    });
  }

  async awaitingResults(minimumAgeHours = 4): Promise<HeadToHeadLine[]> {
    return this.exclusive(async () => {
      const cutoff = this.clock().getTime() - minimumAgeHours * 3600_000;
      return (await this.read()).lines.filter((line) => line.outcome === 'PENDING' &&
        Date.parse(line.eventStartTime) < cutoff).map((line) => ({ ...line }));
    });
  }

  async grade(facts: readonly ResultFact[]): Promise<{ graded: number }> {
    return this.exclusive(async () => {
      const data = await this.read(), iso = this.clock().toISOString();
      const byKey = new Map(facts.map((fact) => [[fact.eventId, fact.playerId, fact.market].join('|'), fact]));
      let graded = 0;
      for (const line of data.lines) {
        if (line.outcome !== 'PENDING') continue;
        const fact = byKey.get([line.eventId, line.playerId, line.market].join('|'));
        if (!fact) continue;
        const final = fact.status === 'FINAL' && fact.actual !== null;
        line.outcome = final ? 'FINAL' : 'VOID'; line.actual = fact.actual;
        line.gradedAt = iso; line.resultSource = fact.sourceName; graded++;
      }
      if (graded) await this.write(data);
      return { graded };
    });
  }

  async gradeFromRows(rowsFor: (line: HeadToHeadLine) => readonly StatRow[]): Promise<{ graded: number }> {
    return this.exclusive(async () => {
      const data = await this.read(), iso = this.clock().toISOString();
      let graded = 0;
      for (const line of data.lines) {
        if (line.outcome !== 'PENDING') continue;
        const spec = profileFor(line.sport, line.market).stat, start = Date.parse(line.eventStartTime);
        for (const row of rowsFor(line).filter((item) => Math.abs(Date.parse(item.occurredAt) - start) <= 20 * 3600_000)) {
          const override = row.marketValues?.[line.market];
          const value = Number.isFinite(override) ? override! : spec?.value(row.metrics) ?? null;
          if (value === null || !Number.isFinite(value)) continue;
          line.outcome = spec?.opportunity?.(row.metrics) === 0 ? 'VOID' : 'FINAL';
          line.actual = value; line.gradedAt = iso; line.resultSource = 'internal-history'; graded++;
          break;
        }
      }
      if (graded) await this.write(data);
      return { graded };
    });
  }

  async report(): Promise<HeadToHeadReport> {
    return this.exclusive(async () => buildReport((await this.read()).lines, this.clock()));
  }
}

function record(lines: readonly HeadToHeadLine[], engine: 'gkr' | 'edge', top: boolean): EngineRecord {
  const calls = lines.filter((line) => line[engine] && (!top || line[engine]!.top));
  let wins = 0, losses = 0, pushes = 0, units = 0;
  let closingTotal = 0, closingSamples = 0, beat = 0;
  for (const line of calls) {
    const call = line[engine]!;
    if (line.closeMore !== null) {
      const fair = call.side === 'MORE' ? line.closeMore : 1 - line.closeMore;
      closingTotal += fair; closingSamples++; if (fair > line.breakEven) beat++;
    }
    if (line.outcome !== 'FINAL' || line.actual === null) continue;
    const outcome = result(call.side, line.threshold, line.actual);
    if (outcome === 'PUSH') { pushes++; continue; }
    if (outcome === 'WIN') { wins++; units += 1 / line.breakEven - 1; } else { losses++; units -= 1; }
  }
  const graded = wins + losses;
  const interval = wilson(wins, graded);
  return { calls: calls.length, graded, wins, losses, pushes, hitRate: graded ? round(wins / graded) : null,
    ci95: interval ? [round(interval[0]), round(interval[1])] : null, units: round(units, 2),
    roi: graded ? round(units / graded) : null,
    closingFair: closingSamples ? round(closingTotal / closingSamples) : null,
    beatCloseRate: closingSamples ? round(beat / closingSamples) : null, closingSamples };
}

/** Two-sided sign test of `wins` out of `n` against 50/50 (normal approximation with continuity correction). */
function signTest(wins: number, n: number): number | null {
  if (!n) return null;
  const z = Math.max(0, Math.abs(wins - n / 2) - .5) / Math.sqrt(n / 4);
  const t = 1 / (1 + .2316419 * z), d = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const tail = d * t * (.319381530 + t * (-.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return round(Math.min(1, 2 * tail));
}

export function buildReport(lines: readonly HeadToHeadLine[], now: Date): HeadToHeadReport {
  const breakEven = lines.length ? lines[lines.length - 1].breakEven : .5421;
  const tier = (top: boolean, subset = lines) => ({ gkr: record(subset, 'gkr', top), edge: record(subset, 'edge', top) });
  const both = lines.filter((line) => line.gkr && line.edge);
  const disagree = both.filter((line) => line.gkr!.side !== line.edge!.side);
  let gkrWins = 0, edgeWins = 0, disagreementsGraded = 0;
  for (const line of disagree) {
    if (line.outcome !== 'FINAL' || line.actual === null || line.actual === line.threshold) continue;
    disagreementsGraded++;
    if (result(line.edge!.side, line.threshold, line.actual) === 'WIN') edgeWins++; else gkrWins++;
  }
  const all = tier(false);
  // Primary verdict: the lines where they took opposite sides. Same line, same moment, one result, so a sign test
  // against 50/50 is the cleanest comparison. Hit rate alone would reward an engine for making fewer, safer calls.
  const minimum = 30;
  const summary = `Units: Edge ${all.edge.units >= 0 ? '+' : ''}${all.edge.units}u vs GKR ${all.gkr.units >= 0 ? '+' : ''}${all.gkr.units}u. ` +
    `Hit rate: Edge ${all.edge.hitRate === null ? '—' : (all.edge.hitRate * 100).toFixed(1) + '%'} vs GKR ${all.gkr.hitRate === null ? '—' : (all.gkr.hitRate * 100).toFixed(1) + '%'}.`;
  let leader: HeadToHeadReport['leader'];
  if (disagreementsGraded < minimum) {
    leader = { engine: 'TOO_EARLY', margin: null, pValue: null,
      note: `Needs ${minimum} graded disagreements to call it (${disagreementsGraded} so far, Edge ${edgeWins}–${gkrWins} GKR). ${summary}` };
  } else {
    const margin = round(edgeWins / disagreementsGraded - .5);
    const p = signTest(edgeWins, disagreementsGraded);
    const engine = edgeWins > gkrWins ? 'EDGE' : edgeWins < gkrWins ? 'GKR' : 'TIE';
    const name = engine === 'EDGE' ? 'Edge' : 'GKR';
    leader = { engine, margin, pValue: p, note: `${engine === 'TIE' ? 'Level' : name + ' leads'} ${edgeWins}–${gkrWins} when they disagree` +
      `${p !== null && p < .05 ? `; statistically significant (p=${p}).` : `; not yet significant${p === null ? '' : ` (p=${p})`}.`} ${summary}` };
  }
  const days = new Map<string, { gkrUnits: number; edgeUnits: number; gkrGraded: number; edgeGraded: number }>();
  for (const line of lines) {
    if (line.outcome !== 'FINAL' || line.actual === null) continue;
    const date = line.eventStartTime.slice(0, 10), day = days.get(date) ?? { gkrUnits: 0, edgeUnits: 0, gkrGraded: 0, edgeGraded: 0 };
    for (const engine of ['gkr', 'edge'] as const) {
      const call = line[engine]; if (!call) continue;
      const outcome = result(call.side, line.threshold, line.actual);
      if (outcome === 'PUSH') continue;
      const delta = outcome === 'WIN' ? 1 / line.breakEven - 1 : -1;
      if (engine === 'gkr') { day.gkrUnits += delta; day.gkrGraded++; } else { day.edgeUnits += delta; day.edgeGraded++; }
    }
    days.set(date, day);
  }
  const daily = [...days].sort((a, b) => a[0].localeCompare(b[0])).slice(-60).map(([date, day]) => ({ date,
    gkrUnits: round(day.gkrUnits, 2), edgeUnits: round(day.edgeUnits, 2), gkrGraded: day.gkrGraded, edgeGraded: day.edgeGraded }));
  const bySport = Object.fromEntries([...new Set(lines.map((line) => line.sport))].sort()
    .map((sport) => [sport, tier(false, lines.filter((line) => line.sport === sport))]));
  const recentDisagreements = [...disagree].sort((a, b) => b.eventStartTime.localeCompare(a.eventStartTime)).slice(0, 25)
    .map((line) => {
      const decided = line.outcome === 'FINAL' && line.actual !== null;
      const winner = !decided ? 'PENDING' as const : line.actual === line.threshold ? 'PUSH' as const
        : result(line.edge!.side, line.threshold, line.actual!) === 'WIN' ? 'EDGE' as const : 'GKR' as const;
      return { playerName: line.playerName, sport: line.sport, market: line.market, threshold: line.threshold,
        eventStartTime: line.eventStartTime, actual: line.actual,
        gkr: { side: line.gkr!.side, score: line.gkr!.score }, edge: { side: line.edge!.side, probability: line.edge!.probability },
        winner };
    });
  return { since: lines.length ? lines.reduce((min, line) => line.firstSeenAt < min ? line.firstSeenAt : min, lines[0].firstSeenAt) : null,
    updatedAt: now.toISOString(), breakEven: round(breakEven), tiers: { top: tier(true), all },
    overlap: { both: both.length, agree: both.length - disagree.length, disagree: disagree.length, disagreementsGraded,
      gkrWins, edgeWins, gkrOnly: lines.filter((line) => line.gkr && !line.edge).length,
      edgeOnly: lines.filter((line) => line.edge && !line.gkr).length },
    leader, daily, bySport, recentDisagreements };
}
