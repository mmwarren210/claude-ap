import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizedName } from './context/match.js';

// UFC fighters' fight-by-fight history from UFCStats (Apify actor parseforge/ufcstats-scraper, about 3.5 cents a fighter),
// for History Read and Edge on PrizePicks' UFC lines: Fantasy Score, Significant Strikes, Takedowns and Total Rounds.
// Each fighter on the board is fetched once, then again after 7 days; the record is saved so a restart doesn't refetch.
//
// PrizePicks' MMA chart (owner screenshots 2026-10-07): significant strike 0.5, submission attempt 4, takedown 5,
// knockdown 10; a win in round 1 / 2 / 3 / 4 / 5 adds 50 / 40 / 30 / 20 / 20, a decision win 10, a draw 0.

export interface UfcFight {
  readonly date: string; readonly result: string; readonly method: string; readonly round: number; readonly time: string;
  readonly knockdowns: number; readonly strikes: number; readonly takedowns: number; readonly submissions: number;
}
type Fighter = { fetchedAt: string; name: string; fights: UfcFight[] };
export type UfcRunner = (lastName: string) => Promise<unknown[] | null>;

const WEEK = 7 * 86_400_000;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const text = (value: unknown) => typeof value === 'string' ? value : '';

/** The fights in one UFCStats fighter row, newest first; no-contests and overturned results are left out. */
export function fightsFrom(row: unknown): UfcFight[] {
  const history = (row as { fightHistory?: unknown }).fightHistory;
  if (!Array.isArray(history)) return [];
  return history.flatMap((item) => {
    const fight = item as Record<string, unknown>, method = text(fight.method), result = text(fight.result).toLowerCase();
    if (!fight.eventDate || /overturned|cnc|no contest/i.test(method) || /nc|no contest/.test(result) || !num(fight.round)) return [];
    return [{ date: text(fight.eventDate), result, method, round: num(fight.round), time: text(fight.time),
      knockdowns: num(fight.knockdownsFor), strikes: num(fight.significantStrikesFor), takedowns: num(fight.takedownsFor),
      submissions: num(fight.submissionsFor) }];
  }).sort((a, b) => b.date.localeCompare(a.date));
}

/** Rounds fought as a decimal (round 2 ending at 2:30 = 1.5), the way total-rounds lines count. */
export function roundsOf(fight: Pick<UfcFight, 'round' | 'time'>): number {
  const [minutes, seconds] = fight.time.split(':').map(Number);
  const into = Number.isFinite(minutes) && Number.isFinite(seconds) ? (minutes! * 60 + seconds!) / 300 : 1;
  return Math.round(((fight.round - 1) + Math.min(1, into)) * 1000) / 1000;
}

/** One fight on PrizePicks' MMA chart. */
export function ufcFantasy(fight: UfcFight): number {
  const base = fight.strikes * .5 + fight.submissions * 4 + fight.takedowns * 5 + fight.knockdowns * 10;
  if (fight.result !== 'win') return base;
  if (/dec/i.test(fight.method)) return base + 10;
  return base + ([50, 40, 30, 20, 20][fight.round - 1] ?? 20);
}

/** A UFC line's value for one past fight, or null for a stat the history doesn't carry. */
export function ufcValue(market: string, fight: UfcFight): number | null {
  const m = market.toLowerCase();
  if (/fantasy/.test(m)) return ufcFantasy(fight);
  if (/sig|strike/.test(m)) return fight.strikes;
  if (/takedown/.test(m)) return fight.takedowns;
  if (/round|fight_time|time/.test(m)) return roundsOf(fight);
  return null;
}

export class UfcHistory {
  private fighters = new Map<string, Fighter>();
  private loading: Promise<void> | null = null;
  private fetching = new Map<string, Promise<void>>();
  constructor(private readonly runner: UfcRunner | null, private readonly file: string | null,
    private readonly clock: () => Date = () => new Date()) {}

  private load() {
    this.loading ??= (async () => {
      if (!this.file) return;
      const saved = await readFile(this.file, 'utf8').then((body) => JSON.parse(body) as Fighter[]).catch(() => []);
      for (const fighter of saved) this.fighters.set(normalizedName(fighter.name), fighter);
    })();
    return this.loading;
  }

  private async save() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify([...this.fighters.values()]));
  }

  /** Fetches a fighter when unknown or a week old (in the background; one fetch per fighter at a time). */
  private ensure(name: string) {
    const key = normalizedName(name), known = this.fighters.get(key);
    if (!this.runner || (known && this.clock().getTime() - Date.parse(known.fetchedAt) < WEEK) || this.fetching.has(key)) return;
    const last = name.trim().split(/\s+/).at(-1) ?? name;
    const run = (async () => {
      const rows = await this.runner!(last).catch(() => null);
      if (!rows) return;
      const match = rows.find((row) => normalizedName(text((row as { fullName?: unknown }).fullName)) === key);
      this.fighters.set(key, { fetchedAt: this.clock().toISOString(), name, fights: match ? fightsFrom(match) : [] });
      await this.save().catch(() => undefined);
    })().finally(() => this.fetching.delete(key));
    this.fetching.set(key, run);
  }

  /** A fighter's recent values for a UFC line (newest first), or null while unknown; unknown fighters are fetched. */
  async values(name: string, market: string): Promise<{ values: number[]; source: string } | null> {
    await this.load();
    this.ensure(name);
    const fighter = this.fighters.get(normalizedName(name));
    if (!fighter?.fights.length) return null;
    const values = fighter.fights.map((fight) => ufcValue(market, fight)).filter((value): value is number => value !== null).slice(0, 15);
    return values.length ? { values, source: 'UFCStats fight history' } : null;
  }
}
