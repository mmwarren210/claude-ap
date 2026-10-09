import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { BoardResponse, EdgeBoardPage, EdgeBoardResponse, EdgeBoardRow, EdgeEntry, EdgePick, EdgePlatform, EdgeSlip, Payouts,
  PlayableDirection, PropLine } from '@crowniq/contracts';
import { backtestProjection, buildSlips, describeEntry, EDGE_MODEL_VERSION, entriesFromTables, evaluateSlip, fitCalibration, suggestSwap,
  forecastReport, marketProfiles, parlayEntries, priceBoard, profileFor, profileKey } from '@crowniq/edge';
import { inChoice, rankScore } from '@crowniq/edge';
import type { CalibrationModel, EntryDefinition, SidePayout, StatRow, UnpricedLine } from '@crowniq/edge';
import type { BoxScoreResults } from '../box-score-results.js';
import type { FairPrice, PickemLine } from '../context/sharp-props.js';
import { normalizedName } from '../context/match.js';
import type { InternalHistoryRow, InternalHistoryStore } from '../internal-history.js';
import type { StoredLine } from '../scrapers/line-store.js';
import { leagueLabel, segmentBase } from '../scrapers/markets.js';
import { appLines, bookLines } from './platform-lines.js';
import type { MovementTracker } from './movement.js';
import type { GameLine } from '../context/feeds.js';
import type { BookWeightStore } from './book-weights.js';
import type { DispersionStore } from './dispersion-store.js';
import { GameEnvironment, restEffects, restFactor } from './environment.js';
import type { RestEffect } from './environment.js';
import type { SnapshotStore } from './snapshots.js';
import type { PayoutBook } from './platform-lines.js';
import type { EdgeLedger, EdgeResultFact, TrackedEdgePick } from './ledger.js';
import { gradeTarget } from './ledger.js';
import { freeGradedSports, freeHistoryActual } from '../free-history-grading.js';
import type { FreeHistoryValues } from '../free-history-grading.js';
import { canonicalMarket, matchBookPrices, playerKey } from './market-map.js';
import type { MatchReport } from './market-map.js';

// CrownIQ Edge (Edge 2.0): a standalone engine on every platform the app supports: PrizePicks (the scraped board plus any
// line SharpAPI lists that the scrapers missed), Underdog and Pick6 (their scraped boards with each pick's
// multiplier), DraftKings and Hard Rock (their SharpAPI prices). Each line is priced from the other sportsbooks' prices
// (a platform never confirms its own price), CrownIQ's game rows and the same History values every tab uses, then held
// against that platform's own payout: the entry's break-even over the pick's multiplier, or 1 / the book's odds. Every
// line gets a read or a "No read" with the exact missing input. It never reads GKR output and is never compared with GKR.

export interface EdgeServiceOptions {
  readonly board: () => BoardResponse | null;
  /** SharpAPI's latest book prices and PrizePicks lines. */
  readonly sharp?: { prices(): Promise<readonly FairPrice[]>; pickem(): Promise<readonly PickemLine[]> } | null;
  /** The scraped Underdog and Pick6 boards. */
  readonly appBoards?: { active(app: 'underdog' | 'pick6' | 'dabble'): Promise<readonly StoredLine[]> } | null;
  readonly history?: InternalHistoryStore | null;
  /** A player's recent values for a line's stat (the shared History values), newest first. */
  readonly values?: ((line: PropLine) => Promise<{ values: number[] } | null>) | null;
  readonly ledger?: EdgeLedger | null;
  readonly payouts: Payouts;
  readonly alternateFactors?: Partial<Record<'GOBLIN' | 'DEMON', number>>;
  /** Goblin/Demon factor curve exponents (pricing.ts alternateFactorFor). */
  readonly alternateCurve?: Partial<Record<'GOBLIN' | 'DEMON', number>>;
  /** Pick6 has no public payout chart: its entry tables only count once the owner confirms them (EDGE_PICK6_PAYOUTS_CONFIRMED). */
  readonly pick6PayoutsConfirmed?: boolean;
  readonly clock?: () => Date;
  /** Reprice at least this often (drops started games, picks up new prices and history). */
  readonly ttlMs?: number;
  /** How long one pricing pass may spend gathering History values (the rest arrive on the next pass, cached). */
  readonly valuesBudgetMs?: number;
  /** Where the History values cache is kept, so a restart doesn't start Edge with no history. */
  readonly valuesCacheFile?: string | null;
  /** Book moves across SharpAPI refreshes (spec §3.1) and the odds snapshots, for stale-line checks (§3.2). */
  readonly movement?: MovementTracker | null;
  readonly snapshots?: Pick<SnapshotStore, 'lastChange' | 'bookEvents' | 'bookRows'> | null;
  /** Players on the injury report (display feed); OUT/DOUBTFUL players are never ranked (§3.3). */
  readonly injuries?: (() => Promise<readonly { player: string; team: string; status: string; league: string }[]>) | null;
  /** Where in-app alerts are kept (§8). */
  readonly alertsFile?: string | null;
  /** Edge (in points) a stale pick needs to raise an alert. */
  readonly alertMinEdge?: number;
  /** The stats model's measured weight by sport and market (spec §5.6), for ranking model-only picks. */
  readonly honesty?: ((sport: string, market: string) => number) | null;
  /** Pinnacle's game lines (display feed), for the team-environment adjustment (spec §5.1). */
  readonly gameLines?: (() => Promise<readonly GameLine[]>) | null;
  /** The learned dispersion table (spec §2.1), refit daily from the board players' game rows. */
  readonly dispersion?: DispersionStore | null;
  /** Book weights learned from the snapshot store (spec §2.2), refit daily. */
  readonly bookWeights?: BookWeightStore | null;
  /** Every STALE flag as it's first seen, for the replay report (spec §3 acceptance). */
  readonly staleLogFile?: string | null;
}

/** One STALE flag when first seen: the app's number and the books' consensus at that moment. */
export interface StaleEvent {
  readonly at: string; readonly platform: EdgePlatform; readonly key: string; readonly side: PlayableDirection;
  readonly playerName: string; readonly market: string; readonly number: number; readonly consensusMean: number;
  readonly probability: number; readonly minutesAfterMove: number; readonly books: number; readonly eventStartTime: string;
}

/** An in-app alert: a stale or steamed line Edge rates, at most one per player per hour (spec §8). */
export interface EdgeAlert {
  readonly id: string; readonly at: string; readonly platform: EdgePlatform; readonly lineId: string;
  readonly playerName: string; readonly market: string; readonly threshold: number; readonly side: PlayableDirection;
  readonly probability: number; readonly edge: number; readonly ev?: number; readonly text: string; readonly eventStartTime: string;
}

export interface EdgeSnapshot {
  readonly platform: EdgePlatform;
  readonly response: EdgeBoardResponse;
  readonly byLine: ReadonlyMap<string, EdgePick>;
  /** Lines Edge could not read, kept so the Edge board lists every line. */
  readonly unpriced: readonly UnpricedLine[];
  readonly lines: ReadonlyMap<string, PropLine>;
  readonly computedAt: number;
  readonly durationMs: number;
  readonly report: EdgeReport;
  /** Games an entry needs on this platform (pick'em apps 2, sportsbook parlays 1). */
  readonly minEvents: number;
}

/** What one pricing pass saw on one platform, for the phase reports and owner diagnostics. */
export interface EdgeReport {
  readonly platform: EdgePlatform;
  readonly lines: number; readonly read: number; readonly noRead: number;
  readonly noReadByReason: Readonly<Record<string, number>>;
  readonly plusEv: number;
  /** Reads left with edge = null (no confirmed payout: Goblins/Demons, unconfirmed Pick6 tables, promos). */
  readonly edgeNull: number;
  readonly byTier: Readonly<Record<string, number>>;
  /** +EV reads by rating (THIN is under 2 points). */
  readonly byRating: Readonly<Record<string, number>>;
  /** Picks flagged STALE / with steam, and players not ranked because of the injury report. */
  readonly stale: number; readonly steam: number; readonly injured: number;
  readonly sharpApi?: { readonly lines: number; readonly confirmed: number; readonly added: number };
  readonly match: MatchReport | null;
  readonly historyValues: { readonly asked: number; readonly found: number };
  /** Sportsbooks: where the +EV bets sit (by side, by odds range, by sport) and their median EV, to spot a systematic lean. */
  readonly evShape?: { readonly side: Record<string, number>; readonly odds: Record<string, number>; readonly sport: Record<string, number>;
    readonly medianEv: number | null };
}

/** Spec §4: ¼ Kelly is capped at 2% per bet (in pricing) and 6% per game; a game's ranked bets over 6% are scaled down together. */
export function capGameKelly(picks: EdgePick[]): void {
  const totals = new Map<string, number>();
  for (const pick of picks) if (pick.kelly && pick.rating !== 'NONE') totals.set(pick.eventId, (totals.get(pick.eventId) ?? 0) + pick.kelly);
  picks.forEach((pick, index) => {
    const total = totals.get(pick.eventId) ?? 0;
    if (pick.kelly && pick.rating !== 'NONE' && total > .06)
      picks[index] = { ...pick, kelly: Math.round(pick.kelly * .06 / total * 10_000) / 10_000,
        warnings: [...pick.warnings, `Stake scaled down: Edge's bets on this game add up to ${(total * 100).toFixed(1)}% of bankroll; the cap is 6% per game.`] };
  });
}

function evShape(picks: readonly EdgePick[]) {
  const plus = picks.filter((pick) => pick.edge !== null && pick.edge > 0 && pick.rating !== 'NONE' && pick.decimalOdds);
  const tally = (select: (pick: EdgePick) => string) => {
    const out: Record<string, number> = {};
    for (const pick of plus) out[select(pick)] = (out[select(pick)] ?? 0) + 1;
    return out;
  };
  const evs = plus.map((pick) => pick.ev ?? 0).sort((a, b) => a - b);
  return { side: tally((pick) => pick.side),
    odds: tally((pick) => pick.decimalOdds! < 1.7 ? 'under 1.70' : pick.decimalOdds! <= 2.2 ? '1.70-2.20' : pick.decimalOdds! <= 3.5 ? '2.20-3.50' : 'over 3.50'),
    sport: tally((pick) => pick.sport), medianEv: evs.length ? Math.round(evs[Math.floor(evs.length / 2)]! * 1000) / 1000 : null };
}

export const EDGE_PLATFORMS: readonly EdgePlatform[] = ['prizepicks', 'underdog', 'pick6', 'dabble', 'draftkings', 'hardrock', 'pinnacle', 'kalshi'];
/** Platforms whose lines are a sportsbook's or exchange's own props, priced by their odds (owner, 2026-10-09: Pinnacle and Kalshi tabs). */
export const BOOK_PLATFORMS = ['draftkings', 'hardrock', 'pinnacle', 'kalshi'] as const;
export const isBookPlatform = (platform: string): platform is typeof BOOK_PLATFORMS[number] => (BOOK_PLATFORMS as readonly string[]).includes(platform);
/** Each platform's book in SharpAPI, left out of its own fair price (a book never confirms its own price). */
const ownBooks: Readonly<Record<EdgePlatform, readonly string[]>> = { prizepicks: ['prizepicks', 'prizepicks_flex'],
  underdog: ['underdog'], pick6: ['pick6'], dabble: ['dabble'], draftkings: ['draftkings'], hardrock: ['hardrock'], pinnacle: ['pinnacle'], kalshi: ['kalshi'] };
/** Largest parlay Edge builds per sportsbook (owner, 2026-10-09: Hard Rock 21, Pinnacle 21; Kalshi has no cap, so Edge stops at 50). */
const parlayMax: Readonly<Partial<Record<EdgePlatform, number>>> = { draftkings: 8, hardrock: 21, pinnacle: 21, kalshi: 50 };

export type EdgeView = 'edges' | 'alternates' | 'all';

const historySports = new Set(['NFL', 'NBA', 'MLB']);

/** A box score can arrive from several sources for the same game; keep one row per day, preferring full metrics. */
export function dedupeRows(rows: readonly InternalHistoryRow[]): StatRow[] {
  const byDay = new Map<string, InternalHistoryRow>();
  for (const row of rows) {
    const day = row.occurredAt.slice(0, 10), existing = byDay.get(day);
    if (!existing || (!Object.keys(existing.metrics).length && Object.keys(row.metrics).length)) byDay.set(day, row);
    else if (Object.keys(row.marketValues).length) {
      byDay.set(day, { ...existing, marketValues: { ...row.marketValues, ...existing.marketValues } });
    }
  }
  return [...byDay.values()];
}

const lineKey = (sport: string, player: string, market: string, threshold: number) =>
  `${sport}|${normalizedName(player)}|${canonicalMarket(sport, market)}|${threshold}`;

/**
 * Step 7: the stale replay in one line: alerts, how many reached the close, the average closing-line value (the close's
 * chance for the alerted side minus Edge's chance at the alert), and the graded win rate.
 */
export function staleSummary(events: readonly { probability: number; closeProbability: number | null; outcome: string | null }[]) {
  const closed = events.filter((event) => event.closeProbability !== null);
  const graded = events.filter((event) => event.outcome === 'WIN' || event.outcome === 'LOSS');
  return { alerts: events.length, closed: closed.length,
    averageClv: closed.length ? Math.round(closed.reduce((sum, event) => sum + event.closeProbability! - event.probability, 0) / closed.length * 10_000) / 10_000 : null,
    graded: graded.length, winRate: graded.length ? Math.round(graded.filter((event) => event.outcome === 'WIN').length / graded.length * 1000) / 1000 : null };
}

/** Golf (DataGolf declined by the owner), darts, F1, NASCAR, NPB and cricket: no sportsbook props and no free stats source. */
export const uncoveredSport = (line: Pick<PropLine, 'sport' | 'league'>) =>
  line.sport === 'DARTS' || /GOLF|PGA|LPGA|LIV|^F1|FORMULA|NASCAR|INDYCAR|NPB|CRICKET|IPL/i.test(line.league);

/** One platform's side-bias state: lopsided and balanced refreshes running, the latest share and side, and its markets. */
export interface SideBias {
  readonly streak: number; readonly clean: number; readonly share: number | null; readonly side: 'MORE' | 'LESS' | null;
  readonly plusEv: number; readonly markets: Readonly<Record<string, number>>; readonly checks: number;
}

/** One refresh of the side-bias check: lopsided (> 80% one side, 10+ +EV picks) or balanced, counted in a row. */
export function nextSideBias(previous: SideBias | null, picks: readonly Pick<EdgePick, 'edge' | 'rating' | 'side' | 'sport' | 'market'>[]): SideBias {
  const prior = previous ?? { streak: 0, clean: 0, share: null, side: null, plusEv: 0, markets: {}, checks: 0 };
  const plusEv = picks.filter((pick) => pick.edge !== null && pick.edge > 0 && pick.rating !== 'NONE');
  if (plusEv.length < 10) return { ...prior, share: prior.share, plusEv: plusEv.length, checks: prior.checks + 1 };
  const more = plusEv.filter((pick) => pick.side === 'MORE').length;
  const side = more >= plusEv.length - more ? 'MORE' : 'LESS', share = Math.max(more, plusEv.length - more) / plusEv.length;
  const markets: Record<string, number> = {};
  for (const pick of plusEv) if (pick.side === side) markets[`${pick.sport}:${pick.market}`] = (markets[`${pick.sport}:${pick.market}`] ?? 0) + 1;
  const lopsided = share > .8;
  return { streak: lopsided ? prior.streak + 1 : 0, clean: lopsided ? 0 : prior.clean + 1, share: Math.round(share * 1000) / 1000, side,
    plusEv: plusEv.length, markets: Object.fromEntries(Object.entries(markets).sort((a, b) => b[1] - a[1]).slice(0, 6)), checks: prior.checks + 1 };
}

/** Every pick'em app's regular numbers by canonical player, stat and game day: platform → numbers. */
export type AnchorIndex = Map<string, Map<string, number[]>>;
const isPickem = (platform: string) => platform === 'prizepicks' || platform === 'underdog' || platform === 'pick6' || platform === 'dabble';
const anchorKey = (line: Pick<PropLine, 'sport' | 'league' | 'playerName' | 'market' | 'eventStartTime'>) =>
  `${line.sport === 'OTHER' ? line.league.toUpperCase() : line.sport}|${normalizedName(line.playerName)}|${canonicalMarket(line.sport, line.market)}|${line.eventStartTime.slice(0, 10)}`;

/** Step 3: the pick'em apps' regular lines, indexed so each platform can read the others'. */
export function dfsAnchors(sets: readonly { platform: string; lines: readonly PropLine[];
  promos?: ReadonlyMap<string, number | null> }[]): AnchorIndex {
  const index: AnchorIndex = new Map();
  for (const set of sets) {
    if (!isPickem(set.platform)) continue;
    for (const line of set.lines) {
      // Fantasy score is scored differently per app (PrizePicks full PPR, Underdog half PPR), so it never anchors across apps.
      if (line.lineType !== 'REGULAR' || set.promos?.has(line.id) || /fantasy/.test(line.market)) continue;
      const byPlatform = index.get(anchorKey(line)) ?? new Map<string, number[]>();
      const numbers = byPlatform.get(set.platform) ?? [];
      if (!numbers.includes(line.threshold)) numbers.push(line.threshold);
      byPlatform.set(set.platform, numbers); index.set(anchorKey(line), byPlatform);
    }
  }
  return index;
}

/** The other apps' regular numbers for a line (one per app; an app listing several gives none, as it's ambiguous). */
export function anchorsFor(index: AnchorIndex, line: PropLine, platform: string): number[] {
  return [...(index.get(anchorKey(line)) ?? [])].filter(([other, numbers]) => other !== platform && numbers.length === 1).map(([, numbers]) => numbers[0]!);
}

/** SharpAPI's PrizePicks lines the scraped board doesn't have, as board lines; and how many it confirms. */
export function sharpPrizePicksLines(board: readonly PropLine[], pickem: readonly PickemLine[], fetchedAt: string) {
  const onBoard = new Set(board.map((line) => lineKey(line.sport, line.playerName, line.market, line.threshold)));
  const players = new Set(board.map((line) => `${line.sport}|${normalizedName(line.playerName)}|${canonicalMarket(line.sport, line.market)}`));
  const added: PropLine[] = [];
  let confirmed = 0, total = 0;
  const seen = new Set<string>();
  for (const line of pickem) {
    if ((line.book !== 'prizepicks' && line.book !== 'prizepicks_flex') || !line.sport || line.stale) continue;
    const id = `sharpapi:pp:${line.eventId}:${normalizedName(line.player).replace(/ /g, '-')}:${line.market ?? line.marketType.replace(/^player_/, '')}:${line.line}`;
    // Both PrizePicks books list the same line once each.
    if (seen.has(id)) continue;
    seen.add(id);
    total++;
    const market = line.market ?? line.marketType.replace(/^player_/, '');
    if (onBoard.has(lineKey(line.sport, line.player, market, line.line))) { confirmed++; continue; }
    // A different number for a player and stat the board already lists is a moved line or an alternate the scrapers will
    // carry; only lines for a player and stat the board lacks are added.
    if (players.has(`${line.sport}|${normalizedName(line.player)}|${canonicalMarket(line.sport, market)}`)) continue;
    added.push({ id, provider: 'prizepicks', sourceLineId: id, sourceLineIdIsSynthetic: true, sport: line.sport,
      league: leagueLabel(line.sport), eventId: `sharpapi:${line.eventId}`, eventName: line.home && line.away
        ? `${line.away} @ ${line.home}` : line.eventId, eventStartTime: new Date(line.startTime).toISOString(),
      playerId: `sharpapi:${line.sport}:${normalizedName(line.player)}`, playerName: line.player, team: null, opponent: null,
      homeTeam: line.home, awayTeam: line.away, market, threshold: line.line, availableDirections: [...line.sides],
      lineType: line.alternate ? 'UNKNOWN_ALTERNATE' : 'REGULAR', fetchedAt });
  }
  return { added, confirmed, total };
}

/** One platform's lines for a pass, each side's payout, and its entries. */
interface PlatformSet {
  readonly platform: EdgePlatform;
  readonly lines: PropLine[];
  readonly payouts: PayoutBook | null;
  readonly entries: EntryDefinition[];
  readonly minEvents: number;
  readonly sharpApi?: EdgeReport['sharpApi'];
  /** Promo lines (id → the number before the promo moved it, or null): never anchors, checked at the original number. */
  readonly promos?: ReadonlyMap<string, number | null>;
}

export class EdgeService {
  private photos = new Map<string, string>();
  private alerts: EdgeAlert[] = [];
  private weakTiers: ReadonlySet<string> = new Set();
  private rest: { at: number; effects: Map<string, RestEffect> } = { at: 0, effects: new Map() };
  private statsAdjust: ((line: PropLine) => { factor: number; reasons: string[] } | null) | null = null;
  private honestyWeights: ReadonlyMap<string, number> = new Map();
  private staleSeen = new Set<string>();
  private lastAlertFor = new Map<string, number>();
  private current = new Map<EdgePlatform, EdgeSnapshot>();
  private computedAt = 0;
  /** The last pass was the quick one after a restart (thin history): shown, not recorded, and redone in full next. */
  private quickPass = false;
  private key: string | null = null;
  private pending: Promise<void> | null = null;
  private lastError: string | null = null;
  private readonly clock: () => Date;

  constructor(private readonly options: EdgeServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    if (options.alertsFile) {
      try { this.alerts = JSON.parse(readFileSync(options.alertsFile, 'utf8')) as EdgeAlert[]; } catch { /* first run */ }
    }
    if (options.valuesCacheFile) {
      try {
        const saved = JSON.parse(readFileSync(options.valuesCacheFile, 'utf8')) as [string, { until: number; values: number[] | null }][];
        const nowMs = Date.now();
        for (const [key, value] of saved) if (value.until > nowMs) this.valuesCache.set(key, value);
      } catch { /* first run */ }
    }
  }

  /** A platform's entries: the app's own payout charts (Pick6 only once confirmed), or sportsbook parlays. */
  private entriesFor(platform: EdgePlatform): EntryDefinition[] {
    if (isBookPlatform(platform)) return parlayEntries(parlayMax[platform]!);
    return entriesFromTables(this.options.payouts[platform]);
  }

  private readonly bias = new Map<string, SideBias>();
  /**
   * Step 9 side-bias alarm: more than 80% of a platform's +EV picks on one side (MORE or LESS), two refreshes running, is
   * flagged here, in the log and on the owner pages, with the markets driving it; a flagged platform's ranked picks and
   * entries are held. Ten or more +EV picks are needed to judge.
   */
  private checkSideBias(snapshot: EdgeSnapshot) {
    // Only picks where the app offered both sides can show a lean: a MORE-only line (Goblin, Demon, a Pick6 alternate number)
    // has no LESS to pick, so it would read as "MORE bias" (owner diagnostics 2026-10-09: Pick6 85% MORE after its alternates).
    const choices = snapshot.response.picks.filter((pick) => pick.oppositeLineId !== null ||
      (snapshot.lines.get(pick.lineId)?.availableDirections.length ?? 0) > 1);
    // One line per player and stat: a book's ladder of alternate numbers (PropLine sends every number, 2026-10-09) leans one way
    // by construction, so only the number nearest Edge's own median is judged. Every alternate keeps its own read.
    const main = new Map<string, (typeof choices)[number]>();
    for (const pick of choices) {
      const key = `${pick.eventId}|${pick.playerId}|${pick.market}`, current = main.get(key);
      if (!current || Math.abs(pick.threshold - pick.projection.median) < Math.abs(current.threshold - current.projection.median)) main.set(key, pick);
    }
    const next = nextSideBias(this.bias.get(snapshot.platform) ?? null, [...main.values()]);
    this.bias.set(snapshot.platform, next);
    if (next.share === null) return;
    if (next.streak > 0) console.warn(`[edge-bias] ${snapshot.platform}: ${Math.round(next.share * 100)}% of ${next.plusEv} +EV picks are ${next.side}` +
      `${next.streak >= 2 ? ' (FLAGGED: held from Top Picks and Gen)' : ''}; markets ${JSON.stringify(next.markets)}`);
    else console.log(`[edge-bias] ${snapshot.platform}: ${next.side} ${Math.round(next.share * 100)}% of ${next.plusEv} +EV picks, ok`);
  }
  /** Whether a platform's +EV picks have been lopsided two refreshes running. */
  sideBiasFlagged(platform: string): boolean { return (this.bias.get(platform)?.streak ?? 0) >= 2; }
  /** Whether a platform has passed the side-bias check two refreshes running (a new feed is released only then). */
  sideBiasCleared(platform: string): boolean { return (this.bias.get(platform)?.clean ?? 0) >= 2; }
  sideBias(): Record<string, SideBias & { flagged: boolean }> {
    return Object.fromEntries([...this.bias].map(([platform, bias]) => [platform, { ...bias, flagged: bias.streak >= 2 }]));
  }

  status() {
    const reports = Object.fromEntries([...this.current].map(([platform, snapshot]) => [platform, snapshot.report]));
    const prizepicks = this.current.get('prizepicks');
    return { modelVersion: EDGE_MODEL_VERSION, computedAt: this.computedAt ? new Date(this.computedAt).toISOString() : null,
      durationMs: prizepicks?.durationMs ?? null, counts: prizepicks?.response.counts ?? null, report: prizepicks?.report ?? null,
      reports, calibration: prizepicks?.response.calibration ?? null, lastError: this.lastError, weakTiers: [...this.weakTiers],
      honesty: Object.fromEntries(this.honestyWeights), restEffects: Object.fromEntries(this.rest.effects),
      dispersion: this.options.dispersion?.status() ?? null, bookWeights: this.options.bookWeights?.status() ?? null,
      alternateFactors: this.options.alternateFactors ?? {}, alternateCurve: this.options.alternateCurve ?? {}, pick6PayoutsConfirmed: !!this.options.pick6PayoutsConfirmed,
      entries: Object.fromEntries(EDGE_PLATFORMS.map((platform) => [platform, this.entriesFor(platform).map((entry) => describeEntry(entry))])) };
  }

  /** A platform's latest pricing; every platform is repriced together when the board changes or the TTL passes. */
  async snapshot(platform: EdgePlatform = 'prizepicks'): Promise<EdgeSnapshot | null> {
    const board = this.options.board();
    if (!board) return null;
    const key = `${board.board.fetchedAt}|${board.builtAt}`;
    const fresh = this.computedAt && this.key === key && this.clock().getTime() - this.computedAt < (this.options.ttlMs ?? 5 * 60_000);
    // After a quick first pass (just after a restart), the full pass follows on the next call.
    if ((!fresh || this.quickPass) && !this.pending) this.pending = this.computeAll(board, key).finally(() => { this.pending = null; });
    if (!this.current.has(platform) && this.pending) await this.pending;
    return this.current.get(platform) ?? null;
  }

  /** History values Edge already looked up: kept 6 hours when found and 1 hour when not, so each pass only looks up
   * players it hasn't seen (coverage builds up across passes instead of restarting every 10 minutes). */
  private readonly valuesCache = new Map<string, { until: number; values: number[] | null }>();

  private async gatherValues(lines: readonly PropLine[], budgetMs?: number) {
    const found = new Map<string, number[]>();
    if (!this.options.values) return { found, asked: 0 };
    const nowMs = Date.now();
    const groups = new Map<string, PropLine>();
    for (const line of lines) groups.set(`${line.sport}|${line.playerId}|${line.market}`, groups.get(`${line.sport}|${line.playerId}|${line.market}`) ?? line);
    const queue: [string, PropLine][] = [];
    for (const [key, line] of groups) {
      const cached = this.valuesCache.get(key);
      if (cached && cached.until > nowMs) { if (cached.values) found.set(key, cached.values); }
      else queue.push([key, line]);
    }
    // Soonest games first: they matter most and their lines go first.
    queue.sort((a, b) => a[1].eventStartTime.localeCompare(b[1].eventStartTime));
    // A hard limit on the whole step (owner, 2026-10-09: steadier passes): at the deadline the pass goes on with what it has.
    // A lookup still running keeps going and is saved when it lands, so the next pass reads it.
    const deadline = nowMs + (budgetMs ?? this.options.valuesBudgetMs ?? 30_000);
    let timer: NodeJS.Timeout | undefined;
    const stop = new Promise<'STOP'>((done) => { timer = setTimeout(() => done('STOP'), Math.max(0, deadline - Date.now())); });
    const keep = (key: string, result: { values: number[] } | null) => {
      const values = result?.values.length ? result.values : null;
      this.valuesCache.set(key, { until: Date.now() + (values ? 6 : 1) * 3600_000, values });
      return values;
    };
    const worker = async () => {
      for (let item = queue.shift(); item && Date.now() < deadline; item = queue.shift()) {
        const key = item[0];
        const lookup = this.options.values!(item[1]).then((result) => keep(key, result)).catch(() => undefined); // a failure is retried next pass
        const values = await Promise.race([lookup, stop]);
        if (values === 'STOP') return;
        if (values) found.set(key, values);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    clearTimeout(timer);
    if (this.valuesCache.size > 50_000) for (const [key, value] of this.valuesCache) if (value.until <= nowMs) this.valuesCache.delete(key);
    if (this.options.valuesCacheFile) {
      const file = this.options.valuesCacheFile, temporary = `${file}.tmp`;
      await mkdir(dirname(file), { recursive: true }).then(() => writeFile(temporary, JSON.stringify([...this.valuesCache])))
        .then(() => rename(temporary, file)).catch(() => undefined);
    }
    return { found, asked: groups.size };
  }

  /** Every platform's lines for this pass. */
  private async platformSets(board: BoardResponse, prices: readonly FairPrice[], pickem: readonly PickemLine[],
    now: Date): Promise<PlatformSet[]> {
    const nowIso = now.toISOString(), open = (line: PropLine) => Date.parse(line.eventStartTime) > now.getTime();
    // PrizePicks' partial-game boards (NFL1H, NHL1P) are read as their base sport, so a 1st-half line meets the books'
    // 1st-half prices and the other apps' 1st-half lines (the board itself, and GKR, still see sport OTHER).
    const boardLines = board.board.lines.filter(open).map((line) => {
      const base = line.sport === 'OTHER' ? segmentBase(line.league) : null;
      return base ? { ...line, sport: base.sport } : line;
    });
    const extra = sharpPrizePicksLines(boardLines, pickem, nowIso);
    const sets: PlatformSet[] = [{ platform: 'prizepicks', lines: [...boardLines, ...extra.added.filter(open)], payouts: null,
      entries: this.entriesFor('prizepicks'), minEvents: 2,
      sharpApi: { lines: extra.total, confirmed: extra.confirmed, added: extra.added.length } }];
    for (const app of ['underdog', 'pick6', 'dabble'] as const) {
      const stored = await this.options.appBoards?.active(app).catch(() => []) ?? [];
      const { lines, payouts, promos } = appLines(stored, app, nowIso);
      if (promos.size) console.log(`[edge-promo] ${app} ${promos.size} promo lines: ${JSON.stringify(lines.filter((line) => promos.has(line.id))
        .slice(0, 5).map((line) => `${line.playerName} ${line.market} ${line.threshold} (was ${promos.get(line.id) ?? '?'})`))}`);
      sets.push({ platform: app, lines: lines.filter(open), payouts, promos, entries: this.entriesFor(app), minEvents: 2 });
    }
    for (const book of BOOK_PLATFORMS) {
      const { lines, payouts } = bookLines(prices, book, nowIso);
      sets.push({ platform: book, lines: lines.filter(open), payouts, entries: this.entriesFor(book), minEvents: 1 });
    }
    return sets;
  }

  private async computeAll(board: BoardResponse, key: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const now = this.clock();
      const [prices, pickem] = this.options.sharp
        ? await Promise.all([this.options.sharp.prices(), this.options.sharp.pickem()]) : [[], []];
      const sets = await this.platformSets(board, prices, pickem, now);
      // How long each step takes, so a slow refresh (a bigger board) shows where its time goes.
      const timing: Record<string, number> = {}; let mark = Date.now();
      const lap = (name: string) => { const at = Date.now(); timing[name] = at - mark; mark = at; };
      lap('sets');
      // Player photos for every platform's picks (books have none of their own): the board's photos, then app line images.
      const photos = new Map<string, string>(), names = new Map(board.board.lines.map((line) => [line.playerId, line.playerName]));
      for (const [playerId, media] of Object.entries(board.playerMedia ?? {}))
        if (media.photoUrl && names.has(playerId)) photos.set(normalizedName(names.get(playerId)!), media.photoUrl);
      for (const line of sets.flatMap((set) => set.lines))
        if (line.playerImageUrl && !photos.has(normalizedName(line.playerName))) photos.set(normalizedName(line.playerName), line.playerImageUrl);
      this.photos = photos;
      const allLines = sets.flatMap((set) => set.lines);
      const absurd = allLines.filter((line) => !(line.threshold <= 5000));
      if (absurd.length) console.warn(`[edge] lines with a threshold over 5,000: ${JSON.stringify(absurd.slice(0, 5).map((line) =>
        [line.id, line.sport, line.market, line.playerName, line.threshold]))}`);
      const players = new Map<string, { key: string; sport: string; playerId: string; playerName: string }>();
      for (const line of allLines) {
        if (!historySports.has(line.sport) || !profileFor(line.sport, line.market).stat) continue;
        const id = playerKey(line.sport, line.playerName);
        if (!players.has(id)) players.set(id, { key: id, sport: line.sport, playerId: line.playerId, playerName: line.playerName });
      }
      // Just after a restart nothing is showing yet, so the first pass is quick: history it can read within a few
      // seconds (the rest keeps loading for the full pass right after). A quick pass is shown but never recorded.
      const quick = this.current.size === 0;
      const within = <T,>(work: Promise<T>, ms: number, fallback: T) => quick
        ? Promise.race([work, new Promise<T>((done) => { setTimeout(() => done(fallback), ms); })]) : work;
      // PrizePicks lines first in the History queue (the main board), then the rest.
      const [rows, values] = await Promise.all([
        this.options.history && players.size ? within(this.options.history.rowsForPlayers([...players.values()], 60), 8_000, new Map<string, InternalHistoryRow[]>())
          : Promise.resolve(new Map<string, InternalHistoryRow[]>()),
        within(this.gatherValues(allLines, quick ? 5_000 : undefined), 6_000, { found: new Map<string, number[]>(), asked: 0 })]);
      lap('history');
      const calibrationRows = await this.options.ledger?.calibrationRows().catch(() => []) ?? [];
      const calibration = fitCalibration(calibrationRows);
      const forecast = forecastReport(calibrationRows);
      const injured = new Map<string, string>();
      for (const note of await this.options.injuries?.().catch(() => []) ?? [])
        if (/^(out|doubtful|suspended|inactive)/i.test(note.status)) injured.set(normalizedName(note.player), `${note.status}${note.team ? ` (${note.team})` : ''}`);
      this.weakTiers = await this.options.ledger?.weakTiers().catch(() => new Set<string>()) ?? new Set<string>();
      this.honestyWeights = await this.options.ledger?.honesty().catch(() => new Map<string, number>()) ?? new Map<string, number>();
      // Projection 2.0 inputs: today's game environment, and the back-to-back effect learned hourly from the game rows.
      const environment = new GameEnvironment(await this.options.gameLines?.().catch(() => []) ?? []);
      if (Date.now() - this.rest.at > 3600_000 && rows.size)
        this.rest = { at: Date.now(), effects: restEffects((function* () {
          for (const [key, list] of rows) yield { sport: key.split('|')[0]!, rows: dedupeRows(list) };
        })()) };
      if (this.options.dispersion?.due() && rows.size) {
        const store = this.options.dispersion;
        void store.refit((function* () { for (const [key, list] of rows) yield { sport: key.split('|')[0]!, rows: dedupeRows(list) }; })())
          .then((count) => console.log(`[edge-dispersion] refit ${count} markets`)).catch((error: unknown) => console.warn('[edge-dispersion] refit failed', error));
      }
      if (this.options.bookWeights?.due() && this.options.snapshots) {
        void this.options.bookWeights.refit(this.options.snapshots)
          .then((count) => console.log(`[edge-book-weights] refit ${count} weights`)).catch((error: unknown) => console.warn('[edge-book-weights] refit failed', error));
      }
      console.log(`[edge-p5] environment ${JSON.stringify(environment.summary())}, rest effects ${JSON.stringify(Object.fromEntries(
        [...this.rest.effects].map(([key, effect]) => [key, Number(effect.coefficient.toFixed(3))])))}, honesty ${JSON.stringify(Object.fromEntries(this.honestyWeights))}`);
      const lastGame = new Map([...rows].map(([key, list]) => [key, list.reduce((latest, row) => Math.max(latest, Date.parse(row.occurredAt)), 0)]));
      this.statsAdjust = (line: PropLine) => {
        const env = environment.factor(line);
        const before = lastGame.get(playerKey(line.sport, line.playerName));
        const rest = restFactor(line, before && before < Date.parse(line.eventStartTime) ? before : null, this.rest.effects);
        if (!env && !rest) return null;
        return { factor: (env?.factor ?? 1) * (rest?.factor ?? 1), reasons: [...env?.reasons ?? [], ...rest?.reasons ?? []] };
      };
      const fresh: EdgeAlert[] = [];
      // One platform at a time, yielding between them so requests keep being answered while the board reprices.
      const each: EdgeSnapshot[] = [];
      const anchors = dfsAnchors(sets);
      lap('inputs');
      for (const set of sets) {
        await yieldToLoop();
        each.push(this.priceSet(set, board, prices, now, calibration, forecast, rows, values, startedAt, injured, fresh, anchors));
        lap(`price:${set.platform}`);
      }
      const priced = crossPlatform(each);
      lap('crossPlatform');
      console.log(`[edge-timing] ${quick ? '(quick first pass) ' : ''}${JSON.stringify(timing)}`);
      this.quickPass = quick;
      for (const snapshot of priced) {
        this.current.set(snapshot.platform, snapshot);
        this.log(snapshot);
        if (quick) continue;
        this.checkSideBias(snapshot);
        void this.options.ledger?.record(snapshot.response.picks, (lineId) => {
          const line = snapshot.lines.get(lineId);
          return { team: line?.team ?? null, home: line?.homeTeam ?? null, away: line?.awayTeam ?? null };
        }).catch(() => undefined);
      }
      if (fresh.length) {
        this.alerts = [...fresh, ...this.alerts].slice(0, 200);
        if (this.options.alertsFile) {
          const file = this.options.alertsFile, temporary = `${file}.tmp`;
          await mkdir(dirname(file), { recursive: true }).then(() => writeFile(temporary, JSON.stringify(this.alerts)))
            .then(() => rename(temporary, file)).catch(() => undefined);
        }
      }
      this.computedAt = now.getTime(); this.key = key; this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'EDGE_PRICING_FAILED';
      console.error(JSON.stringify({ event: 'crowniq_edge_pricing_failed', error: this.lastError }));
    }
  }

  private priceSet(set: PlatformSet, board: BoardResponse, prices: readonly FairPrice[], now: Date,
    calibration: CalibrationModel, forecast: ReturnType<typeof forecastReport>, rows: Map<string, InternalHistoryRow[]>,
    values: { found: Map<string, number[]>; asked: number }, startedAt: number, injured: ReadonlyMap<string, string> = new Map(),
    alerts: EdgeAlert[] = [], anchors: AnchorIndex = new Map()): EdgeSnapshot {
    // A platform's own book never prices it, and pick'em apps' rows are payouts, never prices.
    const nowIso = now.toISOString(), own = [...new Set([...ownBooks[set.platform], 'prizepicks', 'prizepicks_flex', 'underdog', 'pick6', 'dabble'])];
    const matched = prices.length && set.lines.length ? matchBookPrices(set.lines, prices, nowIso, own, set.promos) : null;
    // Pick6's entry chart isn't public: until the owner confirms it, its picks get a chance but no edge. A pick'em app with
    // no payout chart at all (a new app before its chart is added) is the same: chances only, never an assumed payout.
    const unconfirmed = (set.platform === 'pick6' && !this.options.pick6PayoutsConfirmed) || (isPickem(set.platform) && !set.entries.length);
    const sidePayout = set.payouts ? (line: PropLine, side: PlayableDirection): SidePayout => {
      const payout = set.payouts!.get(line.id)?.[side] ?? { kind: 'ENTRY', multiplier: 1 };
      return unconfirmed && payout.kind === 'ENTRY' ? { ...payout, multiplier: null } : payout;
    } : undefined;
    const priced = priceBoard({ now, lines: set.lines, quotes: matched?.quotes ?? [], entries: set.entries, calibration,
      platform: set.platform, excludeBooks: own, ...(sidePayout ? { sidePayout } : {}),
      ...(this.statsAdjust ? { statsAdjust: this.statsAdjust } : {}),
      statsWeight: (sport, market) => this.honestyWeights.get(`${sport}:${market}`) ?? 1,
      ...(this.options.movement ? { lastMoveAt: (line: PropLine) => this.options.movement!.summary(line.sport, line.playerName, line.market, now.getTime())?.lastMoveAt ?? null } : {}),
      ...(this.options.alternateFactors ? { alternateFactors: this.options.alternateFactors } : {}),
      ...(this.options.alternateCurve ? { alternateCurve: this.options.alternateCurve } : {}),
      history: (player) => { const list = rows.get(playerKey(player.sport, player.playerName)); return list ? dedupeRows(list) : undefined; },
      values: (line) => values.found.get(`${line.sport}|${line.playerId}|${line.market}`),
      // Pick'em apps read each other's regular lines as weak anchors (step 3); sportsbook platforms have their books.
      ...(isPickem(set.platform) ? { anchors: (line: PropLine) => anchorsFor(anchors, line, set.platform) } : {}) });
    // Step 6: sports with no sportsbook prices and no free stats source say so plainly.
    const unpriced = priced.unpricedLines.map((item) => uncoveredSport(item.line)
      ? { ...item, reason: 'NO_DATA' as const, note: 'No read: no sportsbook prices or free stats source for this sport.' } : item);
    priced.unpricedLines.splice(0, priced.unpricedLines.length, ...unpriced);
    const picks = this.enrich(set, priced.picks, now, injured, alerts);
    const slips = buildSlips(picks, priced.entries, { minEvents: set.minEvents });
    const count = (tier: string) => priced.picks.filter((pick) => pick.tier === tier).length;
    const response: EdgeBoardResponse = {
      modelVersion: EDGE_MODEL_VERSION, builtAt: nowIso, boardFetchedAt: board.board.fetchedAt,
      referenceEntry: priced.referenceEntry, entries: priced.entries,
      counts: { linesPriced: priced.picks.length, linesUnpriced: priced.unpriced, sharp: count('SHARP'),
        market: count('MARKET'), model: count('MODEL'), ladder: count('LADDER'),
        positiveEdge: picks.filter((pick) => pick.edge !== null && pick.edge > 0 && pick.rating !== 'NONE').length,
        quotes: matched?.quotes.length ?? 0 },
      calibration: { status: calibration.global ? 'CALIBRATED' : 'UNCALIBRATED', graded: forecast.graded,
        brier: forecast.brier, hitRate: forecast.hitRate },
      picks, slips,
    };
    const byLine = new Map<string, EdgePick>();
    for (const pick of picks) {
      byLine.set(pick.lineId, pick);
      if (pick.oppositeLineId && !byLine.has(pick.oppositeLineId)) byLine.set(pick.oppositeLineId, pick);
    }
    // Every line counts once: a pick can stand for both sides' lines at one number.
    const readLines = new Set(priced.picks.flatMap((pick) => [pick.lineId, pick.oppositeLineId].filter((id): id is string => !!id)));
    const noReadByReason: Record<string, number> = {};
    for (const item of priced.unpricedLines) noReadByReason[item.reason] = (noReadByReason[item.reason] ?? 0) + 1;
    const report: EdgeReport = { platform: set.platform, lines: set.lines.length, read: readLines.size,
      noRead: priced.unpricedLines.length, noReadByReason, plusEv: response.counts.positiveEdge,
      edgeNull: priced.picks.filter((pick) => pick.edge === null).length,
      byTier: { SHARP: count('SHARP'), MARKET: count('MARKET'), MODEL: count('MODEL'), LADDER: count('LADDER') },
      byRating: Object.fromEntries((['ELITE', 'STRONG', 'VALUE', 'THIN'] as const).map((rating) =>
        [rating, picks.filter((pick) => pick.rating === rating).length])),
      stale: picks.filter((pick) => pick.stale).length, steam: picks.filter((pick) => pick.steam).length,
      injured: picks.filter((pick) => pick.injury).length,
      ...(set.sharpApi ? { sharpApi: set.sharpApi } : {}),
      ...(isBookPlatform(set.platform) ? { evShape: evShape(picks) } : {}),
      match: matched?.report ?? null, historyValues: { asked: values.asked, found: values.found.size } };
    return { platform: set.platform, response, byLine, unpriced: priced.unpricedLines, lines: new Map(set.lines.map((line) => [line.id, line])),
      computedAt: now.getTime(), durationMs: Date.now() - startedAt, report, minEvents: set.minEvents };
  }

  /**
   * Movement, injuries and ranking on top of the prices: a pick'em line the books moved past after the app last changed
   * it, toward the pick's side, is STALE (spec §3.2); OUT/DOUBTFUL players are never ranked (§3.3); every pick gets its
   * rank (§6) and picks are sorted by it; fresh STALE picks with a real edge raise an alert, one per player per hour (§8).
   */
  private enrich(set: PlatformSet, picks: readonly EdgePick[], now: Date, injured: ReadonlyMap<string, string>,
    alerts: EdgeAlert[]): EdgePick[] {
    const nowMs = now.getTime(), dfs = isPickem(set.platform);
    const staleWhy = { noMove: 0, againstTheLine: 0, sideNotOffered: 0, noAppHistory: 0, appChangedAfterMove: 0, gapUnderHalfSd: 0 };
    const out = picks.map((source) => {
      let pick: EdgePick = source;
      const photo = this.photos.get(normalizedName(pick.playerName));
      if (photo && !pick.playerImageUrl) pick = { ...pick, playerImageUrl: photo };
      const status = injured.get(normalizedName(pick.playerName));
      if (status) pick = { ...pick, injury: status, rating: 'NONE', edgeScore: 0,
        warnings: [...pick.warnings, `On the injury report: ${status}. Not ranked.`] };
      const moved = this.options.movement?.summary(pick.sport, pick.playerName, pick.market, nowMs);
      if (moved?.steam) pick = { ...pick, steam: true };
      // Step 7: every stale candidate (a book-priced pick'em line) is counted, with why it isn't stale when it isn't.
      if (dfs && pick.sources.market) {
        if (!moved) staleWhy.noMove++;
      }
      if (dfs && moved && pick.sources.market) {
        const appChanged = this.options.snapshots?.lastChange(set.platform, playerKey(pick.sport, pick.playerName), pick.market);
        const gap = pick.sources.market.mean - pick.threshold;
        const favored = moved.direction === 'UP' ? 'MORE' : 'LESS';
        const favors = (moved.direction === 'UP' && pick.side === 'MORE' && gap > 0) || (moved.direction === 'DOWN' && pick.side === 'LESS' && gap < 0);
        const offered = set.lines.find((line) => line.id === pick.lineId)?.availableDirections.includes(favored) ?? true;
        if (!offered) staleWhy.sideNotOffered++;
        else if (!favors) staleWhy.againstTheLine++;
        else if (appChanged === null || appChanged === undefined) staleWhy.noAppHistory++;
        else if (appChanged >= moved.lastMoveAt) staleWhy.appChangedAfterMove++;
        else if (Math.abs(gap) < .5 * pick.projection.sd) staleWhy.gapUnderHalfSd++;
        if (favors && appChanged !== null && appChanged !== undefined && appChanged < moved.lastMoveAt &&
          Math.abs(gap) >= .5 * pick.projection.sd) {
          const minutesAgo = Math.max(0, Math.round((nowMs - moved.lastMoveAt) / 60_000));
          const name = { prizepicks: 'PrizePicks', underdog: 'Underdog', pick6: 'Pick6', dabble: 'Dabble' }[set.platform as 'prizepicks'];
          pick = { ...pick, stale: { minutesAgo, books: moved.books, direction: moved.direction },
            reasons: [`Books moved ${moved.direction === 'UP' ? 'up' : 'down'} ${minutesAgo} min ago (${moved.books} book${moved.books === 1 ? '' : 's'}, first ${moved.firstMover}); ${name} hasn’t.`, ...pick.reasons] };
        }
      }
      const rank = rankScore(pick, { weakTiers: this.weakTiers,
        honesty: (sport, market) => this.options.honesty?.(sport, market) ?? .6 * (this.honestyWeights.get(`${sport}:${market}`) ?? 1) });
      return rank === null ? pick : { ...pick, rank };
    });
    out.sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1) || b.probability - a.probability);
    capGameKelly(out);
    if (dfs) console.log(`[edge-stale] ${set.platform}: ${out.filter((pick) => pick.stale).length} stale, ${out.filter((pick) => pick.steam).length} steam; ` +
      `candidates not stale ${JSON.stringify(staleWhy)}`);
    const events: StaleEvent[] = [];
    for (const pick of out) {
      if (!pick.stale || !pick.sources.market) continue;
      const id = `${set.platform}|${pick.key}|${pick.side}`;
      if (this.staleSeen.has(id)) continue;
      this.staleSeen.add(id);
      events.push({ at: now.toISOString(), platform: set.platform, key: pick.key, side: pick.side, playerName: pick.playerName,
        market: pick.market, number: pick.threshold, consensusMean: pick.sources.market.mean, probability: pick.probability,
        minutesAfterMove: pick.stale.minutesAgo, books: pick.stale.books, eventStartTime: pick.eventStartTime });
    }
    if (this.staleSeen.size > 100_000) this.staleSeen.clear();
    if (events.length && this.options.staleLogFile) {
      const file = this.options.staleLogFile;
      void mkdir(dirname(file), { recursive: true }).then(() => appendFile(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n'))
        .catch(() => undefined);
    }
    const minEdge = this.options.alertMinEdge ?? .04;
    for (const pick of out) {
      if (!pick.stale || pick.stale.minutesAgo > 30 || pick.edge === null || pick.edge < minEdge || pick.rating === 'NONE') continue;
      const player = `${set.platform}|${pick.playerId}`;
      if (nowMs - (this.lastAlertFor.get(player) ?? 0) < 3600_000) continue;
      this.lastAlertFor.set(player, nowMs);
      alerts.push({ id: `${pick.key}|${pick.side}|${nowMs}`, at: now.toISOString(), platform: set.platform, lineId: pick.lineId,
        playerName: pick.playerName, market: pick.market, threshold: pick.threshold, side: pick.side, probability: pick.probability,
        edge: pick.edge, ...(pick.ev !== undefined ? { ev: pick.ev } : {}), eventStartTime: pick.eventStartTime,
        text: pick.reasons[0] ?? 'Books moved; the app hasn’t.' });
    }
    return out;
  }

  /** STALE events from the last `days` days, each with Edge's view at the close and the result once graded. */
  async staleReplay(days = 7): Promise<{ events: (StaleEvent & { closeProbability: number | null; outcome: string | null })[];
    summary?: ReturnType<typeof staleSummary> }> {
    if (!this.options.staleLogFile) return { events: [], summary: staleSummary([]) };
    const cutoff = this.clock().getTime() - days * 86_400_000;
    let text = '';
    try { text = await readFile(this.options.staleLogFile, 'utf8'); } catch { return { events: [], summary: staleSummary([]) }; }
    const events = text.split('\n').filter(Boolean).flatMap((row) => { try { return [JSON.parse(row) as StaleEvent]; } catch { return []; } })
      .filter((event) => Date.parse(event.at) >= cutoff);
    const tracked = await this.options.ledger?.byIds(events.map((event) => `${event.platform}|${event.key}|${event.side}`)) ?? new Map();
    const replayed = events.map((event) => {
      const pick = tracked.get(`${event.platform}|${event.key}|${event.side}`);
      return { ...event, closeProbability: pick?.probability ?? null, outcome: pick?.outcome ?? null };
    });
    return { events: replayed, summary: staleSummary(replayed) };
  }

  /** Recent alerts, newest first, for games that haven't started. */
  alertList(platform: EdgePlatform | null, nowMs = this.clock().getTime()): EdgeAlert[] {
    return this.alerts.filter((alert) => (!platform || alert.platform === platform) && Date.parse(alert.eventStartTime) > nowMs);
  }

  private lastAudit = new Map<string, number>();
  /**
   * Hourly market audit per platform (2026-10-06): markets with no dedicated stat model (generic shape), and sizable markets in
   * a sport the books cover where no line got a sportsbook price (a likely name mismatch between the board and the books).
   */
  private audit(snapshot: EdgeSnapshot) {
    const now = Date.now();
    if (now - (this.lastAudit.get(snapshot.platform) ?? 0) < 3600_000) return;
    this.lastAudit.set(snapshot.platform, now);
    const groups = new Map<string, { lines: number; priced: number }>();
    for (const line of snapshot.lines.values()) {
      const key = `${line.sport}:${line.market}`, group = groups.get(key) ?? { lines: 0, priced: 0 };
      group.lines++; groups.set(key, group);
    }
    for (const pick of snapshot.response.picks) if (pick.sources.market) { const group = groups.get(`${pick.sport}:${pick.market}`); if (group) group.priced++; }
    const bookSports = new Set<string>(snapshot.response.picks.filter((pick) => pick.sources.market).map((pick) => pick.sport));
    const sorted = [...groups].filter(([key]) => !key.startsWith('OTHER:')).sort((a, b) => b[1].lines - a[1].lines);
    const generic = sorted.filter(([key]) => { const [sport, market] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]; return !profileKey(sport, market); })
      .slice(0, 15).map(([key, group]) => `${key}(${group.lines})`);
    const unpriced = sorted.filter(([key, group]) => group.lines >= 10 && group.priced === 0 && bookSports.has(key.slice(0, key.indexOf(':'))))
      .slice(0, 15).map(([key, group]) => `${key}(${group.lines})`);
    // League labels landing in OTHER (no sport mapping): period/live markets are expected; a sport's own label is a gap.
    const otherLeagues = new Map<string, number>();
    for (const line of snapshot.lines.values()) if (line.sport === 'OTHER') otherLeagues.set(line.league, (otherLeagues.get(line.league) ?? 0) + 1);
    const sports = new Map<string, number>();
    for (const line of snapshot.lines.values()) sports.set(line.sport, (sports.get(line.sport) ?? 0) + 1);
    console.log(`[edge-audit] ${snapshot.platform} sports ${JSON.stringify(Object.fromEntries(sports))} · OTHER leagues ${JSON.stringify(Object.fromEntries(otherLeagues))}`);
    const mismatches = snapshot.report.match?.mismatchSamples ?? [];
    if (mismatches.length) console.log(`[edge-audit] ${snapshot.platform} MARKET_MISMATCH samples: ${JSON.stringify(mismatches.slice(0, 8))}`);
    const byMarket = Object.entries(snapshot.report.match?.mismatchByMarket ?? {}).sort((a, b) => b[1].count - a[1].count).slice(0, 12);
    if (byMarket.length) console.log(`[edge-audit] ${snapshot.platform} MARKET_MISMATCH by market (board stat | book market): ${JSON.stringify(Object.fromEntries(byMarket))}`);
    console.log(`[edge-audit] ${snapshot.platform} generic model: ${generic.join(' ') || 'none'} | books cover the sport but none priced: ${unpriced.join(' ') || 'none'}`);
  }

  private log(snapshot: EdgeSnapshot) {
    this.audit(snapshot);
    const report = snapshot.report;
    console.log(`[edge] ${report.platform} ${report.lines} lines: ${report.read} read, ${report.noRead} no read ` +
      `${JSON.stringify(report.noReadByReason)}, ${report.plusEv} +EV ${JSON.stringify(report.byRating)}, ${report.stale} stale, ${report.steam} steam, ${report.injured} injured, ${report.edgeNull} edge null, tiers ${JSON.stringify(report.byTier)}, ` +
      `${report.sharpApi ? `sharpapi ${JSON.stringify(report.sharpApi)}, ` : ''}match ${report.match ? `${report.match.linesMatched}/${report.match.linesWithBookPrice} ` +
        `lines, ${report.match.matched} quotes, ${report.match.ambiguous} ambiguous, ${report.match.noEvent} no event, ` +
        `${report.match.mismatches} MARKET_MISMATCH` : 'none'}, history values ${report.historyValues.found}/${report.historyValues.asked}, ${snapshot.durationMs}ms`);
    if (report.evShape) console.log(`[edge-ev] ${report.platform} ${JSON.stringify(report.evShape)}`);
    if (report.platform === 'prizepicks' && report.match?.noEventSamples.length)
      console.log(`[edge-match] no game for: ${JSON.stringify(report.match.noEventSamples)}`);
  }
}

/**
 * Each pick gets the same player and stat on the other platforms (their numbers, Edge's chance for this side there and
 * their edge), so the user sees where the number is best ("Underdog 24.5 at 1.04× beats PrizePicks 25.5").
 */
export function crossPlatform(snapshots: readonly EdgeSnapshot[]): EdgeSnapshot[] {
  const key = (pick: EdgePick) => `${pick.sport}|${normalizedName(pick.playerName)}|${canonicalMarket(pick.sport, pick.market)}|${pick.side}`;
  const index = new Map<string, EdgePick[]>();
  for (const snapshot of snapshots) for (const pick of snapshot.response.picks) index.set(key(pick), [...index.get(key(pick)) ?? [], pick]);
  return snapshots.map((snapshot) => {
    const picks = snapshot.response.picks.map((pick) => {
      const others = (index.get(key(pick)) ?? []).filter((other) => other.platform !== pick.platform && other.eventStartTime.slice(0, 10) === pick.eventStartTime.slice(0, 10))
        .sort((a, b) => (b.edge ?? -9) - (a.edge ?? -9)).slice(0, 6)
        .map((other) => ({ platform: other.platform, lineId: other.lineId, threshold: other.threshold, side: other.side,
          probability: other.probability, edge: other.edge, ...(other.payoutMultiplier ? { payoutMultiplier: other.payoutMultiplier } : {}),
          ...(other.ev !== undefined ? { ev: other.ev } : {}) }));
      return others.length ? { ...pick, elsewhere: others } : pick;
    });
    const byLine = new Map<string, EdgePick>();
    for (const pick of picks) {
      byLine.set(pick.lineId, pick);
      if (pick.oppositeLineId && !byLine.has(pick.oppositeLineId)) byLine.set(pick.oppositeLineId, pick);
    }
    return { ...snapshot, response: { ...snapshot.response, picks }, byLine };
  });
}

/** The pick for a specific line, flipped to the opposite side when that line was asked for. */
export function pickForLine(snapshot: EdgeSnapshot, lineId: string): EdgePick | null {
  const pick = snapshot.byLine.get(lineId);
  if (!pick) return null;
  if (pick.lineId === lineId) return pick;
  const probability = pick.oppositeProbability;
  const edge = pick.edge === null ? null : Math.round((probability - pick.breakEven) * 1e4) / 1e4;
  return { ...pick, lineId, oppositeLineId: pick.lineId, side: pick.side === 'MORE' ? 'LESS' : 'MORE',
    probability, oppositeProbability: pick.probability, edge, rating: 'NONE', edgeScore: 0,
    requiredPayoutFactor: Math.round(pick.breakEven / Math.max(probability, 1e-4) * 1000) / 1000,
    reasons: [`Opposite side of the Edge pick ${pick.side} ${pick.threshold}.`], warnings: pick.warnings };
}

/**
 * Player search (Edge and GKR+ tabs): every line Edge read for a player whose name contains the text, plays or not, games not
 * yet started; the strongest edge first, then the likeliest side.
 */
export function searchPicks(snapshot: EdgeSnapshot, text: string, nowMs: number, limit: number): EdgePick[] {
  const wanted = normalizedName(text).replace(/[^a-z0-9 ]/g, '').trim();
  if (wanted.length < 2) return [];
  return [...snapshot.byLine.values()].filter((pick) => Date.parse(pick.eventStartTime) > nowMs + 5 * 60_000 &&
    normalizedName(pick.playerName).replace(/[^a-z0-9 ]/g, '').includes(wanted))
    .sort((a, b) => (b.edge ?? -1) - (a.edge ?? -1) || b.probability - a.probability).slice(0, limit);
}

export function viewPicks(snapshot: EdgeSnapshot, view: EdgeView, filters: { sport?: string; limit: number;
  minProbability?: number; market?: string; event?: string; nowMs: number }): EdgePick[] {
  const inView = (pick: EdgePick) => view === 'all' ? true
    : view === 'edges' ? pick.edge !== null && pick.rating !== 'NONE'
      : pick.edge === null; // alternates: Goblin/Demon lines with no confirmed payout factor, ranked by hit probability
  // Never show a pick that starts in under 5 minutes (spec §6).
  const picks = snapshot.response.picks.filter((pick) => Date.parse(pick.eventStartTime) > filters.nowMs + 5 * 60_000 &&
    inChoice(filters.sport, pick.sport) && inChoice(filters.market, pick.market) && inChoice(filters.event, pick.eventId) &&
    (filters.minProbability === undefined || pick.probability >= filters.minProbability) && inView(pick));
  if (view === 'alternates') picks.sort((a, b) => b.probability - a.probability);
  return picks.slice(0, filters.limit);
}

/**
 * Prices the member's own legs. `payouts` (hits → multiple) are the numbers the app showed for this exact ticket; they
 * replace the chart and already include any Goblin/Demon or pick multipliers, so no swap is suggested (a swap would change them).
 */
export function customSlip(snapshot: EdgeSnapshot, chart: EdgeEntry, lineIds: readonly string[], nowMs = Date.now(),
  payouts?: Readonly<Record<string, number>>): EdgeSlip | null {
  const legs = lineIds.map((id) => pickForLine(snapshot, id));
  if (legs.some((leg) => !leg)) return null;
  const entry = payouts ? ticketEntry(chart, payouts) : chart;
  const slip = evaluateSlip(entry, legs as EdgePick[], { minEvents: snapshot.minEvents, payoutsFinal: !!payouts });
  if (payouts) return slip;
  const suggestion = suggestSwap(entry, legs as EdgePick[], snapshot.response.picks, { minEvents: snapshot.minEvents, nowMs });
  return suggestion ? { ...slip, suggestion } : slip;
}

/** The chart entry with the ticket's own payouts in place of the chart's (only hit counts the entry can have). */
export function ticketEntry(chart: EdgeEntry, payouts: Readonly<Record<string, number>>): EdgeEntry {
  const table: Record<number, number> = {};
  for (const [hits, multiple] of Object.entries(payouts)) {
    const count = Number(hits);
    if (Number.isInteger(count) && count >= 0 && count <= chart.size && multiple > 0) table[count] = multiple;
  }
  return describeEntry({ type: chart.type, size: chart.size, payouts: table });
}

export type EdgeBoardFilter = 'all' | 'picks' | 'no_read';
export type EdgeBoardSort = 'start' | 'edge' | 'probability' | 'rank';

/** Every line on the board with Edge's read: priced picks (any rating) and the lines it could not read. */
export function boardPage(snapshot: EdgeSnapshot, query: { sport?: string; market?: string; event?: string; q?: string;
  filter: EdgeBoardFilter; sort: EdgeBoardSort; offset: number; limit: number; nowMs: number }): EdgeBoardPage {
  const text = query.q?.trim().toLowerCase();
  const keep = (item: { sport: string; market: string; eventId: string; playerName: string; eventStartTime: string }) =>
    Date.parse(item.eventStartTime) > query.nowMs && inChoice(query.sport, item.sport) &&
    inChoice(query.market, item.market) && inChoice(query.event, item.eventId) && (!text || item.playerName.toLowerCase().includes(text));
  const picks: EdgeBoardRow[] = query.filter === 'no_read' ? [] : snapshot.response.picks.filter(keep)
    .map((pick) => ({ kind: 'PICK' as const, pick }));
  const unread: EdgeBoardRow[] = query.filter === 'picks' ? [] : snapshot.unpriced
    .map(({ line, reason, note }) => ({ platform: snapshot.platform, lineId: line.id, sport: line.sport, league: line.league,
      eventId: line.eventId, eventName: line.eventName, eventStartTime: line.eventStartTime, playerId: line.playerId,
      playerName: line.playerName, market: line.market, threshold: line.threshold, lineType: line.lineType,
      availableDirections: [...line.availableDirections], reason, note }))
    .filter(keep).map((line) => ({ kind: 'NO_READ' as const, line }));
  const start = (row: EdgeBoardRow) => row.kind === 'PICK' ? row.pick.eventStartTime : row.line.eventStartTime;
  const name = (row: EdgeBoardRow) => row.kind === 'PICK' ? row.pick.playerName : row.line.playerName;
  const strength = (row: EdgeBoardRow) => row.kind === 'PICK'
    ? query.sort === 'probability' ? row.pick.probability : query.sort === 'rank' ? row.pick.rank ?? (row.pick.edge === null ? -1.5 : -1)
      : row.pick.ev ?? row.pick.edge ?? -1 : -2;
  const rows = [...picks, ...unread].sort(query.sort === 'start'
    ? (a, b) => start(a).localeCompare(start(b)) || name(a).localeCompare(name(b))
    : (a, b) => strength(b) - strength(a));
  const sports = [...new Set([...snapshot.response.picks.map((pick) => pick.sport),
    ...snapshot.unpriced.map((item) => item.line.sport)])].sort();
  const marketCounts = new Map<string, number>(), gameCounts = new Map<string, { eventId: string; eventName: string; sport: string; startTime: string; picks: number }>();
  for (const item of [...snapshot.response.picks, ...snapshot.unpriced.map(({ line }) => line)]) {
    if (Date.parse(item.eventStartTime) <= query.nowMs || !inChoice(query.sport, item.sport)) continue;
    const game = gameCounts.get(item.eventId) ?? { eventId: item.eventId, eventName: item.eventName, sport: item.sport, startTime: item.eventStartTime, picks: 0 };
    game.picks++; gameCounts.set(item.eventId, game);
    if (inChoice(query.event, item.eventId)) marketCounts.set(item.market, (marketCounts.get(item.market) ?? 0) + 1);
  }
  const games = [...gameCounts.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.eventName.localeCompare(b.eventName));
  const markets = [...marketCounts].map(([market, lines]) => ({ market, lines })).sort((a, b) => b.lines - a.lines || a.market.localeCompare(b.market));
  return { modelVersion: snapshot.response.modelVersion, builtAt: snapshot.response.builtAt,
    boardFetchedAt: snapshot.response.boardFetchedAt, total: rows.length, offset: query.offset, limit: query.limit,
    sports, markets, games, rows: rows.slice(query.offset, query.offset + query.limit) };
}

/** Grades Edge picks from ESPN / MLB box scores and CrownIQ's own game rows (no Odds API credits). */
export { freeGradedSports, freeHistoryActual } from '../free-history-grading.js';
export type { FreeHistoryValues } from '../free-history-grading.js';

export class EdgeResultsWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private last: { at: string; graded: number; waiting: number; unsupported: number; error: string | null } | null = null;
  constructor(private readonly ledger: EdgeLedger, private readonly history: InternalHistoryStore | null,
    private readonly boxScores: Pick<BoxScoreResults, 'results'> | null, private readonly clock: () => Date = () => new Date(),
    private readonly freeHistory: FreeHistoryValues | null = null, private readonly freeBudgetMs = 5 * 60_000,
    /** PropLine's graded props (pushed, else read back per game): the first and fastest source. */
    private readonly propline: { fetchGames(ids: readonly string[]): Promise<void>; actual(pick: TrackedEdgePick): Promise<number | null>;
      closing?(picks: readonly TrackedEdgePick[]): Promise<{ id: string; openingPoint?: number; closingPoint?: number; closingDecimal?: number }[]> } | null = null) {}

  status() { return { scheduled: !!this.timer, running: this.running, last: this.last }; }
  start(intervalMs = 60 * 60_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /**
   * PropLine first: picks on PropLine games graded from its settled props (pushed, else read back per game), from about 30
   * minutes after the start. Runs on its own every 10 minutes as well as at the top of each full run; light (no box scores).
   */
  async gradePropLine(): Promise<number> {
    if (!this.propline) return 0;
    const early = await this.ledger.awaitingResults(0.5);
    const games = early.flatMap((pick) => { const id = /propline:(\d+)/.exec(pick.eventId)?.[1]; return id ? [id] : []; });
    await this.propline.fetchGames(games).catch(() => undefined);
    const facts: EdgeResultFact[] = [];
    for (const pick of early) { const actual = await this.propline.actual(pick).catch(() => null);
      if (actual !== null) facts.push({ eventId: pick.eventId, playerId: pick.playerId, market: pick.market, status: 'FINAL', actual, sourceName: 'PropLine' }); }
    const done = facts.length ? (await this.ledger.grade(facts)).graded : 0;
    if (early.length) console.log(`[edge-grading] PropLine: ${early.length} awaiting, ${facts.length} results, ${done} graded`);
    // Closing lines (the platform's line at the start, and where it opened) for started picks, once each.
    if (this.propline.closing) {
      const started = await this.ledger.needingClose();
      if (started.length) {
        const closes = await this.propline.closing(started).catch(() => []);
        const found = await this.ledger.setClosing(closes);
        console.log(`[edge-grading] PropLine closing lines: ${started.length} started picks, ${closes.length} looked up, ${found} found`);
      }
    }
    return done;
  }

  /** Step 8: hourly, from 3 hours after each start until graded (box scores, CrownIQ's rows, the free histories). */
  private runningSince = 0;
  async runOnce() {
    // A run stuck past 30 minutes (a source that never answers) no longer blocks every later run.
    if (this.running && this.clock().getTime() - this.runningSince < 30 * 60_000) return this.last;
    this.running = true; this.runningSince = this.clock().getTime();
    const now = this.clock();
    let graded = 0, waiting = 0, unsupported = 0, error: string | null = null;
    try {
      graded += await this.gradePropLine();
      const awaiting = await this.ledger.awaitingResults(3);
      console.log(`[edge-grading] start: ${awaiting.length} awaiting`);
      if (this.boxScores && awaiting.length) {
        const report = await this.boxScores.results(awaiting.map(gradeTarget));
        graded += (await this.ledger.grade(report.facts)).graded;
        waiting = report.waiting; unsupported = report.unsupported;
        console.log(`[edge-grading] box scores: ${graded} graded, ${waiting} waiting, ${unsupported} unsupported`);
      }
      const left = (await this.ledger.awaitingResults(3)).filter((pick) => historySports.has(pick.sport));
      if (this.history && left.length) {
        const players = new Map(left.map((pick) => [playerKey(pick.sport, pick.playerName),
          { key: playerKey(pick.sport, pick.playerName), sport: pick.sport, playerId: pick.playerId, playerName: pick.playerName }]));
        const rows = await this.history.rowsForPlayers([...players.values()], 15);
        graded += (await this.ledger.gradeFromRows((pick: TrackedEdgePick) =>
          dedupeRows(rows.get(playerKey(pick.sport, pick.playerName)) ?? []))).graded;
        console.log(`[edge-grading] history rows: ${players.size} players, ${graded} graded so far`);
      }
      // Tennis and esports from the free public history sources (box scores don't cover them).
      const free = this.freeHistory ? (await this.ledger.awaitingResults(3)).filter((pick) => freeGradedSports.has(pick.sport)) : [];
      if (free.length) {
        const facts: EdgeResultFact[] = [];
        // A rate-limited source pauses up to a minute per lookup, so the step stops after its time budget and a sport whose
        // lookups keep stalling (3 slow misses) is left for the next run.
        const stepStart = this.clock().getTime(), slowMisses = new Map<string, number>(), skipped = new Set<string>();
        for (const pick of free.slice(0, 300)) {
          if (this.clock().getTime() - stepStart > this.freeBudgetMs) break;
          if (skipped.has(pick.sport)) continue;
          const lookupStart = this.clock().getTime();
          const found = await this.freeHistory!(pick.sport, pick.playerName, pick.market).catch(() => null);
          if (!found && this.clock().getTime() - lookupStart > 10_000) {
            const misses = (slowMisses.get(pick.sport) ?? 0) + 1; slowMisses.set(pick.sport, misses);
            if (misses >= 3) skipped.add(pick.sport);
          }
          const actual = found ? freeHistoryActual(pick, found) : null;
          if (actual !== null) facts.push({ eventId: pick.eventId, playerId: pick.playerId, market: pick.market, status: 'FINAL', actual,
            sourceName: found!.source });
        }
        graded += (await this.ledger.grade(facts)).graded;
        console.log(`[edge-grading] free histories: ${free.length} awaiting, ${facts.length} found` +
          `${skipped.size ? `, skipped ${[...skipped].join(' ')} (source stalling)` : ''}`);
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'EDGE_GRADING_FAILED';
    } finally {
      this.running = false;
      this.last = { at: now.toISOString(), graded, waiting, unsupported, error };
    }
    return this.last;
  }
}

type Metrics = { logScore: number; mae: number; brierAtMedian: number };
type Column = 'edge' | 'v2' | 'baseline';
export interface HistoryBacktestSummary {
  readonly players: number;
  readonly games: number;
  /** Per market: the current projection (hand-set dispersion), projection 2.0 (learned dispersion + learned back-to-back
   * effect) and the last-10-games baseline. `v2Best` is true when 2.0 has the best log score of the three. */
  readonly byMarket: Record<string, { players: number; games: number; edge: Metrics; v2: Metrics; baseline: Metrics; v2Best: boolean }>;
  readonly overall: { edge: Metrics; v2: Metrics; baseline: Metrics } | null;
  /** The spec §5 acceptance markets and whether 2.0 beats both on each (null = not enough history). */
  readonly acceptance: Record<string, boolean | null>;
}

const ACCEPTANCE_MARKETS = ['NBA:player_points', 'NBA:player_rebounds', 'NBA:player_assists', 'NFL:player_reception_yds',
  'NFL:player_receptions', 'NFL:player_rush_yds', 'NFL:passing_yards', 'MLB:batter_hits', 'MLB:pitcher_strikeouts'];

/**
 * Walk-forward check of Edge's stats projection on CrownIQ's game rows (spec §5 acceptance): each game is predicted only from
 * earlier games. The back-to-back effect is learned from the same rows (in-sample for the effect, out-of-sample for each
 * player's projection). The game-environment adjustment can't be replayed: history has no stored game lines.
 */
export function backtestHistory(rows: readonly InternalHistoryRow[], maxPlayers = 400): HistoryBacktestSummary {
  const byPlayer = new Map<string, InternalHistoryRow[]>();
  for (const row of rows) {
    const key = playerKey(row.sport, row.playerName);
    const list = byPlayer.get(key);
    if (list) list.push(row); else byPlayer.set(key, [row]);
  }
  const chosen = [...byPlayer].slice(0, maxPlayers).map(([key, list]) => ({ sport: key.split('|')[0]!, rows: dedupeRows(list) }))
    .filter((player) => player.rows.length >= 12);
  const effects = restEffects(chosen);
  const markets: Record<string, { players: number; games: number } & Record<Column, number[]>> = {};
  for (const { sport, rows: deduped } of chosen) {
    for (const key of Object.keys(marketProfiles).filter((item) => item.startsWith(sport + ':'))) {
      const market = key.slice(sport.length + 1), base = marketProfiles[key]!, learned = profileFor(sport, market);
      if (!base.stat) continue;
      const effect = effects.get(key);
      const rest = effect ? (target: StatRow, prior: readonly StatRow[]) => {
        const last = prior[prior.length - 1];
        return last && Date.parse(target.occurredAt) - Date.parse(last.occurredAt) < 30 * 3600_000 ? effect.coefficient : 1;
      } : undefined;
      const current = backtestProjection(deduped, base.stat, base, market);
      const v2 = backtestProjection(deduped, base.stat, learned, market, 8, rest);
      if (!current || !v2) continue;
      const bucket = markets[key] ??= { players: 0, games: 0, edge: [0, 0, 0], v2: [0, 0, 0], baseline: [0, 0, 0] };
      bucket.players++; bucket.games += current.games;
      const add = (target: number[], metrics: Metrics, games: number) => {
        target[0]! += metrics.logScore * games; target[1]! += metrics.mae * games; target[2]! += metrics.brierAtMedian * games;
      };
      add(bucket.edge, current.edge, current.games); add(bucket.v2, v2.edge, current.games); add(bucket.baseline, current.baseline, current.games);
    }
  }
  const metrics = (values: number[], games: number) => ({ logScore: values[0]! / games, mae: values[1]! / games,
    brierAtMedian: values[2]! / games });
  const byMarket = Object.fromEntries(Object.entries(markets).map(([key, value]) => {
    const edge = metrics(value.edge, value.games), v2 = metrics(value.v2, value.games), baseline = metrics(value.baseline, value.games);
    return [key, { players: value.players, games: value.games, edge, v2, baseline,
      v2Best: v2.logScore >= edge.logScore && v2.logScore > baseline.logScore }];
  }));
  const games = Object.values(markets).reduce((sum, value) => sum + value.games, 0);
  const total = (column: Column) => [0, 1, 2].map((index) => Object.values(markets).reduce((sum, value) => sum + value[column][index]!, 0));
  return { players: chosen.length, games, byMarket,
    overall: games ? { edge: metrics(total('edge'), games), v2: metrics(total('v2'), games), baseline: metrics(total('baseline'), games) } : null,
    acceptance: Object.fromEntries(ACCEPTANCE_MARKETS.map((key) => [key, byMarket[key] ? byMarket[key]!.v2Best : null])) };
}
