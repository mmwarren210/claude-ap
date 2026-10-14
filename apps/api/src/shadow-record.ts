import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PlayableDirection, PropLine } from '@crowniq/contracts';
import type { BoxScoreResults } from './box-score-results.js';
import type { GameLine } from './context/feeds.js';
import { normalizedName } from './context/match.js';

// Shadow records (owner approved 2026-10-05): picks that are not GKR scores, kept and graded in their own record so the
// owner can see whether they earn a place. Nothing here changes a GKR score or enters GKR's record.
//
// - books: a Books pick (DraftKings and Hard Rock's side where GKR couldn't score).
// - book:draftkings / book:hardrock: GKR's side at a sportsbook's own number (the sportsbook tabs).
// - gkr / beta: GKR's play and GKR Beta's on the same lines, graded the same way so the two compare fairly.
// - beta-pass: a GKR play Beta passed on late news, graded on GKR's side (a loss here is one Beta saved).
// - history: a free History Read's side (recent results against the line) where GKR doesn't play.
// - script: a GKR decision with the game's expected script saved beside it (favorite and margin, total), for the
//   game-script proposal (docs/PROPOSAL_GAME_SCRIPT.md).
// - gkr1 / gkr2: GKR's play and GKR 2's (owner, 2026-10-11) on the lines GKR 2 could read, graded side by side.

export type ShadowKind = 'books' | 'book:draftkings' | 'book:hardrock' | 'book:pinnacle' | 'book:kalshi' | 'script' | 'gkr' | 'beta' | 'beta-pass' | 'history' | 'trend' | 'book-history' | 'book-value' | 'gkr1' | 'gkr2' | 'gkr3';
export type ShadowGrade = 'PENDING' | 'WIN' | 'LOSS' | 'PUSH' | 'DNP' | 'VOID';

/** The game's expected script when the pick was saved. */
export interface GameScript {
  /** Points the player's team is favored by (negative when it's the underdog), from Pinnacle's spread. */
  readonly teamMargin: number | null;
  /** Pinnacle's game total. */
  readonly total: number | null;
  /** Pinnacle's no-vig chance the player's team wins. */
  readonly teamWin: number | null;
  /** Prediction-market win chance and agreement: no longer read (Kalshi was removed, 2026-10-06), always null. */
  readonly marketsWin: number | null;
  readonly agree: boolean | null;
}

export interface ShadowEntry {
  readonly id: string; readonly kind: ShadowKind; readonly side: PlayableDirection;
  /** The line as it was when saved (the sportsbook's number for book picks). */
  readonly lineSnapshot: PropLine;
  /** The pick's own number: the books' no-vig chance (books), GKR's score (book tabs, script). */
  readonly strength: number | null;
  readonly script?: GameScript;
  readonly recordedAt: string;
  grade: ShadowGrade; actual: number | null;
}

export interface ShadowPick { readonly kind: ShadowKind; readonly line: PropLine; readonly side: PlayableDirection;
  readonly strength: number | null; readonly script?: GameScript }

/** Stats game script should move (volume and scoring), for the shadow record. */
const SCRIPT_SPORTS = new Set(['NFL', 'NCAAFB', 'NBA', 'WNBA']);
const SCRIPT_MARKET = /yds|yards|attempts|completions|receptions|rush|points|rebounds|assists|threes|targets/;
export const scriptEligible = (line: PropLine) => SCRIPT_SPORTS.has(line.sport) && SCRIPT_MARKET.test(line.market);

const words = (value: string) => normalizedName(value).split(' ');
const nickname = (team: string) => words(team).at(-1) ?? '';
const sameTeam = (a: string | null | undefined, b: string) => !!a && (normalizedName(a) === normalizedName(b) ||
  nickname(a) === nickname(b) || normalizedName(b).startsWith(normalizedName(a)) || normalizedName(a).startsWith(normalizedName(b)));

/**
 * The expected script for a line's game, from Pinnacle (spread, total, win chance). Null when Pinnacle has no line for the game or the player's team can't be placed.
 */
/**
 * The side the game script favors on a volume stat, or null: a team favored by 7+ or a high total favors MORE; an underdog
 * by 7+ or a low total favors LESS. On graded GKR picks the script backing GKR's side hit 82%, opposing it 49% (2026-10-14).
 */
export function scriptLean(sport: string, script: Pick<GameScript, 'teamMargin' | 'total'>): 'MORE' | 'LESS' | null {
  const high = sport === 'NFL' || sport === 'NCAAFB' ? 50 : sport === 'NBA' ? 232 : 168, low = sport === 'NFL' ? 40
    : sport === 'NCAAFB' ? 45 : sport === 'NBA' ? 218 : 156;
  return (script.teamMargin !== null && script.teamMargin >= 7) || (script.total !== null && script.total >= high) ? 'MORE'
    : (script.teamMargin !== null && script.teamMargin <= -7) || (script.total !== null && script.total <= low) ? 'LESS' : null;
}

export function gameScriptFor(line: PropLine, games: readonly GameLine[]): GameScript | null {
  const start = Date.parse(line.eventStartTime);
  const mine = games.filter((game) => Math.abs(Date.parse(game.startTime) - start) <= 6 * 3600_000 &&
    (sameTeam(line.team, game.home) || sameTeam(line.team, game.away)) &&
    [line.team, line.opponent].some((team) => sameTeam(team, game.home)) &&
    [line.team, line.opponent].some((team) => sameTeam(team, game.away)));
  if (!mine.length || !line.team) return null;
  const { home, away } = mine[0]!, isHome = sameTeam(line.team, home) && !sameTeam(line.team, away);
  const spread = mine.find((game) => game.market === 'spread'), total = mine.find((game) => game.market === 'total');
  const moneyline = mine.find((game) => game.market === 'moneyline');
  const teamWin = moneyline?.homeFair != null && moneyline.awayFair != null ? (isHome ? moneyline.homeFair : moneyline.awayFair) : null;
  return { teamMargin: spread?.line == null ? null : isHome ? -spread.line : spread.line, total: total?.line ?? null,
    teamWin, marketsWin: null, agree: null };
}

interface Saved { entries: ShadowEntry[] }

/** Saves shadow picks once each (the first time seen, before the game), grades them from box scores, reports records. */
export class ShadowRecord {
  private entries = new Map<string, ShadowEntry>();
  private loaded = false;
  constructor(private readonly file: string | null, private readonly boxScores: BoxScoreResults | null = null,
    private readonly clock: () => Date = () => new Date()) {}

  private key(kind: ShadowKind, line: PropLine) { return `${kind}|${line.eventId}|${line.playerId}|${line.market}|${line.threshold}`; }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Saved;
      for (const entry of saved.entries) this.entries.set(entry.id, entry);
    } catch { /* first run */ }
  }

  private async save() {
    if (!this.file) return;
    // Graded entries stay 30 days for the record.
    const cutoff = this.clock().getTime() - 30 * 86_400_000;
    for (const [id, entry] of this.entries) if (entry.grade !== 'PENDING' && Date.parse(entry.lineSnapshot.eventStartTime) < cutoff)
      this.entries.delete(id);
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ entries: [...this.entries.values()] } satisfies Saved));
    await rename(temporary, this.file);
  }

  /** Saves each pick not seen before whose game hasn't started. Returns how many were new. */
  async record(picks: readonly ShadowPick[]): Promise<number> {
    await this.load();
    const now = this.clock();
    let added = 0;
    for (const pick of picks) {
      const id = this.key(pick.kind, pick.line);
      if (this.entries.has(id) || Date.parse(pick.line.eventStartTime) <= now.getTime()) continue;
      this.entries.set(id, { id, kind: pick.kind, side: pick.side, lineSnapshot: structuredClone(pick.line),
        strength: pick.strength, ...pick.script ? { script: pick.script } : {}, recordedAt: now.toISOString(),
        grade: 'PENDING', actual: null });
      added++;
    }
    if (added) await this.save();
    return added;
  }

  /** Grades pending entries whose games have finished, from box scores. */
  async grade(): Promise<number> {
    await this.load();
    if (!this.boxScores) return 0;
    const now = this.clock().getTime();
    const pending = [...this.entries.values()].filter((entry) => entry.grade === 'PENDING' &&
      Date.parse(entry.lineSnapshot.eventStartTime) < now - 3 * 3600_000);
    if (!pending.length) return 0;
    const report = await this.boxScores.results(pending.map((entry) => ({ eventId: entry.lineSnapshot.eventId,
      playerId: entry.lineSnapshot.playerId, lineSnapshot: entry.lineSnapshot })));
    const facts = new Map(report.facts.map((fact) => [JSON.stringify([fact.eventId, fact.playerId, fact.market]), fact]));
    let graded = 0;
    for (const entry of pending) {
      const fact = facts.get(JSON.stringify([entry.lineSnapshot.eventId, entry.lineSnapshot.playerId, entry.lineSnapshot.market]));
      if (!fact) continue;
      const line = entry.lineSnapshot.threshold;
      entry.grade = fact.status === 'DNP' ? 'DNP' : fact.status === 'VOID' ? 'VOID' : fact.actual === line ? 'PUSH'
        : (fact.actual! > line) === (entry.side === 'MORE') ? 'WIN' : 'LOSS';
      entry.actual = fact.actual; graded++;
    }
    if (graded) await this.save();
    return graded;
  }

  /** Graded wins and losses of one kind as forecasts (the pick's strength as a 0-1 chance), for a calibration curve. */
  async forecastRows(kind: ShadowKind): Promise<{ probability: number; hit: boolean; sport: string }[]> {
    await this.load();
    return [...this.entries.values()].filter((entry) => entry.kind === kind && entry.strength !== null &&
      (entry.grade === 'WIN' || entry.grade === 'LOSS'))
      .map((entry) => ({ probability: entry.strength! / 100, hit: entry.grade === 'WIN', sport: entry.lineSnapshot.sport }));
  }

  /** Graded record of some kinds by score bucket and sport, for comparing two models on the same lines (GKR and GKR 2). */
  async compare(kinds: readonly ShadowKind[]) {
    await this.load();
    const buckets = [[0, 67], [68, 74], [75, 79], [80, 84], [85, 89], [90, 94], [95, 100]] as const;
    const empty = () => ({ picks: 0, graded: 0, wins: 0, hitRate: null as number | null });
    const tally = (row: ReturnType<typeof empty>, entry: ShadowEntry) => {
      row.picks++;
      if (entry.grade === 'WIN' || entry.grade === 'LOSS') { row.graded++; if (entry.grade === 'WIN') row.wins++; }
      row.hitRate = row.graded ? Math.round(row.wins / row.graded * 1000) / 1000 : null;
    };
    return Object.fromEntries(kinds.map((kind) => {
      const all = empty(), byBucket: Record<string, ReturnType<typeof empty>> = {}, bySport: Record<string, ReturnType<typeof empty>> = {},
        bySide: Record<string, ReturnType<typeof empty>> = {};
      for (const entry of this.entries.values()) {
        if (entry.kind !== kind) continue;
        tally(all, entry);
        const score = entry.strength ?? 0, bucket = buckets.find(([low, high]) => score >= low && score < high + 1);
        if (bucket) tally(byBucket[`${bucket[0]}-${bucket[1]}`] ??= empty(), entry);
        tally(bySport[entry.lineSnapshot.sport] ??= empty(), entry);
        tally(bySide[entry.side] ??= empty(), entry);
      }
      return [kind, { all, byBucket, bySport, bySide }];
    }));
  }

  /** Graded record by source and sport, and by source, sport and stat (wins over wins plus losses). */
  async hitRates(): Promise<Record<string, { graded: number; wins: number; hitRate: number }>> {
    await this.load();
    const out: Record<string, { graded: number; wins: number; hitRate: number }> = {};
    for (const entry of this.entries.values()) {
      if (entry.grade !== 'WIN' && entry.grade !== 'LOSS') continue;
      const { sport, market } = entry.lineSnapshot;
      for (const key of [`${entry.kind}|${sport}`, `${entry.kind}|${sport}|${market}`]) {
        const row = out[key] ??= { graded: 0, wins: 0, hitRate: 0 };
        row.graded++; if (entry.grade === 'WIN') row.wins++;
        row.hitRate = Math.round(row.wins / row.graded * 1000) / 1000;
      }
    }
    return out;
  }

  async status() {
    await this.load();
    const all = [...this.entries.values()];
    const record = (group: ShadowEntry[]) => {
      const done = group.filter((entry) => entry.grade === 'WIN' || entry.grade === 'LOSS');
      const wins = done.filter((entry) => entry.grade === 'WIN').length;
      return { picks: group.length, graded: done.length, wins, hitRate: done.length ? Math.round(wins / done.length * 1000) / 1000 : null };
    };
    const kinds: ShadowKind[] = ['books', 'book:draftkings', 'book:hardrock', 'book:pinnacle', 'book:kalshi', 'script', 'gkr', 'beta', 'beta-pass', 'history', 'trend', 'book-history', 'book-value', 'gkr1', 'gkr2', 'gkr3'];
    // Game script: how GKR's side did with the script for it or against it. A team favored by 7+ or a high total
    // favors MORE on volume stats; an underdog by 7+ or a low total favors LESS.
    const scripts = all.filter((entry) => entry.kind === 'script' && entry.script);
    const backs = (entry: ShadowEntry) => {
      const lean = scriptLean(entry.lineSnapshot.sport, entry.script!);
      return lean === null ? 'neutral' : lean === entry.side ? 'backs' : 'opposes';
    };
    return {
      ...Object.fromEntries(kinds.map((kind) => [kind, record(all.filter((entry) => entry.kind === kind))])),
      scriptSplit: { backs: record(scripts.filter((entry) => backs(entry) === 'backs')),
        opposes: record(scripts.filter((entry) => backs(entry) === 'opposes')),
        neutral: record(scripts.filter((entry) => backs(entry) === 'neutral')),
        marketsDisagree: scripts.filter((entry) => entry.script!.agree === false).length },
    };
  }
}
