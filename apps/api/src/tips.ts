import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GameLine } from './context/feeds.js';
import { teamsMatch } from './edge/market-map.js';

// Tips (owner, 2026-10-06): picks from paid tip services, added from a screenshot or pasted text. Claude reads them into
// rows, they live in their own section per account, and they're graded after the games so each service gets a record.
// Display-only: tips never feed GKR, Edge or any score.

export type TipMarket = 'MONEYLINE' | 'SPREAD' | 'TOTAL' | 'DOUBLE_CHANCE' | 'DRAW' | 'PLAYER_PROP' | 'OTHER';
export type TipStatus = 'PENDING' | 'WON' | 'LOST' | 'PUSH' | 'VOID';
export const TIP_MARKETS: readonly TipMarket[] = ['MONEYLINE', 'SPREAD', 'TOTAL', 'DOUBLE_CHANCE', 'DRAW', 'PLAYER_PROP', 'OTHER'];

/** One pick as read from the image or text. */
export interface TipDraft {
  readonly text: string; readonly sport: string | null; readonly league: string | null;
  readonly selection: string; readonly opponent: string | null; readonly market: TipMarket;
  readonly line: number | null; readonly side: 'OVER' | 'UNDER' | null; readonly stat: string | null;
  /** American odds when the post shows them. */
  readonly odds: number | null; readonly eventDate: string | null;
}

/** Pinnacle's no-vig chance for the tip, when its game is on the board. */
export interface TipMarketRead { readonly chance: number; readonly event: string; readonly start: string; readonly book: 'Pinnacle' }

/** Claude's opinion of one pick after a web search (odds, news, form). */
export interface TipOpinion {
  readonly id: string; readonly chance: number; readonly verdict: TipVerdict; readonly marketOdds: number | null;
  readonly oddsSource: string | null; readonly event: string | null; readonly start: string | null; readonly reasons: string[];
}
export type TipVerdict = 'PLAY' | 'LEAN' | 'PASS' | 'FADE';

/** CrownIQ's read on a tip: its chance (Pinnacle's no-vig price when the game is on the board, else Claude's estimate), the
 * best price known (the post's odds, else the odds Claude found), the EV at that price and a verdict. */
export interface TipAnalysis {
  readonly verdict: TipVerdict; readonly chance: number; readonly chanceSource: 'Pinnacle' | 'Claude';
  readonly price: number | null; readonly priceSource: string | null; readonly ev: number | null; readonly fairOdds: number;
  readonly reasons: string[]; readonly event: string | null; readonly start: string | null; readonly analyzedAt: string;
}

export interface Tip extends TipDraft {
  readonly id: string; readonly accountId: string; readonly batchId: string; readonly source: string; readonly createdAt: string;
  status: TipStatus; gradedAt: string | null; gradedBy: 'AI' | 'USER' | null; result: string | null;
  market_read: TipMarketRead | null;
  analysis?: TipAnalysis | null;
  /** The analysis is running (set at upload, cleared when it lands or fails). */
  analyzing?: boolean;
}

export const decimalFromAmerican = (odds: number) => odds > 0 ? 1 + odds / 100 : 1 + 100 / -odds;
export const americanFromChance = (chance: number) => chance >= .5 ? -Math.round(chance / (1 - chance) * 100) : Math.round((1 - chance) / chance * 100);

/** Turns Claude's opinion and the market into CrownIQ's verdict: by EV when a price is known, else Claude's own verdict. */
export function analysisFor(tip: Pick<Tip, 'odds' | 'market_read'>, opinion: TipOpinion, at: string): TipAnalysis {
  const pinnacle = tip.market_read?.chance ?? null, chance = pinnacle ?? opinion.chance;
  const price = tip.odds ?? opinion.marketOdds, priceSource = tip.odds !== null ? 'the post' : opinion.marketOdds !== null ? opinion.oddsSource ?? 'a sportsbook' : null;
  const ev = price === null ? null : Math.round((chance * decimalFromAmerican(price) - 1) * 1000) / 1000;
  const verdict: TipVerdict = ev === null ? opinion.verdict : ev >= .03 ? 'PLAY' : ev >= 0 ? 'LEAN' : ev > -.05 ? 'PASS' : 'FADE';
  return { verdict, chance: Math.round(chance * 1000) / 1000, chanceSource: pinnacle !== null ? 'Pinnacle' : 'Claude', price, priceSource, ev,
    fairOdds: americanFromChance(chance), reasons: opinion.reasons, event: tip.market_read?.event ?? opinion.event,
    start: tip.market_read?.start ?? opinion.start, analyzedAt: at };
}

export interface TipReader {
  /** Reads the picks (and the service's name when it shows) from a screenshot or pasted text. */
  read(input: { image?: { data: string; mediaType: string }; text?: string; today: string }): Promise<{ source: string | null; tips: TipDraft[] }>;
  /** CrownIQ's second opinion on each pick (web search for odds, news and form). */
  analyze(tips: readonly (TipDraft & { id: string; market_read: TipMarketRead | null })[], today: string): Promise<TipOpinion[]>;
  /** Looks up final results; returns one entry per tip it could settle. */
  grade(tips: readonly Tip[], today: string): Promise<{ id: string; status: Exclude<TipStatus, 'PENDING'>; result: string }[]>;
}

/** Uploads per account in any 24 hours (each one is a paid Claude call). */
export const DAILY_TIP_UPLOADS = 30;
const DAY = 86_400_000;

interface Saved { tips: Tip[] }

/** Pinnacle's chance for a tip: moneyline, team-or-draw, draw, or a spread at Pinnacle's own number. */
export function marketRead(tip: TipDraft, lines: readonly GameLine[], fromMs: number): TipMarketRead | null {
  const selection = tip.selection.replace(/\b(ml|moneyline|or draw|draw no bet)\b/gi, '').trim();
  if (!selection || !['MONEYLINE', 'DOUBLE_CHANCE', 'SPREAD', 'DRAW'].includes(tip.market)) return null;
  const near = lines.filter((line) => { const start = Date.parse(line.startTime); return start >= fromMs - 6 * 3600_000 && start <= fromMs + 4 * DAY; });
  const side = (line: GameLine) => teamsMatch(selection, line.home) ? 'home' : teamsMatch(selection, line.away) ? 'away' : null;
  const moneyline = near.find((line) => line.market === 'moneyline' && side(line) && line.homeFair !== null && line.awayFair !== null);
  const read = (line: GameLine, chance: number) => ({ chance: Math.round(chance * 1000) / 1000, event: `${line.away} @ ${line.home}`,
    start: line.startTime, book: 'Pinnacle' as const });
  if (moneyline) {
    const home = moneyline.homeFair!, away = moneyline.awayFair!, draw = Math.max(0, 1 - home - away), mine = side(moneyline);
    if (tip.market === 'MONEYLINE') return read(moneyline, mine === 'home' ? home : away);
    // Team or draw needs a three-way price (a draw chance left over).
    if (tip.market === 'DOUBLE_CHANCE' && draw > .03) return read(moneyline, mine === 'home' ? home + draw : away + draw);
    if (tip.market === 'DRAW' && draw > .03) return read(moneyline, draw);
  }
  if (tip.market === 'SPREAD' && tip.line !== null) {
    const spread = near.find((line) => line.market === 'spread' && line.line !== null && side(line) &&
      (side(line) === 'home' ? line.line === tip.line : line.line === -tip.line!) && line.homeFair !== null && line.awayFair !== null);
    if (spread) return read(spread, side(spread) === 'home' ? spread.homeFair! : spread.awayFair!);
  }
  return null;
}

/** A service's record: settled picks, hit rate, units at the posted odds, and how often it beat Pinnacle's chance. */
export function sourceRecord(tips: readonly Tip[]) {
  const settled = tips.filter((tip) => tip.status === 'WON' || tip.status === 'LOST');
  const won = settled.filter((tip) => tip.status === 'WON').length;
  const priced = settled.filter((tip) => tip.odds !== null);
  const profit = (tip: Tip) => tip.status === 'LOST' ? -1 : tip.odds! > 0 ? tip.odds! / 100 : 100 / -tip.odds!;
  const withMarket = settled.filter((tip) => tip.market_read);
  return { picks: tips.length, pending: tips.filter((tip) => tip.status === 'PENDING').length, won, lost: settled.length - won,
    push: tips.filter((tip) => tip.status === 'PUSH').length,
    hitRate: settled.length ? Math.round(won / settled.length * 1000) / 1000 : null,
    units: priced.length ? Math.round(priced.reduce((sum, tip) => sum + profit(tip), 0) * 100) / 100 : null, unitsPicks: priced.length,
    // Wins against what Pinnacle expected: positive = the service picked better than the market.
    vsMarket: withMarket.length ? Math.round((withMarket.filter((tip) => tip.status === 'WON').length -
      withMarket.reduce((sum, tip) => sum + tip.market_read!.chance, 0)) * 100) / 100 : null, marketPicks: withMarket.length };
}

export class TipStore {
  private data: Saved | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string | null, private readonly clock: () => Date = () => new Date()) {}

  private async load(): Promise<Saved> {
    if (this.data) return this.data;
    let saved: Saved = { tips: [] };
    if (this.file) try { saved = JSON.parse(await readFile(this.file, 'utf8')) as Saved; } catch { /* first run */ }
    this.data = { tips: saved.tips ?? [] };
    return this.data;
  }
  private async save() {
    if (!this.file || !this.data) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data), { mode: 0o600 });
    await rename(temporary, this.file);
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task); this.chain = result.catch(() => undefined); return result;
  }

  /** Uploads (batches) this account made in the last 24 hours. */
  async uploadsToday(accountId: string): Promise<number> {
    const now = this.clock().getTime();
    return new Set((await this.load()).tips.filter((tip) => tip.accountId === accountId && Date.parse(tip.createdAt) > now - DAY)
      .map((tip) => tip.batchId)).size;
  }

  /** Saves one upload's picks under a service name. */
  add(accountId: string, source: string, drafts: readonly TipDraft[], reads: readonly (TipMarketRead | null)[]): Promise<Tip[]> {
    return this.exclusive(async () => {
      const data = await this.load(), now = this.clock().toISOString(), batchId = randomUUID();
      const tips = drafts.map((draft, index): Tip => ({ ...draft, id: randomUUID(), accountId, batchId, source, createdAt: now,
        status: 'PENDING', gradedAt: null, gradedBy: null, result: null, market_read: reads[index] ?? null, analysis: null, analyzing: true }));
      data.tips.push(...tips);
      await this.save();
      return tips;
    });
  }

  /** An account's tips, newest first, and each service's record. */
  async mine(accountId: string) {
    const tips = (await this.load()).tips.filter((tip) => tip.accountId === accountId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const sources = [...new Set(tips.map((tip) => tip.source))];
    return { tips: tips.map(({ accountId: _account, ...tip }) => tip),
      sources: Object.fromEntries(sources.map((source) => [source, sourceRecord(tips.filter((tip) => tip.source === source))])) };
  }

  /** The account marks a result itself, renames a service, or removes a tip. */
  update(accountId: string, id: string, change: { status?: TipStatus; source?: string }): Promise<boolean> {
    return this.exclusive(async () => {
      const data = await this.load(), tip = data.tips.find((item) => item.id === id && item.accountId === accountId);
      if (!tip) return false;
      if (change.status) Object.assign(tip, { status: change.status, gradedAt: change.status === 'PENDING' ? null : this.clock().toISOString(),
        gradedBy: change.status === 'PENDING' ? null : 'USER', result: change.status === 'PENDING' ? null : 'Marked by you' });
      if (change.source) for (const item of data.tips) if (item.accountId === accountId && item.batchId === tip.batchId) Object.assign(item, { source: change.source });
      await this.save();
      return true;
    });
  }
  remove(accountId: string, id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const data = await this.load(), before = data.tips.length;
      data.tips = data.tips.filter((tip) => !(tip.id === id && tip.accountId === accountId));
      if (data.tips.length === before) return false;
      await this.save();
      return true;
    });
  }

  /** Saves the analyses for these tips and clears their analyzing flag (also when the analysis failed). */
  setAnalyses(ids: readonly string[], analyses: ReadonlyMap<string, TipAnalysis>): Promise<void> {
    return this.exclusive(async () => {
      const data = await this.load();
      for (const tip of data.tips) if (ids.includes(tip.id)) Object.assign(tip, { analyzing: false, ...analyses.has(tip.id) ? { analysis: analyses.get(tip.id) } : {} });
      await this.save();
    });
  }
  /** Marks an account's tips as being re-analyzed; returns them (only ones not analyzed in the last 30 minutes). */
  startRecheck(accountId: string, ids: readonly string[]): Promise<Tip[]> {
    return this.exclusive(async () => {
      const data = await this.load();
      // A pick the AI already read is never sent again (owner, 2026-10-07: no duplicate runs); only unread picks are.
      const tips = data.tips.filter((tip) => tip.accountId === accountId && ids.includes(tip.id) && tip.status === 'PENDING' && !tip.analyzing &&
        !tip.analysis);
      for (const tip of tips) tip.analyzing = true;
      if (tips.length) await this.save();
      return tips.map((tip) => ({ ...tip }));
    });
  }

  /** Pending tips whose game should be over (4h after the known start, else a day after posting), up to 10 days old. */
  async gradable(limit = 60): Promise<Tip[]> {
    const now = this.clock().getTime();
    return (await this.load()).tips.filter((tip) => {
      if (tip.status !== 'PENDING' || Date.parse(tip.createdAt) < now - 10 * DAY) return false;
      const known = tip.market_read?.start ?? tip.analysis?.start ?? null;
      const start = known && Number.isFinite(Date.parse(known)) ? Date.parse(known) : tip.eventDate ? Date.parse(tip.eventDate) + 20 * 3600_000 : Date.parse(tip.createdAt) + 20 * 3600_000;
      return start + 4 * 3600_000 < now;
    }).slice(0, limit);
  }

  /** Saves graded results (only tips still pending). */
  settle(results: readonly { id: string; status: Exclude<TipStatus, 'PENDING'>; result: string }[]): Promise<number> {
    return this.exclusive(async () => {
      const data = await this.load(), now = this.clock().toISOString();
      let count = 0;
      for (const result of results) {
        const tip = data.tips.find((item) => item.id === result.id && item.status === 'PENDING');
        if (!tip) continue;
        Object.assign(tip, { status: result.status, gradedAt: now, gradedBy: 'AI', result: result.result.slice(0, 200) });
        count++;
      }
      if (count) await this.save();
      return count;
    });
  }
}

/** Runs CrownIQ's analysis for a set of tips and saves it; never throws (a failure just clears the analyzing flag). */
export async function analyzeTips(store: TipStore, reader: TipReader, tips: readonly Tip[], clock: () => Date = () => new Date()): Promise<number> {
  const analyses = new Map<string, TipAnalysis>();
  try {
    for (let index = 0; index < tips.length; index += 15) {
      const batch = tips.slice(index, index + 15);
      const opinions = await reader.analyze(batch, clock().toISOString().slice(0, 10));
      const at = clock().toISOString();
      for (const opinion of opinions) { const tip = batch.find((item) => item.id === opinion.id); if (tip) analyses.set(tip.id, analysisFor(tip, opinion, at)); }
    }
  } catch (error) { console.warn('[tips] analysis failed', error instanceof Error ? error.message : error); }
  await store.setAnalyses(tips.map((tip) => tip.id), analyses);
  return analyses.size;
}

/** Grades pending tips every two hours, a batch of 15 per Claude call, at most 4 calls a run. */
export class TipGrader {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  last: { at: string; graded: number; error: string | null } | null = null;
  constructor(private readonly store: TipStore, private readonly reader: TipReader, private readonly clock: () => Date = () => new Date()) {}
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let graded = 0, error: string | null = null;
    try {
      const pending = await this.store.gradable(60);
      for (let index = 0; index < pending.length; index += 15) {
        const results = await this.reader.grade(pending.slice(index, index + 15), this.clock().toISOString().slice(0, 10));
        graded += await this.store.settle(results);
      }
    } catch (failure) { error = failure instanceof Error ? failure.message : 'TIP_GRADING_FAILED'; }
    finally { this.running = false; this.last = { at: this.clock().toISOString(), graded, error }; }
    if (graded || error) console.log(`[tips] graded ${graded}${error ? `, error ${error}` : ''}`);
    return graded;
  }
  start(intervalMs = 2 * 3600_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
