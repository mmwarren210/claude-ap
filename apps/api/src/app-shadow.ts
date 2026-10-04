import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Analysis, PropLine } from '@crowniq/contracts';
import { appBoard, otherApps, statKey } from './app-boards.js';
import type { AppLine, OtherApp } from './app-boards.js';
import type { BoxScoreResults } from './box-score-results.js';
import type { ResultFact } from './product-ledger.js';
import type { ScrapedLineStore } from './scrapers/line-store.js';

// Phase 1 of docs/PROPOSAL_APP_SCORING.md (owner approved 2026-10-04): GKR scores Underdog and Pick6 lines in shadow.
// Each app line that has the same player and stat on PrizePicks that day is run through the same approved model, at
// the app's own number and sides, on the research gathered for the PrizePicks line. Plays are recorded under shadow
// versions, graded from box scores, and never shown to users or added to GKR's tracked record.

const tags: Readonly<Record<OtherApp, string>> = { underdog: 'UD-SHADOW', pick6: 'P6-SHADOW' };
/** Go-live bars the owner approved: per app, on shadow plays scoring 80+. */
export const GO_LIVE = { minScore: 80, minGraded: 150, minHitRate: 0.56, maxGapToPrizePicks: 0.03 } as const;

export interface ShadowPick {
  readonly id: string; readonly app: OtherApp; readonly appLineId: string;
  readonly playerName: string; readonly market: string; readonly stat: string; readonly threshold: number;
  readonly direction: 'MORE' | 'LESS'; readonly score: number; readonly modelVersion: string;
  /** The PrizePicks number and whether the app's number is the same (option A) or different (option B). */
  readonly prizePicksThreshold: number; readonly sameNumber: boolean;
  readonly multiplier: number | null;
  readonly recordedAt: string; readonly eventStartTime: string;
  /** The line as scored, keyed to the PrizePicks game and player so box scores grade it. */
  readonly lineSnapshot: PropLine;
  grade: 'PENDING' | 'WIN' | 'LOSS' | 'PUSH' | 'DNP' | 'VOID'; actual: number | null;
}

/** The scoring the shadow needs from the board: the published PrizePicks board and the engine on a set of lines. */
export interface ShadowBoardSource {
  getBoard(): { board: { lines: readonly PropLine[] } } | null;
  scoreLines(lines: readonly PropLine[]): Analysis[];
}

/** PrizePicks GKR's own graded plays over the same window, for the comparison bar. */
export type PrizePicksRecord = (since: string, minScore: number) => Promise<{ graded: number; wins: number }>;

/** The app line as a board line on the PrizePicks game, so the PrizePicks research applies to it. */
export function shadowLine(app: AppLine, prizePicks: PropLine): PropLine {
  return { ...prizePicks, id: app.id, sourceLineId: app.id, threshold: app.threshold,
    availableDirections: [...app.availableDirections], lineType: app.lineType as PropLine['lineType'],
    fetchedAt: app.fetchedAt };
}

export class AppShadowScorer {
  private picks: ShadowPick[] = [];
  private loaded = false;
  private lastRun: { at: string; scored: number; plays: number; added: number } | null = null;
  private timers: NodeJS.Timeout[] = [];
  constructor(private readonly store: ScrapedLineStore, private readonly board: ShadowBoardSource,
    private readonly file: string | null, private readonly boxScores: BoxScoreResults | null,
    private readonly prizePicksRecord: PrizePicksRecord | null = null,
    private readonly clock: () => Date = () => new Date()) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try { this.picks = (JSON.parse(await readFile(this.file, 'utf8')) as { picks: ShadowPick[] }).picks; }
    catch { /* first run */ }
  }

  private async save() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ picks: this.picks }));
    await rename(temporary, this.file);
  }

  /**
   * Scores every app line that PrizePicks also lists, and records each play the first time it is seen before its game
   * (one record per app line, number and side).
   */
  async score(): Promise<{ scored: number; plays: number; added: number }> {
    await this.load();
    const published = this.board.getBoard(), now = this.clock();
    if (!published) return { scored: 0, plays: 0, added: 0 };
    const byKey = new Map<string, PropLine[]>();
    for (const line of published.board.lines) {
      const key = JSON.stringify([line.playerId, statKey(line.market), line.eventStartTime.slice(0, 10)]);
      byKey.set(key, [...byKey.get(key) ?? [], line]);
    }
    const known = new Set(this.picks.map((pick) => pick.id));
    let scored = 0, plays = 0, added = 0;
    for (const app of otherApps) {
      const { lines } = await appBoard(this.store, app, null);
      const pairs = lines.flatMap((line) => {
        const options = byKey.get(JSON.stringify([line.playerId, statKey(line.market), line.eventStartTime.slice(0, 10)])) ?? [];
        // The PrizePicks line whose research applies: standard first, then the closest number.
        const prizePicks = [...options].sort((a, b) => Number(b.lineType === 'REGULAR') - Number(a.lineType === 'REGULAR') ||
          Math.abs(a.threshold - line.threshold) - Math.abs(b.threshold - line.threshold))[0];
        return prizePicks && Date.parse(line.eventStartTime) > now.getTime() ? [{ line, prizePicks }] : [];
      });
      const analyses = this.board.scoreLines(pairs.map(({ line, prizePicks }) => shadowLine(line, prizePicks)));
      scored += pairs.length;
      pairs.forEach(({ line, prizePicks }, index) => {
        const analysis = analyses[index];
        if (!analysis || analysis.direction === 'PASS' || analysis.score === null || !analysis.modelVersion) return;
        plays++;
        const id = JSON.stringify([app, line.id, line.threshold, analysis.direction]);
        if (known.has(id)) return;
        known.add(id); added++;
        this.picks.push({ id, app, appLineId: line.id, playerName: line.playerName, market: prizePicks.market, stat: line.stat,
          threshold: line.threshold, direction: analysis.direction, score: analysis.score,
          modelVersion: `${analysis.modelVersion}-${tags[app]}`, prizePicksThreshold: prizePicks.threshold,
          sameNumber: prizePicks.threshold === line.threshold, multiplier: line.multipliers?.[analysis.direction] ?? null,
          recordedAt: now.toISOString(), eventStartTime: line.eventStartTime,
          lineSnapshot: shadowLine(line, prizePicks), grade: 'PENDING', actual: null });
      });
    }
    if (added) await this.save();
    this.lastRun = { at: now.toISOString(), scored, plays, added };
    return { scored, plays, added };
  }

  /** Grades pending shadow plays from box scores, the same way saved picks are graded. */
  async grade(): Promise<number> {
    await this.load();
    if (!this.boxScores) return 0;
    const pending = this.picks.filter((pick) => pick.grade === 'PENDING' &&
      Date.parse(pick.eventStartTime) > this.clock().getTime() - 7 * 86_400_000);
    if (!pending.length) return 0;
    const report = await this.boxScores.results(pending.map((pick) => ({ eventId: pick.lineSnapshot.eventId,
      playerId: pick.lineSnapshot.playerId, lineSnapshot: pick.lineSnapshot })));
    const facts = new Map<string, ResultFact>(report.facts.map((fact) =>
      [JSON.stringify([fact.eventId, fact.playerId, fact.market]), fact]));
    let graded = 0;
    for (const pick of pending) {
      const fact = facts.get(JSON.stringify([pick.lineSnapshot.eventId, pick.lineSnapshot.playerId, pick.lineSnapshot.market]));
      if (!fact) continue;
      pick.grade = fact.status === 'DNP' ? 'DNP' : fact.status === 'VOID' ? 'VOID' : fact.actual === pick.threshold ? 'PUSH'
        : (fact.actual! > pick.threshold) === (pick.direction === 'MORE') ? 'WIN' : 'LOSS';
      pick.actual = fact.actual; graded++;
    }
    if (graded) await this.save();
    return graded;
  }

  /** Per app: plays, the graded record at 80+, and where it stands against the go-live bars. */
  async summary() {
    await this.load();
    const since = this.picks.reduce<string | null>((first, pick) => !first || pick.recordedAt < first ? pick.recordedAt : first, null);
    const prizePicks = since && this.prizePicksRecord ? await this.prizePicksRecord(since, GO_LIVE.minScore) : null;
    const prizePicksRate = prizePicks?.graded ? prizePicks.wins / prizePicks.graded : null;
    const record = (picks: readonly ShadowPick[]) => {
      const wins = picks.filter((pick) => pick.grade === 'WIN').length, losses = picks.filter((pick) => pick.grade === 'LOSS').length;
      return { plays: picks.length, graded: wins + losses, wins, losses,
        hitRate: wins + losses ? Math.round(wins / (wins + losses) * 1000) / 1000 : null };
    };
    const apps = Object.fromEntries(otherApps.map((app) => {
      const mine = this.picks.filter((pick) => pick.app === app), strong = mine.filter((pick) => pick.score >= GO_LIVE.minScore);
      const top = record(strong);
      const bars = { graded: top.graded >= GO_LIVE.minGraded, hitRate: top.hitRate !== null && top.hitRate >= GO_LIVE.minHitRate,
        nearPrizePicks: top.hitRate !== null && prizePicksRate !== null && prizePicksRate - top.hitRate <= GO_LIVE.maxGapToPrizePicks };
      return [app, { all: record(mine), score80Plus: top, sameNumber: record(strong.filter((pick) => pick.sameNumber)),
        differentNumber: record(strong.filter((pick) => !pick.sameNumber)), bars,
        readyForGoLive: bars.graded && bars.hitRate && bars.nearPrizePicks }];
    }));
    return { since, goLive: GO_LIVE, lastRun: this.lastRun,
      prizePicksGkr: prizePicks ? { ...prizePicks, hitRate: prizePicksRate } : null, apps };
  }

  start(scoreMinutes = 15, gradeMinutes = 60): void {
    if (this.timers.length) return;
    const every = (minutes: number, task: () => Promise<unknown>) => {
      const timer = setInterval(() => { void task().catch(() => undefined); }, minutes * 60_000);
      timer.unref(); this.timers.push(timer);
    };
    every(scoreMinutes, () => this.score());
    every(gradeMinutes, () => this.grade());
  }

  stop(): void { for (const timer of this.timers) clearInterval(timer); this.timers = []; }
}
