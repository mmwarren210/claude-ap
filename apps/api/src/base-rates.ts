import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PlayableDirection, PropLine } from '@crowniq/contracts';
import { boxScoreReader } from './box-score-results.js';
import type { BoxScoreResults } from './box-score-results.js';

// CrownIQ's own hit rates (owner, 2026-10-05): every standard PrizePicks line is graded after its game, not only our
// picks, so we learn how often More and Less hit on each kind of line (by sport and stat, and by the exact number). A
// line no model or read covers can still show a Trend when one side has clearly hit more often over enough lines.
// Display only and graded in its own record; never a GKR score.

type Counts = { over: number; under: number; push: number };
interface Saved { pending: Record<string, PropLine>; counts: Record<string, Counts> }
export interface Trend { readonly side: PlayableDirection; readonly rate: number; readonly graded: number;
  readonly scope: 'number' | 'stat'; readonly text: string }

/** Lines needed before a Trend shows: at this exact number, or across the stat. */
export const TREND_MIN = { number: 60, stat: 150 } as const;
/** The side must have hit at least this often. */
export const TREND_BAR = 0.57;

const statKey = (line: Pick<PropLine, 'sport' | 'market'>) => `${line.sport}|${line.market}`;
const numberKey = (line: Pick<PropLine, 'sport' | 'market' | 'threshold'>) => `${line.sport}|${line.market}|${line.threshold}`;
const label = (market: string) => market.replace(/^(player|batter|pitcher)_/, '').replace(/_/g, ' ');

export class BaseRates {
  private data: Saved | null = null;
  private dirty = false;
  constructor(private readonly file: string | null, private readonly boxScores: BoxScoreResults | null,
    private readonly clock: () => Date = () => new Date()) {}

  private async load(): Promise<Saved> {
    if (this.data) return this.data;
    let saved: Saved = { pending: {}, counts: {} };
    if (this.file) try { saved = JSON.parse(await readFile(this.file, 'utf8')) as Saved; } catch { /* first run */ }
    this.data = { pending: saved.pending ?? {}, counts: saved.counts ?? {} };
    return this.data;
  }
  private async save() {
    if (!this.file || !this.data || !this.dirty) return;
    this.dirty = false;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data));
    await rename(temporary, this.file);
  }

  /** Keeps the latest number of each standard two-sided line whose game starts within 36 hours (the closing line). */
  async record(lines: readonly PropLine[]) {
    const data = await this.load(), now = this.clock().getTime();
    for (const line of lines) {
      const start = Date.parse(line.eventStartTime);
      if (line.lineType !== 'REGULAR' || line.availableDirections.length < 2 || start <= now || start - now > 36 * 3600_000 ||
        !boxScoreReader(line)) continue;
      const key = `${line.eventId}|${line.playerId}|${line.market}`, current = data.pending[key];
      if (current && current.threshold === line.threshold) continue;
      data.pending[key] = line; this.dirty = true;
    }
    await this.save();
  }

  /** Grades finished games from box scores into the counts. Lines that can't be graded drop after four days. */
  async grade(): Promise<number> {
    const data = await this.load(), now = this.clock().getTime();
    if (!this.boxScores) return 0;
    const ready = Object.entries(data.pending).filter(([, line]) => Date.parse(line.eventStartTime) < now - 3 * 3600_000);
    if (!ready.length) return 0;
    const report = await this.boxScores.results(ready.map(([, line]) => ({ eventId: line.eventId, playerId: line.playerId,
      lineSnapshot: line })));
    const facts = new Map(report.facts.map((fact) => [`${fact.eventId}|${fact.playerId}|${fact.market}`, fact]));
    let graded = 0;
    for (const [key, line] of ready) {
      const fact = facts.get(key);
      if (!fact) {
        if (Date.parse(line.eventStartTime) < now - 4 * 86_400_000) { delete data.pending[key]; this.dirty = true; }
        continue;
      }
      delete data.pending[key]; this.dirty = true;
      if (fact.status !== 'FINAL' || fact.actual === null || fact.actual === undefined) continue;
      const outcome = fact.actual > line.threshold ? 'over' : fact.actual < line.threshold ? 'under' : 'push';
      for (const countKey of [statKey(line), numberKey(line)]) {
        const counts = data.counts[countKey] ??= { over: 0, under: 0, push: 0 };
        counts[outcome]++;
      }
      graded++;
    }
    await this.save();
    return graded;
  }

  /** A Trend for a line: the exact number first, then the stat, when one side clears the bar over enough lines. */
  async trendFor(line: Pick<PropLine, 'sport' | 'market' | 'threshold' | 'availableDirections'>): Promise<Trend | null> {
    const data = await this.load();
    for (const [scope, key] of [['number', numberKey(line)], ['stat', statKey(line)]] as const) {
      const counts = data.counts[key];
      const graded = counts ? counts.over + counts.under : 0;
      if (!counts || graded < TREND_MIN[scope]) continue;
      const over = counts.over / graded;
      const side: PlayableDirection | null = over >= TREND_BAR ? 'MORE' : 1 - over >= TREND_BAR ? 'LESS' : null;
      if (!side || !line.availableDirections.includes(side)) return null;
      const rate = Math.round((side === 'MORE' ? over : 1 - over) * 1000) / 1000;
      return { side, rate, graded, scope, text: `${side === 'MORE' ? 'More' : 'Less'} hit ${Math.round(rate * 100)}% on ` +
        `${graded} ${line.sport} ${label(line.market)} lines${scope === 'number' ? ` at ${line.threshold}` : ''}` };
    }
    return null;
  }

  async status() {
    const data = await this.load();
    const stats = Object.entries(data.counts).filter(([key]) => key.split('|').length === 2)
      .map(([key, counts]) => ({ key, graded: counts.over + counts.under, overRate: counts.over + counts.under
        ? Math.round(counts.over / (counts.over + counts.under) * 1000) / 1000 : null }))
      .sort((a, b) => b.graded - a.graded);
    return { pending: Object.keys(data.pending).length, graded: stats.reduce((sum, item) => sum + item.graded, 0), stats: stats.slice(0, 60) };
  }

  start() {
    const timer = setInterval(() => { void this.grade().catch(() => undefined); }, 60 * 60_000);
    timer.unref();
    return timer;
  }
}
