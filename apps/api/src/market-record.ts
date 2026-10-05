import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizedName } from './context/match.js';
import type { MarketPick, MarketPlatform } from './market-picks.js';
import { easternDay } from './scrapers/spend-budget.js';

// Kalshi and Polymarket picks' own record: each pick saved once before its game, graded from ESPN's final scores (a
// winner pick on the winner, a spread pick with its handicap), and scored per $1 at the price it showed.

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const leaguePaths: Readonly<Record<string, string>> = { NFL: 'football/nfl', NCAAF: 'football/college-football',
  NCAAFB: 'football/college-football', MLB: 'baseball/mlb', NBA: 'basketball/nba', WNBA: 'basketball/wnba', NHL: 'hockey/nhl',
  NCAAB: 'basketball/mens-college-basketball', 'ENGLAND_-_PREMIER_LEAGUE': 'soccer/eng.1', 'SPAIN_-_LA_LIGA': 'soccer/esp.1',
  'UEFA_-_CHAMPIONS_LEAGUE': 'soccer/uefa.champions', 'GERMANY_-_BUNDESLIGA': 'soccer/ger.1', 'ITALY_-_SERIE_A': 'soccer/ita.1',
  'FRANCE_-_LIGUE_1': 'soccer/fra.1', 'USA_-_MAJOR_LEAGUE_SOCCER': 'soccer/usa.1', 'UEFA_-_EUROPA_LEAGUE': 'soccer/uefa.europa' };

export type MarketGrade = 'PENDING' | 'WIN' | 'LOSS' | 'PUSH' | 'VOID';
export interface MarketEntry extends Pick<MarketPick, 'id' | 'platform' | 'league' | 'game' | 'home' | 'away' | 'startTime' |
  'kind' | 'side' | 'team' | 'handicap' | 'price' | 'cost' | 'fair' | 'edge' | 'total'> {
  readonly recordedAt: string;
  grade: MarketGrade; final: { home: number; away: number } | null;
}
/** One finished game: its teams' names as ESPN gives them, and the score. */
export interface FinalScore { readonly start: number; readonly home: readonly string[]; readonly away: readonly string[];
  readonly homeScore: number; readonly awayScore: number; readonly final: boolean }

const nickname = (team: string) => normalizedName(team).split(' ').at(-1) ?? '';
const names = (team: string, candidates: readonly string[]) => candidates.some((name) => {
  const a = normalizedName(name), b = normalizedName(team);
  return !!a && (a === b || a === nickname(team) || b.startsWith(a) || nickname(name) === nickname(team));
});

/** The grade of a pick from its game's final score. */
export function gradeMarket(entry: Pick<MarketEntry, 'kind' | 'team' | 'handicap' | 'total'>, score: { home: number; away: number }): MarketGrade {
  if (entry.kind === 'TOTAL' && entry.total) {
    const points = score.home + score.away;
    return points === entry.total.line ? 'PUSH' : (points > entry.total.line) === (entry.total.side === 'over') ? 'WIN' : 'LOSS';
  }
  const mine = entry.team === 'home' ? score.home : score.away, theirs = entry.team === 'home' ? score.away : score.home;
  const margin = mine + (entry.kind === 'SPREAD' ? entry.handicap ?? 0 : 0) - theirs;
  return margin > 0 ? 'WIN' : margin < 0 ? 'LOSS' : 'PUSH';
}

export function parseScoreboard(body: unknown): FinalScore[] {
  const events = (body as { events?: unknown[] } | null)?.events ?? [];
  return events.flatMap((value) => {
    const event = value as { date?: string; status?: { type?: { completed?: boolean } }; competitions?: { competitors?: unknown[] }[] };
    const competitors = (event.competitions?.[0]?.competitors ?? []) as { homeAway?: string; score?: string | number;
      team?: Record<string, unknown> }[];
    const home = competitors.find((item) => item.homeAway === 'home'), away = competitors.find((item) => item.homeAway === 'away');
    const start = Date.parse(event.date ?? '');
    if (!home || !away || !Number.isFinite(start)) return [];
    const teamNames = (item: typeof home) => ['displayName', 'shortDisplayName', 'name', 'location', 'abbreviation']
      .map((key) => item.team?.[key]).filter((name): name is string => typeof name === 'string' && !!name);
    return [{ start, home: teamNames(home), away: teamNames(away), homeScore: Number(home.score ?? NaN),
      awayScore: Number(away.score ?? NaN), final: event.status?.type?.completed === true }];
  });
}

export class MarketRecord {
  private entries = new Map<string, MarketEntry>();
  private loaded = false;
  constructor(private readonly file: string | null, private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date()) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try { for (const entry of (JSON.parse(await readFile(this.file, 'utf8')) as { entries: MarketEntry[] }).entries)
      this.entries.set(entry.id, entry); } catch { /* first run */ }
  }

  private async save() {
    if (!this.file) return;
    const cutoff = this.clock().getTime() - 30 * 86_400_000;
    for (const [id, entry] of this.entries) if (entry.grade !== 'PENDING' && Date.parse(entry.startTime) < cutoff) this.entries.delete(id);
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ entries: [...this.entries.values()] }));
    await rename(temporary, this.file);
  }

  /** Saves each pick not seen before whose game hasn't started; returns how many were new. */
  async record(picks: readonly MarketPick[]): Promise<number> {
    await this.load();
    const now = this.clock();
    let added = 0;
    for (const pick of picks) {
      // Player props aren't graded from game scores; they stay out of this record.
      if (pick.kind === 'PROP' || this.entries.has(pick.id) || Date.parse(pick.startTime) <= now.getTime()) continue;
      const { id, platform, league, game, home, away, startTime, kind, side, team, handicap, price, cost, fair, edge, total } = pick;
      this.entries.set(id, { id, platform, league, game, home, away, startTime, kind, side, team, handicap, price, cost, fair,
        edge, ...total ? { total } : {}, recordedAt: now.toISOString(), grade: 'PENDING', final: null });
      added++;
    }
    if (added) await this.save();
    return added;
  }

  /** Grades picks whose games have ended; a game with no ESPN result four days on is void (tennis, for one). */
  async grade(): Promise<number> {
    await this.load();
    const now = this.clock().getTime();
    const pending = [...this.entries.values()].filter((entry) => entry.grade === 'PENDING' && Date.parse(entry.startTime) < now - 3 * 3600_000);
    if (!pending.length) return 0;
    const boards = new Map<string, Promise<FinalScore[]>>();
    const scores = (path: string, day: string) => {
      const key = `${path}|${day}`;
      if (!boards.has(key)) boards.set(key, this.fetchFn(`${ESPN}/${path}/scoreboard?dates=${day.replaceAll('-', '')}&limit=1000${
        path === 'football/college-football' ? '&groups=80' : ''}`, { signal: AbortSignal.timeout(20_000) })
        .then(async (response) => response.ok ? parseScoreboard(await response.json()) : []).catch(() => []));
      return boards.get(key)!;
    };
    let graded = 0;
    for (const entry of pending) {
      const path = leaguePaths[entry.league.toUpperCase()], start = Date.parse(entry.startTime);
      const game = path ? (await scores(path, easternDay(new Date(start)))).find((item) => Math.abs(item.start - start) <= 6 * 3600_000 &&
        names(entry.home, item.home) && names(entry.away, item.away)) : undefined;
      if (game?.final && Number.isFinite(game.homeScore) && Number.isFinite(game.awayScore)) {
        entry.final = { home: game.homeScore, away: game.awayScore };
        entry.grade = gradeMarket(entry, entry.final); graded++;
      } else if (now - start > 4 * 86_400_000) { entry.grade = 'VOID'; graded++; }
    }
    if (graded) await this.save();
    return graded;
  }

  /** Each platform's record: graded picks, wins and losses, and the average result per $1 at the prices shown. */
  async status(platform?: MarketPlatform) {
    await this.load();
    const group = [...this.entries.values()].filter((entry) => !platform || entry.platform === platform);
    const decided = group.filter((entry) => entry.grade === 'WIN' || entry.grade === 'LOSS');
    const wins = decided.filter((entry) => entry.grade === 'WIN').length;
    const profit = decided.reduce((sum, entry) => sum + (entry.grade === 'WIN' ? 1 - entry.cost : -entry.cost), 0);
    return { picks: group.length, graded: decided.length, wins, losses: decided.length - wins,
      pushes: group.filter((entry) => entry.grade === 'PUSH').length,
      hitRate: decided.length ? Math.round(wins / decided.length * 1000) / 1000 : null,
      perDollar: decided.length ? Math.round(profit / decided.length * 1000) / 1000 : null };
  }
}
