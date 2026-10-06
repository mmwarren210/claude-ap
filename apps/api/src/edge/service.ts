import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BoardResponse, EdgeBoardPage, EdgeBoardResponse, EdgeBoardRow, EdgeEntry, EdgePick, EdgeSlip, Payouts,
  PropLine } from '@crowniq/contracts';
import { backtestProjection, buildSlips, describeEntry, EDGE_MODEL_VERSION, entriesFromTables, evaluateSlip, fitCalibration,
  forecastReport, marketProfiles, priceBoard, profileFor } from '@crowniq/edge';
import type { EntryDefinition, StatRow, UnpricedLine } from '@crowniq/edge';
import type { BoxScoreResults } from '../box-score-results.js';
import type { FairPrice, PickemLine } from '../context/sharp-props.js';
import { normalizedName } from '../context/match.js';
import type { InternalHistoryRow, InternalHistoryStore } from '../internal-history.js';
import { leagueLabel } from '../scrapers/markets.js';
import type { EdgeLedger, TrackedEdgePick } from './ledger.js';
import { gradeTarget } from './ledger.js';
import { canonicalMarket, matchBookPrices, playerKey } from './market-map.js';
import type { MatchReport } from './market-map.js';

// CrownIQ Edge on PrizePicks (Edge 2.0, P1). A standalone engine: it reads every PrizePicks line itself (the scraped
// board, plus any line SharpAPI lists that the scrapers missed), prices each from the sportsbooks' SharpAPI prices
// (PrizePicks itself never counts: a platform never confirms its own price), CrownIQ's game rows and the same History
// values every tab uses, and returns a read or a "No read" with the exact missing input for every line. It never reads
// GKR output and is never compared with GKR.

export interface EdgeServiceOptions {
  readonly board: () => BoardResponse | null;
  /** SharpAPI's latest book prices and PrizePicks lines. */
  readonly sharp?: { prices(): Promise<readonly FairPrice[]>; pickem(): Promise<readonly PickemLine[]> } | null;
  readonly history?: InternalHistoryStore | null;
  /** A player's recent values for a line's stat (the shared History values), newest first. */
  readonly values?: ((line: PropLine) => Promise<{ values: number[] } | null>) | null;
  readonly ledger?: EdgeLedger | null;
  readonly payouts: Payouts;
  readonly alternateFactors?: Partial<Record<'GOBLIN' | 'DEMON', number>>;
  readonly clock?: () => Date;
  /** Reprice at least this often (drops started games, picks up new prices and history). */
  readonly ttlMs?: number;
  /** How long one pricing pass may spend gathering History values (the rest arrive on the next pass, cached). */
  readonly valuesBudgetMs?: number;
  /** Where the History values cache is kept, so a restart doesn't start Edge with no history. */
  readonly valuesCacheFile?: string | null;
}

export interface EdgeSnapshot {
  readonly response: EdgeBoardResponse;
  readonly byLine: ReadonlyMap<string, EdgePick>;
  /** Lines Edge could not read, kept so the Edge board lists every line. */
  readonly unpriced: readonly UnpricedLine[];
  readonly lines: ReadonlyMap<string, PropLine>;
  readonly computedAt: number;
  readonly durationMs: number;
  readonly report: EdgeReport;
}

/** What one pricing pass saw, for the phase reports and owner diagnostics. */
export interface EdgeReport {
  readonly platform: 'prizepicks';
  readonly lines: number; readonly read: number; readonly noRead: number;
  readonly noReadByReason: Readonly<Record<string, number>>;
  readonly plusEv: number;
  /** Goblin/Demon reads left with edge = null (no confirmed payout factor). */
  readonly edgeNull: number;
  readonly byTier: Readonly<Record<string, number>>;
  readonly sharpApi: { readonly lines: number; readonly confirmed: number; readonly added: number };
  readonly match: MatchReport | null;
  readonly historyValues: { readonly asked: number; readonly found: number };
}

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

export class EdgeService {
  private current: EdgeSnapshot | null = null;
  private key: string | null = null;
  private pending: Promise<EdgeSnapshot | null> | null = null;
  private lastError: string | null = null;
  private readonly entries: readonly EntryDefinition[];
  private readonly clock: () => Date;

  constructor(private readonly options: EdgeServiceOptions) {
    this.entries = entriesFromTables(options.payouts.prizepicks);
    this.clock = options.clock ?? (() => new Date());
    if (options.valuesCacheFile) {
      try {
        const saved = JSON.parse(readFileSync(options.valuesCacheFile, 'utf8')) as [string, { until: number; values: number[] | null }][];
        const nowMs = Date.now();
        for (const [key, value] of saved) if (value.until > nowMs) this.valuesCache.set(key, value);
      } catch { /* first run */ }
    }
  }

  status() {
    const response = this.current?.response;
    return { modelVersion: EDGE_MODEL_VERSION, computedAt: this.current ? new Date(this.current.computedAt).toISOString() : null,
      durationMs: this.current?.durationMs ?? null, counts: response?.counts ?? null, report: this.current?.report ?? null,
      calibration: response?.calibration ?? null, lastError: this.lastError,
      alternateFactors: this.options.alternateFactors ?? {}, entries: this.entries.map((entry) => describeEntry(entry)) };
  }

  /** The latest pricing, recomputed when the board changes or the last pass is older than the TTL. */
  async snapshot(): Promise<EdgeSnapshot | null> {
    const board = this.options.board();
    if (!board) return null;
    const key = `${board.board.fetchedAt}|${board.builtAt}`;
    const fresh = this.current && this.key === key &&
      this.clock().getTime() - this.current.computedAt < (this.options.ttlMs ?? 5 * 60_000);
    if (fresh) return this.current;
    if (this.pending) return this.current ?? this.pending;
    this.pending = this.compute(board, key).finally(() => { this.pending = null; });
    return this.current ?? this.pending;
  }

  /** History values Edge already looked up: kept 6 hours when found and 1 hour when not, so each pass only looks up
   * players it hasn't seen (coverage builds up across passes instead of restarting every 10 minutes). */
  private readonly valuesCache = new Map<string, { until: number; values: number[] | null }>();

  private async gatherValues(lines: readonly PropLine[]) {
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
    const deadline = nowMs + (this.options.valuesBudgetMs ?? 45_000);
    const worker = async () => {
      for (let item = queue.shift(); item && Date.now() < deadline; item = queue.shift()) {
        const result = await this.options.values!(item[1]).catch(() => undefined);
        if (result === undefined) continue; // a failed lookup is retried next pass
        const values = result?.values.length ? result.values : null;
        this.valuesCache.set(item[0], { until: Date.now() + (values ? 6 : 1) * 3600_000, values });
        if (values) found.set(item[0], values);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (this.valuesCache.size > 50_000) for (const [key, value] of this.valuesCache) if (value.until <= nowMs) this.valuesCache.delete(key);
    if (this.options.valuesCacheFile) {
      const file = this.options.valuesCacheFile, temporary = `${file}.tmp`;
      await mkdir(dirname(file), { recursive: true }).then(() => writeFile(temporary, JSON.stringify([...this.valuesCache])))
        .then(() => rename(temporary, file)).catch(() => undefined);
    }
    return { found, asked: groups.size };
  }

  private async compute(board: BoardResponse, key: string): Promise<EdgeSnapshot | null> {
    const startedAt = Date.now();
    try {
      const now = this.clock(), nowIso = now.toISOString();
      const open = board.board.lines.filter((line) => Date.parse(line.eventStartTime) > now.getTime());
      const [prices, pickem] = this.options.sharp
        ? await Promise.all([this.options.sharp.prices(), this.options.sharp.pickem()]) : [[], []];
      const extra = sharpPrizePicksLines(open, pickem, nowIso);
      const lines = [...open, ...extra.added.filter((line) => Date.parse(line.eventStartTime) > now.getTime())];
      // PrizePicks never counts toward its own fair price (leave-one-out).
      const matched = prices.length ? matchBookPrices(lines, prices, nowIso, ['prizepicks', 'prizepicks_flex']) : null;
      const players = new Map<string, { key: string; sport: string; playerId: string; playerName: string }>();
      for (const line of lines) {
        if (!historySports.has(line.sport) || !profileFor(line.sport, line.market).stat) continue;
        const id = playerKey(line.sport, line.playerName);
        if (!players.has(id)) players.set(id, { key: id, sport: line.sport, playerId: line.playerId, playerName: line.playerName });
      }
      const [rows, values] = await Promise.all([
        this.options.history && players.size ? this.options.history.rowsForPlayers([...players.values()], 60)
          : Promise.resolve(new Map<string, InternalHistoryRow[]>()),
        this.gatherValues(lines)]);
      const calibrationRows = await this.options.ledger?.calibrationRows().catch(() => []) ?? [];
      const calibration = fitCalibration(calibrationRows);
      const forecast = forecastReport(calibrationRows);
      const priced = priceBoard({ now, lines, quotes: matched?.quotes ?? [], entries: this.entries, calibration,
        platform: 'prizepicks', excludeBooks: ['prizepicks', 'prizepicks_flex'],
        ...(this.options.alternateFactors ? { alternateFactors: this.options.alternateFactors } : {}),
        history: (player) => { const list = rows.get(playerKey(player.sport, player.playerName)); return list ? dedupeRows(list) : undefined; },
        values: (line) => values.found.get(`${line.sport}|${line.playerId}|${line.market}`) });
      const slips = buildSlips(priced.picks, priced.entries);
      const count = (tier: string) => priced.picks.filter((pick) => pick.tier === tier).length;
      const response: EdgeBoardResponse = {
        modelVersion: EDGE_MODEL_VERSION, builtAt: nowIso, boardFetchedAt: board.board.fetchedAt,
        referenceEntry: priced.referenceEntry, entries: priced.entries,
        counts: { linesPriced: priced.picks.length, linesUnpriced: priced.unpriced, sharp: count('SHARP'),
          market: count('MARKET'), model: count('MODEL'), ladder: count('LADDER'),
          positiveEdge: priced.picks.filter((pick) => pick.edge !== null && pick.edge > 0).length,
          quotes: matched?.quotes.length ?? 0 },
        calibration: { status: calibration.global ? 'CALIBRATED' : 'UNCALIBRATED', graded: forecast.graded,
          brier: forecast.brier, hitRate: forecast.hitRate },
        picks: priced.picks, slips,
      };
      const byLine = new Map<string, EdgePick>();
      for (const pick of priced.picks) {
        byLine.set(pick.lineId, pick);
        if (pick.oppositeLineId && !byLine.has(pick.oppositeLineId)) byLine.set(pick.oppositeLineId, pick);
      }
      const lineMap = new Map(lines.map((line) => [line.id, line]));
      // Every line counts once: a pick can stand for both sides' lines at one number.
      const readLines = new Set(priced.picks.flatMap((pick) => [pick.lineId, pick.oppositeLineId].filter((id): id is string => !!id)));
      const noReadByReason: Record<string, number> = {};
      for (const item of priced.unpricedLines) noReadByReason[item.reason] = (noReadByReason[item.reason] ?? 0) + 1;
      const report: EdgeReport = { platform: 'prizepicks', lines: lines.length, read: readLines.size,
        noRead: priced.unpricedLines.length, noReadByReason,
        plusEv: priced.picks.filter((pick) => pick.edge !== null && pick.edge > 0).length,
        edgeNull: priced.picks.filter((pick) => pick.edge === null).length,
        byTier: { SHARP: count('SHARP'), MARKET: count('MARKET'), MODEL: count('MODEL'), LADDER: count('LADDER') },
        sharpApi: { lines: extra.total, confirmed: extra.confirmed, added: extra.added.length },
        match: matched?.report ?? null, historyValues: { asked: values.asked, found: values.found.size } };
      const snapshot: EdgeSnapshot = { response, byLine, unpriced: priced.unpricedLines, lines: lineMap,
        computedAt: now.getTime(), durationMs: Date.now() - startedAt, report };
      this.current = snapshot; this.key = key; this.lastError = null;
      console.log(`[edge] prizepicks ${report.lines} lines: ${report.read} read, ${report.noRead} no read ` +
        `${JSON.stringify(report.noReadByReason)}, ${report.plusEv} +EV, ${report.edgeNull} edge null, tiers ${JSON.stringify(report.byTier)}, ` +
        `sharpapi ${JSON.stringify(report.sharpApi)}, match ${report.match ? `${report.match.linesMatched}/${report.match.linesWithBookPrice} ` +
          `lines, ${report.match.matched} quotes, ${report.match.ambiguous} ambiguous, ${report.match.noEvent} no event, ` +
          `${report.match.mismatches} MARKET_MISMATCH` : 'none'}, history values ${values.found.size}/${values.asked}, ${snapshot.durationMs}ms`);
      if (report.match?.noEventSamples.length) console.log(`[edge-match] no game for: ${JSON.stringify(report.match.noEventSamples)}`);
      void this.options.ledger?.record(priced.picks, (lineId) => {
        const line = lineMap.get(lineId);
        return { team: line?.team ?? null, home: line?.homeTeam ?? null, away: line?.awayTeam ?? null };
      }).catch(() => undefined);
      return snapshot;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'EDGE_PRICING_FAILED';
      console.error(JSON.stringify({ event: 'crowniq_edge_pricing_failed', error: this.lastError }));
      return this.current;
    }
  }
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

export function viewPicks(snapshot: EdgeSnapshot, view: EdgeView, filters: { sport?: string; limit: number;
  minProbability?: number; market?: string; nowMs: number }): EdgePick[] {
  const inView = (pick: EdgePick) => view === 'all' ? true
    : view === 'edges' ? pick.edge !== null && pick.rating !== 'NONE'
      : pick.edge === null; // alternates: Goblin/Demon lines with no confirmed payout factor, ranked by hit probability
  const picks = snapshot.response.picks.filter((pick) => Date.parse(pick.eventStartTime) > filters.nowMs &&
    (!filters.sport || pick.sport === filters.sport) && (!filters.market || pick.market === filters.market) &&
    (filters.minProbability === undefined || pick.probability >= filters.minProbability) && inView(pick));
  if (view === 'alternates') picks.sort((a, b) => b.probability - a.probability);
  return picks.slice(0, filters.limit);
}

export function customSlip(snapshot: EdgeSnapshot, entry: EdgeEntry, lineIds: readonly string[]): EdgeSlip | null {
  const legs = lineIds.map((id) => pickForLine(snapshot, id));
  if (legs.some((leg) => !leg)) return null;
  return evaluateSlip(entry, legs as EdgePick[]);
}

export type EdgeBoardFilter = 'all' | 'picks' | 'no_read';
export type EdgeBoardSort = 'start' | 'edge' | 'probability';

/** Every line on the board with Edge's read: priced picks (any rating) and the lines it could not read. */
export function boardPage(snapshot: EdgeSnapshot, query: { sport?: string; market?: string; q?: string;
  filter: EdgeBoardFilter; sort: EdgeBoardSort; offset: number; limit: number; nowMs: number }): EdgeBoardPage {
  const text = query.q?.trim().toLowerCase();
  const keep = (item: { sport: string; market: string; playerName: string; eventStartTime: string }) =>
    Date.parse(item.eventStartTime) > query.nowMs && (!query.sport || item.sport === query.sport) &&
    (!query.market || item.market === query.market) && (!text || item.playerName.toLowerCase().includes(text));
  const picks: EdgeBoardRow[] = query.filter === 'no_read' ? [] : snapshot.response.picks.filter(keep)
    .map((pick) => ({ kind: 'PICK' as const, pick }));
  const unread: EdgeBoardRow[] = query.filter === 'picks' ? [] : snapshot.unpriced
    .map(({ line, reason, note }) => ({ platform: 'prizepicks' as const, lineId: line.id, sport: line.sport, league: line.league,
      eventId: line.eventId, eventName: line.eventName, eventStartTime: line.eventStartTime, playerId: line.playerId,
      playerName: line.playerName, market: line.market, threshold: line.threshold, lineType: line.lineType,
      availableDirections: [...line.availableDirections], reason, note }))
    .filter(keep).map((line) => ({ kind: 'NO_READ' as const, line }));
  const start = (row: EdgeBoardRow) => row.kind === 'PICK' ? row.pick.eventStartTime : row.line.eventStartTime;
  const name = (row: EdgeBoardRow) => row.kind === 'PICK' ? row.pick.playerName : row.line.playerName;
  const strength = (row: EdgeBoardRow) => row.kind === 'PICK'
    ? query.sort === 'probability' ? row.pick.probability : row.pick.edge ?? -1 : -2;
  const rows = [...picks, ...unread].sort(query.sort === 'start'
    ? (a, b) => start(a).localeCompare(start(b)) || name(a).localeCompare(name(b))
    : (a, b) => strength(b) - strength(a));
  const sports = [...new Set([...snapshot.response.picks.map((pick) => pick.sport),
    ...snapshot.unpriced.map((item) => item.line.sport)])].sort();
  return { modelVersion: snapshot.response.modelVersion, builtAt: snapshot.response.builtAt,
    boardFetchedAt: snapshot.response.boardFetchedAt, total: rows.length, offset: query.offset, limit: query.limit,
    sports, rows: rows.slice(query.offset, query.offset + query.limit) };
}

/** Grades Edge picks from ESPN / MLB box scores and CrownIQ's own game rows (no Odds API credits). */
export class EdgeResultsWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private last: { at: string; graded: number; waiting: number; unsupported: number; error: string | null } | null = null;
  constructor(private readonly ledger: EdgeLedger, private readonly history: InternalHistoryStore | null,
    private readonly boxScores: Pick<BoxScoreResults, 'results'> | null, private readonly clock: () => Date = () => new Date()) {}

  status() { return { scheduled: !!this.timer, running: this.running, last: this.last }; }
  start(intervalMs = 60 * 60_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async runOnce() {
    if (this.running) return this.last;
    this.running = true;
    const now = this.clock();
    let graded = 0, waiting = 0, unsupported = 0, error: string | null = null;
    try {
      const awaiting = await this.ledger.awaitingResults(4);
      if (this.boxScores && awaiting.length) {
        const report = await this.boxScores.results(awaiting.map(gradeTarget));
        graded += (await this.ledger.grade(report.facts)).graded;
        waiting = report.waiting; unsupported = report.unsupported;
      }
      const left = (await this.ledger.awaitingResults(4)).filter((pick) => historySports.has(pick.sport));
      if (this.history && left.length) {
        const players = new Map(left.map((pick) => [playerKey(pick.sport, pick.playerName),
          { key: playerKey(pick.sport, pick.playerName), sport: pick.sport, playerId: pick.playerId, playerName: pick.playerName }]));
        const rows = await this.history.rowsForPlayers([...players.values()], 15);
        graded += (await this.ledger.gradeFromRows((pick: TrackedEdgePick) =>
          dedupeRows(rows.get(playerKey(pick.sport, pick.playerName)) ?? []))).graded;
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
export interface HistoryBacktestSummary {
  readonly players: number;
  readonly games: number;
  readonly byMarket: Record<string, { players: number; games: number; edge: Metrics; baseline: Metrics }>;
  readonly overall: { edge: Metrics; baseline: Metrics } | null;
}

/** Walk-forward check of Edge's stats projection against the last-10-games baseline on CrownIQ's game rows. */
export function backtestHistory(rows: readonly InternalHistoryRow[], maxPlayers = 400): HistoryBacktestSummary {
  const byPlayer = new Map<string, InternalHistoryRow[]>();
  for (const row of rows) {
    const key = playerKey(row.sport, row.playerName);
    byPlayer.set(key, [...(byPlayer.get(key) ?? []), row]);
  }
  const markets: Record<string, { players: number; games: number; edge: number[]; baseline: number[] }> = {};
  let players = 0;
  for (const [key, list] of [...byPlayer].slice(0, maxPlayers)) {
    const sport = key.split('|')[0]!, deduped = dedupeRows(list);
    if (deduped.length < 12) continue;
    players++;
    for (const market of Object.keys(marketProfiles).filter((item) => item.startsWith(sport + ':')).map((item) => item.slice(sport.length + 1))) {
      const profile = profileFor(sport, market);
      if (!profile.stat) continue;
      const result = backtestProjection(deduped, profile.stat, profile, market);
      if (!result) continue;
      const bucket = markets[sport + ':' + market] ??= { players: 0, games: 0, edge: [0, 0, 0], baseline: [0, 0, 0] };
      bucket.players++; bucket.games += result.games;
      const add = (target: number[], metrics: Metrics) => {
        target[0]! += metrics.logScore * result.games; target[1]! += metrics.mae * result.games;
        target[2]! += metrics.brierAtMedian * result.games;
      };
      add(bucket.edge, result.edge); add(bucket.baseline, result.baseline);
    }
  }
  const metrics = (values: number[], games: number) => ({ logScore: values[0]! / games, mae: values[1]! / games,
    brierAtMedian: values[2]! / games });
  const byMarket = Object.fromEntries(Object.entries(markets).map(([key, value]) => [key, {
    players: value.players, games: value.games, edge: metrics(value.edge, value.games),
    baseline: metrics(value.baseline, value.games) }]));
  const games = Object.values(markets).reduce((sum, value) => sum + value.games, 0);
  const sum = (pick: 'edge' | 'baseline') => Object.values(markets).reduce((total, value) =>
    total.map((item, index) => item + value[pick][index]!), [0, 0, 0]);
  return { players, games, byMarket,
    overall: games ? { edge: metrics(sum('edge'), games), baseline: metrics(sum('baseline'), games) } : null };
}
