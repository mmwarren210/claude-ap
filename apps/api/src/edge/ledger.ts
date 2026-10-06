import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EdgePick, PropLine } from '@crowniq/contracts';
import { forecastReport, profileFor } from '@crowniq/edge';
import type { GradedForecast, StatRow } from '@crowniq/edge';
import type { GradeTarget } from '../box-score-results.js';

// Edge's own track record (ported from claude/edge-engine, per platform): every rated pick shown before its game, with the
// first and the last pre-start probability (the last is Edge's view at the close), graded from ESPN / MLB box scores and
// CrownIQ's own history. Measured only on its own terms: hit rate vs break-even, calibration, and (P4) closing-line value.
// Never compared with GKR.

export type EdgeOutcome = 'PENDING' | 'WIN' | 'LOSS' | 'PUSH' | 'VOID';

export interface TrackedEdgePick {
  id: string; platform: string; key: string; lineId: string; sport: string; league: string; eventId: string; eventName: string;
  eventStartTime: string; playerId: string; playerName: string; team: string | null; homeTeam: string | null;
  awayTeam: string | null; market: string; threshold: number;
  lineType: string; side: 'MORE' | 'LESS'; tier: string; rating: string;
  firstProbability: number; probability: number; breakEven: number; edge: number | null;
  firstSeenAt: string; lastSeenAt: string; modelVersion: string;
  outcome: EdgeOutcome; actual: number | null; gradedAt: string | null; resultSource: string | null;
}

/** The result fact shape shared with GKR's product tracking (box scores, admin posts). */
export interface EdgeResultFact {
  readonly eventId: string; readonly playerId: string; readonly market: string;
  readonly status: string; readonly actual: number | null; readonly sourceName: string;
}

interface LedgerData { version: 1; picks: TrackedEdgePick[] }

const DAY = 86400_000;

/** Whether a pick is worth tracking: rated standard lines, and alternates Edge gives 62%+. Ladder-only reads aren't. */
export function trackable(pick: EdgePick): boolean {
  if (pick.tier === 'LADDER') return false;
  return pick.edge !== null ? pick.rating !== 'NONE' : pick.probability >= .62;
}

export function outcomeFor(side: 'MORE' | 'LESS', threshold: number, actual: number): EdgeOutcome {
  if (actual === threshold) return 'PUSH';
  return (side === 'MORE' ? actual > threshold : actual < threshold) ? 'WIN' : 'LOSS';
}

/** The line a tracked pick was made on, in the shape the box-score grader reads. */
export function gradeTarget(pick: TrackedEdgePick): GradeTarget {
  const line: PropLine = { id: pick.lineId, provider: 'prizepicks', sourceLineId: pick.lineId, sourceLineIdIsSynthetic: false,
    sport: pick.sport as PropLine['sport'], league: pick.league, eventId: pick.eventId, eventName: pick.eventName,
    eventStartTime: pick.eventStartTime, playerId: pick.playerId, playerName: pick.playerName, team: pick.team, opponent: null,
    homeTeam: pick.homeTeam, awayTeam: pick.awayTeam, market: pick.market, threshold: pick.threshold,
    availableDirections: [pick.side], lineType: pick.lineType as PropLine['lineType'], fetchedAt: pick.lastSeenAt };
  return { eventId: pick.eventId, playerId: pick.playerId, lineSnapshot: line };
}

export class EdgeLedger {
  private chain: Promise<unknown> = Promise.resolve();
  private cache: LedgerData | null = null;
  constructor(private readonly path: string | null, private readonly clock: () => Date = () => new Date(),
    private readonly maxPerRecord = 2000) {}

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task); this.chain = result.catch(() => undefined); return result;
  }
  private async read(): Promise<LedgerData> {
    if (this.cache) return this.cache;
    if (!this.path) return this.cache = { version: 1, picks: [] };
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as LedgerData;
      if (value.version !== 1 || !Array.isArray(value.picks)) throw new Error('INVALID_EDGE_LEDGER');
      this.cache = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cache = { version: 1, picks: [] };
    }
    return this.cache;
  }
  private async write(data: LedgerData) {
    this.cache = data;
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(data), { mode: 0o600 }); await rename(temporary, this.path); }
    finally { await rm(temporary, { force: true }); }
  }

  /** Records picks before their start; `teams` gives each line's teams for box-score matching. */
  async record(picks: readonly EdgePick[], teams: (lineId: string) => { team: string | null; home: string | null;
    away: string | null } = () => ({ team: null, home: null, away: null })): Promise<{ added: number; updated: number }> {
    return this.exclusive(async () => {
      const now = this.clock(), iso = now.toISOString();
      const data = await this.read();
      const byId = new Map(data.picks.map((pick) => [pick.id, pick]));
      const candidates = picks.filter((pick) => trackable(pick) && Date.parse(pick.eventStartTime) > now.getTime())
        .sort((a, b) => b.edgeScore - a.edgeScore || b.probability - a.probability).slice(0, this.maxPerRecord);
      let added = 0, updated = 0;
      for (const pick of candidates) {
        const id = `${pick.platform}|${pick.key}|${pick.side}`;
        const existing = byId.get(id);
        if (existing) {
          if (existing.outcome !== 'PENDING') continue;
          Object.assign(existing, { probability: pick.probability, edge: pick.edge, rating: pick.rating,
            tier: pick.tier, breakEven: pick.breakEven, lastSeenAt: iso, lineId: pick.lineId });
          updated++; continue;
        }
        const side = teams(pick.lineId);
        const tracked: TrackedEdgePick = { id, platform: pick.platform, key: pick.key, lineId: pick.lineId, sport: pick.sport,
          league: pick.league, eventId: pick.eventId, eventName: pick.eventName, eventStartTime: pick.eventStartTime,
          playerId: pick.playerId, playerName: pick.playerName, team: side.team, homeTeam: side.home, awayTeam: side.away,
          market: pick.market, threshold: pick.threshold,
          lineType: pick.lineType, side: pick.side, tier: pick.tier, rating: pick.rating,
          firstProbability: pick.probability, probability: pick.probability, breakEven: pick.breakEven,
          edge: pick.edge, firstSeenAt: iso, lastSeenAt: iso, modelVersion: pick.modelVersion,
          outcome: 'PENDING', actual: null, gradedAt: null, resultSource: null };
        data.picks.push(tracked); byId.set(id, tracked); added++;
      }
      // Retention: graded picks for 180 days; picks that never get a result expire as VOID after 5 days.
      for (const pick of data.picks) {
        if (pick.outcome === 'PENDING' && Date.parse(pick.eventStartTime) < now.getTime() - 5 * DAY) {
          pick.outcome = 'VOID'; pick.resultSource = 'NO_RESULT_AVAILABLE'; pick.gradedAt = iso;
        }
      }
      data.picks = data.picks.filter((pick) => Date.parse(pick.eventStartTime) > now.getTime() - 180 * DAY);
      if (added || updated) await this.write(data);
      return { added, updated };
    });
  }

  /** Grade from result facts (box scores, admin posts): same event, player and market. */
  async grade(facts: readonly EdgeResultFact[]): Promise<{ graded: number }> {
    return this.exclusive(async () => {
      const data = await this.read(), iso = this.clock().toISOString();
      const byKey = new Map(facts.map((fact) => [[fact.eventId, fact.playerId, fact.market].join('|'), fact]));
      let graded = 0;
      for (const pick of data.picks) {
        if (pick.outcome !== 'PENDING') continue;
        const fact = byKey.get([pick.eventId, pick.playerId, pick.market].join('|'));
        if (!fact) continue;
        pick.outcome = fact.status === 'FINAL' && fact.actual !== null ? outcomeFor(pick.side, pick.threshold, fact.actual) : 'VOID';
        pick.actual = fact.actual; pick.gradedAt = iso; pick.resultSource = fact.sourceName; graded++;
      }
      if (graded) await this.write(data);
      return { graded };
    });
  }

  /** Pending picks whose game started long enough ago to have a final box score. */
  async awaitingResults(minimumAgeHours = 4): Promise<TrackedEdgePick[]> {
    return this.exclusive(async () => {
      const cutoff = this.clock().getTime() - minimumAgeHours * 3600_000;
      return (await this.read()).picks.filter((pick) => pick.outcome === 'PENDING' &&
        Date.parse(pick.eventStartTime) < cutoff).map((pick) => ({ ...pick }));
    });
  }

  /** Grade from CrownIQ's own game rows dated within 20 hours of the start. */
  async gradeFromRows(rowsFor: (pick: TrackedEdgePick) => readonly StatRow[]): Promise<{ graded: number }> {
    return this.exclusive(async () => {
      const data = await this.read(), iso = this.clock().toISOString();
      let graded = 0;
      for (const pick of data.picks) {
        if (pick.outcome !== 'PENDING') continue;
        const spec = profileFor(pick.sport, pick.market).stat;
        const start = Date.parse(pick.eventStartTime);
        const rows = rowsFor(pick).filter((row) => Math.abs(Date.parse(row.occurredAt) - start) <= 20 * 3600_000);
        for (const row of rows) {
          const override = row.marketValues?.[pick.market];
          const value = Number.isFinite(override) ? override! : spec?.value(row.metrics) ?? null;
          if (value === null || !Number.isFinite(value)) continue;
          const opportunity = spec?.opportunity?.(row.metrics);
          pick.outcome = opportunity === 0 ? 'VOID' : outcomeFor(pick.side, pick.threshold, value);
          pick.actual = value; pick.gradedAt = iso; pick.resultSource = 'internal-history'; graded++;
          break;
        }
      }
      if (graded) await this.write(data);
      return { graded };
    });
  }

  async calibrationRows(): Promise<GradedForecast[]> {
    return this.exclusive(async () => (await this.read()).picks
      .filter((pick) => pick.outcome === 'WIN' || pick.outcome === 'LOSS')
      .map((pick) => ({ probability: pick.probability, hit: pick.outcome === 'WIN', sport: pick.sport })));
  }

  /** Edge's record on its own terms, overall and per platform, tier, rating and sport. */
  async report() {
    return this.exclusive(async () => {
      const picks = (await this.read()).picks;
      const decided = picks.filter((pick) => pick.outcome === 'WIN' || pick.outcome === 'LOSS');
      const rows = (subset: readonly TrackedEdgePick[]) => subset.map((pick) =>
        ({ probability: pick.probability, hit: pick.outcome === 'WIN', sport: pick.sport }));
      const summary = (subset: readonly TrackedEdgePick[]) => {
        const report = forecastReport(rows(subset));
        const standard = subset.filter((pick) => pick.edge !== null);
        const hits = standard.filter((pick) => pick.outcome === 'WIN').length;
        return { graded: report.graded, hitRate: report.hitRate, averageForecast: report.averageForecast, brier: report.brier,
          standardLines: { graded: standard.length, hitRate: standard.length ? hits / standard.length : null,
            averageBreakEven: standard.length ? standard.reduce((sum, pick) => sum + pick.breakEven, 0) / standard.length : null } };
      };
      const groupBy = (select: (pick: TrackedEdgePick) => string) => Object.fromEntries(
        [...new Set(decided.map(select))].sort().map((key) => [key, summary(decided.filter((pick) => select(pick) === key))]));
      const standard = decided.filter((pick) => pick.edge !== null);
      const standardHits = standard.filter((pick) => pick.outcome === 'WIN').length;
      return {
        tracked: picks.length,
        pending: picks.filter((pick) => pick.outcome === 'PENDING').length,
        voided: picks.filter((pick) => pick.outcome === 'VOID' || pick.outcome === 'PUSH').length,
        overall: forecastReport(rows(decided)),
        standardLines: { graded: standard.length, hitRate: standard.length ? standardHits / standard.length : null,
          averageBreakEven: standard.length ? standard.reduce((sum, pick) => sum + pick.breakEven, 0) / standard.length : null },
        byPlatform: groupBy((pick) => pick.platform ?? 'prizepicks'),
        byTier: groupBy((pick) => pick.tier), byRating: groupBy((pick) => pick.rating),
        bySport: groupBy((pick) => pick.sport),
        recent: picks.filter((pick) => pick.outcome !== 'PENDING')
          .sort((a, b) => b.eventStartTime.localeCompare(a.eventStartTime)).slice(0, 50),
      };
    });
  }
}
