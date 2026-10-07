import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizedName } from './context/match.js';
import { sameTeam } from './team-match.js';

// Soccer players' full match stats from Sofascore (Apify actor abotapi/sofascore-scraper), for History Read and Edge on
// soccer lines ESPN's logs can't read: Fantasy Score (PrizePicks' chart needs passes, tackles, clearances, dribbles and
// crosses), tackles, passes, clearances, crosses, dribbles, shots assisted and fouls drawn, plus any player ESPN misses.
// The matches come from ESPN's team schedules (both teams' last six fixtures); each is looked up once by its two team
// names ("Arsenal Chelsea") and kept only when Sofascore's match has the same teams within a day of ESPN's date. A match
// costs about a third of a cent; runs are batched and stay under the shared daily scraper cap.
//
// PrizePicks soccer chart (owner screenshots 2026-10-07). Outfield: goal 10, assist 5, shot 1, shot on target 1, pass
// attempted 0.05, shot assisted 0.5, clearance 1, tackle 1, attempted dribble 1, cross 0.5, yellow card -1, red card -2,
// foul -0.5. Goalkeeper: start 5, save 2, goal conceded -2, clean sheet 5. Sofascore's lineups carry no cards, so cards
// count 0 (a slight overstatement for players who get booked).

export interface Fixture { readonly date: string; readonly home: string; readonly away: string }
export interface SoccerRow {
  readonly date: string; readonly team: string; readonly goalie: boolean; readonly started: boolean;
  readonly conceded: number; readonly stats: Readonly<Record<string, number>>;
}
type Store = { tried: Record<string, string>; players: Record<string, SoccerRow[]> };
export type SofascoreRunner = (queries: readonly string[]) => Promise<unknown[] | null>;

const DAY = 86_400_000;
const fixtureKey = (fixture: Fixture) => `${fixture.date.slice(0, 10)}|${normalizedName(fixture.home)}|${normalizedName(fixture.away)}`;
const text = (value: unknown) => typeof value === 'string' ? value : '';
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Every player who played in one Sofascore match record (with lineups), as stat rows. */
export function playersFrom(match: Record<string, unknown>): { name: string; row: SoccerRow }[] {
  const lineups = match.lineups as { home?: { players?: unknown[] }; away?: { players?: unknown[] } } | undefined;
  const date = new Date(num(match.startTimestamp) * 1000).toISOString();
  const score = (side: unknown) => num((side as { current?: unknown } | undefined)?.current ?? side);
  const goals = { home: score(match.homeScore), away: score(match.awayScore) };
  const out: { name: string; row: SoccerRow }[] = [];
  for (const side of ['home', 'away'] as const) for (const entry of lineups?.[side]?.players ?? []) {
    const item = entry as { player?: { name?: unknown; position?: unknown }; position?: unknown; substitute?: unknown; statistics?: Record<string, unknown> };
    const stats = Object.fromEntries(Object.entries(item.statistics ?? {}).filter(([, value]) => typeof value === 'number')) as Record<string, number>;
    if (!(stats.minutesPlayed! > 0) || !text(item.player?.name)) continue;
    out.push({ name: text(item.player!.name), row: { date, team: text(side === 'home' ? match.homeTeam : match.awayTeam),
      goalie: text(item.position ?? item.player?.position) === 'G', started: item.substitute === false,
      conceded: side === 'home' ? goals.away : goals.home, stats } });
  }
  return out;
}

/** One match on PrizePicks' soccer chart (outfield or goalkeeper). */
export function soccerFantasy(row: SoccerRow): number {
  const s = (key: string) => row.stats[key] ?? 0;
  if (row.goalie) return (row.started ? 5 : 0) + s('saves') * 2 - row.conceded * 2 + (row.conceded === 0 && s('minutesPlayed') >= 60 ? 5 : 0);
  return s('goals') * 10 + s('goalAssist') * 5 + s('totalShots') + s('onTargetScoringAttempt') + s('totalPass') * .05 + s('keyPass') * .5
    + s('totalClearance') + s('totalTackle') + s('totalContest') + s('totalCross') * .5 - s('fouls') * .5;
}

/** A soccer line's value for one match, or null for a stat Sofascore doesn't carry. Missing counts are 0. */
export function soccerValue(market: string, row: SoccerRow): number | null {
  const m = market.toLowerCase(), s = (key: string) => row.stats[key] ?? 0;
  if (/fantasy/.test(m)) return soccerFantasy(row);
  if (/goal_plus_assist|goals_assists|goals_plus_assists/.test(m)) return s('goals') + s('goalAssist');
  if (/shots_assisted|key_pass/.test(m)) return s('keyPass');
  if (/^sot$|shots_on_target|on_target/.test(m)) return s('onTargetScoringAttempt');
  if (/shot/.test(m)) return s('totalShots');
  if (/goals_allowed|conceded/.test(m)) return row.goalie ? row.conceded : null;
  if (/save/.test(m)) return row.goalie ? s('saves') : null;
  if (/assist/.test(m)) return s('goalAssist');
  if (/^goals?$|^2_plus_goals$/.test(m)) return s('goals');
  if (/fouls_drawn|was_fouled/.test(m)) return s('wasFouled');
  if (/foul/.test(m)) return s('fouls');
  if (/tackle/.test(m)) return s('totalTackle');
  if (/pass/.test(m)) return s('totalPass');
  if (/clearance/.test(m)) return s('totalClearance');
  if (/cross/.test(m)) return s('totalCross');
  if (/dribble/.test(m)) return s('totalContest');
  return null;
}

export class SoccerHistory {
  private store: Store = { tried: {}, players: {} };
  private loading: Promise<void> | null = null;
  private pending = new Map<string, Fixture>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly runner: SofascoreRunner | null, private readonly file: string | null,
    private readonly clock: () => Date = () => new Date(), private readonly batchDelayMs = 60_000) {}

  private load() {
    this.loading ??= (async () => {
      if (!this.file) return;
      const saved = await readFile(this.file, 'utf8').then((body) => JSON.parse(body) as Store).catch(() => null);
      if (saved?.players) this.store = saved;
    })();
    return this.loading;
  }

  private async save() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.store));
  }

  /** Queues fixtures not tried yet (a failed lookup is retried after two days); one batched run a minute later. */
  queue(fixtures: readonly Fixture[]) {
    const now = this.clock().getTime();
    for (const fixture of fixtures) {
      const key = fixtureKey(fixture), tried = this.store.tried[key];
      if (tried === 'found' || (tried && now - Date.parse(tried) < 2 * DAY)) continue;
      this.pending.set(key, fixture);
    }
    if (this.pending.size && this.runner && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, this.batchDelayMs);
      this.timer.unref?.();
    }
  }

  /** Looks up queued fixtures (up to 60 a run) and keeps every player's stats from the matches that check out. */
  async flush(): Promise<{ asked: number; found: number }> {
    if (this.running || !this.runner || !this.pending.size) return { asked: 0, found: 0 };
    this.running = true;
    try {
      await this.load();
      const batch = [...this.pending.entries()].slice(0, 60);
      for (const [key] of batch) this.pending.delete(key);
      const records = await this.runner(batch.map(([, fixture]) => `${fixture.home} ${fixture.away}`));
      if (!records) return { asked: batch.length, found: 0 };
      const now = this.clock().toISOString();
      let found = 0;
      for (const [key, fixture] of batch) {
        // The closest finished match with both teams, within a day of ESPN's date.
        const gap = (record: Record<string, unknown>) => Math.abs(num(record.startTimestamp) * 1000 - Date.parse(fixture.date));
        const match = (records as Record<string, unknown>[]).filter((record) => record.lineups && /finished/i.test(text(record.statusType))
          && gap(record) <= DAY && sameTeam(text(record.homeTeam), fixture.home) && sameTeam(text(record.awayTeam), fixture.away))
          .sort((a, b) => gap(a) - gap(b))[0];
        this.store.tried[key] = match ? 'found' : now;
        if (!match) continue;
        found++;
        for (const { name, row } of playersFrom(match)) {
          const list = (this.store.players[normalizedName(name)] ??= []);
          if (!list.some((item) => item.date === row.date)) list.push(row);
          list.sort((a, b) => b.date.localeCompare(a.date)).splice(20);
        }
      }
      await this.save().catch(() => undefined);
      console.log(`[soccer-history] looked up ${batch.length} matches, ${found} found; ${Object.keys(this.store.players).length} players stored`);
      if (this.pending.size) this.queue([]);
      return { asked: batch.length, found };
    } finally { this.running = false; }
  }

  /** A player's recent values for a soccer line (newest first, before `before`), or null without any. */
  async values(name: string, market: string, before: string): Promise<{ values: number[]; source: string } | null> {
    await this.load();
    const rows = (this.store.players[normalizedName(name)] ?? []).filter((row) => row.date < before);
    const values = rows.map((row) => soccerValue(market, row)).filter((value): value is number => value !== null).slice(0, 15);
    return values.length ? { values, source: 'Sofascore match stats' } : null;
  }
}
