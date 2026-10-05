import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PlayableDirection, PropLine } from '@crowniq/contracts';
import type { BoxScoreResults } from './box-score-results.js';
import type { GameLine, MarketOdds } from './context/feeds.js';
import { normalizedName } from './context/match.js';
import { teamIn } from './market-picks.js';

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

export type ShadowKind = 'books' | 'book:draftkings' | 'book:hardrock' | 'script' | 'gkr' | 'beta' | 'beta-pass' | 'history' | 'trend';
export type ShadowGrade = 'PENDING' | 'WIN' | 'LOSS' | 'PUSH' | 'DNP' | 'VOID';

/** The game's expected script when the pick was saved. */
export interface GameScript {
  /** Points the player's team is favored by (negative when it's the underdog), from Pinnacle's spread. */
  readonly teamMargin: number | null;
  /** Pinnacle's game total. */
  readonly total: number | null;
  /** Pinnacle's no-vig chance the player's team wins. */
  readonly teamWin: number | null;
  /** Kalshi and Polymarket's average chance the player's team wins, when they price the game. */
  readonly marketsWin: number | null;
  /** The markets agree with Pinnacle within 5 points (null when no market prices the game). */
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
 * The expected script for a line's game, from Pinnacle (spread, total, win chance) and the prediction markets' win
 * chances. Null when Pinnacle has no line for the game or the player's team can't be placed.
 */
export function gameScriptFor(line: PropLine, games: readonly GameLine[], markets: readonly MarketOdds[]): GameScript | null {
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
  // Market win chances for the player's team: a winner market naming its nickname or city, priced 0-100.
  const team = isHome ? home : away, other = isHome ? away : home;
  const chances = markets.flatMap((market) => {
    const text = words(`${market.eventTitle} ${market.question}`);
    if (!teamIn(text, team) || !teamIn(text, other) || /spread|o\/u|total|1h|half/i.test(market.question)) return [];
    const subject = /— (.+)$/.exec(market.question)?.[1];
    if (subject) {
      const yes = market.outcomes.find((outcome) => outcome.name === 'Yes');
      if (!yes) return [];
      return sameTeam(subject, team) ? [yes.probability / 100] : sameTeam(subject, other) ? [1 - yes.probability / 100] : [];
    }
    const outcome = market.outcomes.find((item) => sameTeam(item.name, team));
    return outcome ? [outcome.probability / 100] : [];
  });
  const marketsWin = chances.length ? Math.round(chances.reduce((sum, value) => sum + value, 0) / chances.length * 10_000) / 10_000 : null;
  return { teamMargin: spread?.line == null ? null : isHome ? -spread.line : spread.line, total: total?.line ?? null,
    teamWin, marketsWin, agree: marketsWin === null || teamWin === null ? null : Math.abs(marketsWin - teamWin) <= 0.05 };
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
    const kinds: ShadowKind[] = ['books', 'book:draftkings', 'book:hardrock', 'script', 'gkr', 'beta', 'beta-pass', 'history', 'trend'];
    // Game script: how GKR's side did with the script for it or against it. A team favored by 7+ or a high total
    // favors MORE on volume stats; an underdog by 7+ or a low total favors LESS.
    const scripts = all.filter((entry) => entry.kind === 'script' && entry.script);
    const backs = (entry: ShadowEntry) => {
      const script = entry.script!, sport = entry.lineSnapshot.sport;
      const high = sport === 'NFL' || sport === 'NCAAFB' ? 50 : sport === 'NBA' ? 232 : 168, low = sport === 'NFL' ? 40
        : sport === 'NCAAFB' ? 45 : sport === 'NBA' ? 218 : 156;
      const lean = (script.teamMargin !== null && script.teamMargin >= 7) || (script.total !== null && script.total >= high) ? 'MORE'
        : (script.teamMargin !== null && script.teamMargin <= -7) || (script.total !== null && script.total <= low) ? 'LESS' : null;
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
