import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EdgePick } from '@crowniq/contracts';
import { forecastReport, normalizePlayerName, profileFor } from '@crowniq/edge';
import type { GradedForecast, StatRow } from '@crowniq/edge';
import type { ResultFact } from './product-ledger.js';

export type EdgeOutcome = 'PENDING' | 'WIN' | 'LOSS' | 'PUSH' | 'VOID';

export interface TrackedEdgePick {
  id: string; key: string; lineId: string; sport: string; league: string; eventId: string; eventName: string;
  eventStartTime: string; playerId: string; playerName: string; market: string; threshold: number;
  lineType: string; side: 'MORE' | 'LESS'; tier: string; rating: string;
  firstProbability: number; probability: number; breakEven: number; edge: number | null;
  firstSeenAt: string; lastSeenAt: string; modelVersion: string;
  outcome: EdgeOutcome; actual: number | null; gradedAt: string | null; resultSource: string | null;
}

interface LedgerData { version: 1; picks: TrackedEdgePick[] }

const DAY = 86400_000;

/** Whether a pick is worth tracking for grading/calibration. */
export function trackable(pick: EdgePick): boolean {
  if (pick.tier === 'LADDER') return false;
  return pick.edge !== null ? pick.rating !== 'NONE' : pick.probability >= .62;
}

export function outcomeFor(side: 'MORE' | 'LESS', threshold: number, actual: number): EdgeOutcome {
  if (actual === threshold) return 'PUSH';
  return (side === 'MORE' ? actual > threshold : actual < threshold) ? 'WIN' : 'LOSS';
}

/** Durable record of every Edge pick shown before its event, graded from verified results.
 * The latest pre-start probability is kept (the closest-to-close forecast) alongside the
 * first one, and it is never updated after the event starts. */
export class EdgeLedger {
  private chain: Promise<unknown> = Promise.resolve();
  private cache: LedgerData | null = null;
  constructor(private readonly path: string, private readonly clock: () => Date = () => new Date(),
    private readonly maxPerRecord = 1500) {}

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task); this.chain = result.catch(() => undefined); return result;
  }
  private async read(): Promise<LedgerData> {
    if (this.cache) return this.cache;
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
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(data), { mode: 0o600 }); await rename(temporary, this.path); }
    finally { await rm(temporary, { force: true }); }
    this.cache = data;
  }

  async record(picks: readonly EdgePick[]): Promise<{ added: number; updated: number }> {
    return this.exclusive(async () => {
      const now = this.clock(), iso = now.toISOString();
      const data = await this.read();
      const byId = new Map(data.picks.map((pick) => [pick.id, pick]));
      const candidates = picks.filter((pick) => trackable(pick) && Date.parse(pick.eventStartTime) > now.getTime())
        .sort((a, b) => b.edgeScore - a.edgeScore || b.probability - a.probability).slice(0, this.maxPerRecord);
      let added = 0, updated = 0;
      for (const pick of candidates) {
        const id = pick.key + '|' + pick.side;
        const existing = byId.get(id);
        if (existing) {
          if (existing.outcome !== 'PENDING') continue;
          Object.assign(existing, { probability: pick.probability, edge: pick.edge, rating: pick.rating,
            tier: pick.tier, breakEven: pick.breakEven, lastSeenAt: iso, lineId: pick.lineId });
          updated++; continue;
        }
        const tracked: TrackedEdgePick = { id, key: pick.key, lineId: pick.lineId, sport: pick.sport,
          league: pick.league, eventId: pick.eventId, eventName: pick.eventName, eventStartTime: pick.eventStartTime,
          playerId: pick.playerId, playerName: pick.playerName, market: pick.market, threshold: pick.threshold,
          lineType: pick.lineType, side: pick.side, tier: pick.tier, rating: pick.rating,
          firstProbability: pick.probability, probability: pick.probability, breakEven: pick.breakEven,
          edge: pick.edge, firstSeenAt: iso, lastSeenAt: iso, modelVersion: pick.modelVersion,
          outcome: 'PENDING', actual: null, gradedAt: null, resultSource: null };
        data.picks.push(tracked); byId.set(id, tracked); added++;
      }
      // Retention: graded picks for 180 days; picks that never received a result expire as VOID.
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

  /** Grade from explicit result facts (same contract as GKR product tracking). */
  async grade(facts: readonly ResultFact[]): Promise<{ graded: number }> {
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

  /** Pending picks whose event finished long enough ago to have a final box score. */
  async awaitingResults(minimumAgeHours = 4): Promise<TrackedEdgePick[]> {
    return this.exclusive(async () => {
      const cutoff = this.clock().getTime() - minimumAgeHours * 3600_000;
      return (await this.read()).picks.filter((pick) => pick.outcome === 'PENDING' &&
        Date.parse(pick.eventStartTime) < cutoff).map((pick) => ({ ...pick }));
    });
  }

  /** Grade from game rows (internal history / Stat API) dated within 20 hours of the start. */
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

  async report() {
    return this.exclusive(async () => {
      const picks = (await this.read()).picks;
      const decided = picks.filter((pick) => pick.outcome === 'WIN' || pick.outcome === 'LOSS');
      const rows = (subset: readonly TrackedEdgePick[]) => subset.map((pick) =>
        ({ probability: pick.probability, hit: pick.outcome === 'WIN', sport: pick.sport }));
      const groupBy = (select: (pick: TrackedEdgePick) => string) => Object.fromEntries(
        [...new Set(decided.map(select))].sort().map((key) => {
          const subset = decided.filter((pick) => select(pick) === key);
          const report = forecastReport(rows(subset));
          return [key, { graded: report.graded, hitRate: report.hitRate, averageForecast: report.averageForecast,
            brier: report.brier }];
        }));
      const standard = decided.filter((pick) => pick.edge !== null);
      const standardHits = standard.filter((pick) => pick.outcome === 'WIN').length;
      return {
        tracked: picks.length,
        pending: picks.filter((pick) => pick.outcome === 'PENDING').length,
        voided: picks.filter((pick) => pick.outcome === 'VOID' || pick.outcome === 'PUSH').length,
        overall: forecastReport(rows(decided)),
        standardLines: { graded: standard.length, hitRate: standard.length ? standardHits / standard.length : null,
          averageBreakEven: standard.length ? standard.reduce((sum, pick) => sum + pick.breakEven, 0) / standard.length : null },
        byTier: groupBy((pick) => pick.tier), byRating: groupBy((pick) => pick.rating),
        bySport: groupBy((pick) => pick.sport),
        recent: picks.filter((pick) => pick.outcome !== 'PENDING')
          .sort((a, b) => b.eventStartTime.localeCompare(a.eventStartTime)).slice(0, 50),
      };
    });
  }
}

export const playerKey = (sport: string, name: string) => sport + '|' + normalizePlayerName(name);
