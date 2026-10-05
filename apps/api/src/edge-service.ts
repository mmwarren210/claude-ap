import type { BoardResponse, EdgeBoardPage, EdgeBoardResponse, EdgeBoardRow, EdgeEntry, EdgePick, EdgeSlip } from '@crowniq/contracts';
import { backtestProjection, buildSlips, defaultEntries, describeEntry, EDGE_MODEL_VERSION, evaluateSlip,
  fitCalibration, forecastReport, marketProfiles, normalizePlayerName, priceBoard, profileFor } from '@crowniq/edge';
import type { EntryDefinition, StatRow, UnpricedLine } from '@crowniq/edge';
import type { EdgeLedger, TrackedEdgePick } from './edge-ledger.js';
import type { InternalHistoryRow, InternalHistoryStore } from './internal-history.js';
import type { StatApiOwnerResearch, StatApiPlayer, StatApiSport } from './stat-api-owner-research.js';

export interface EdgeServiceOptions {
  readonly board: () => BoardResponse | null;
  readonly history?: InternalHistoryStore | null;
  readonly ledger?: EdgeLedger | null;
  readonly entries?: readonly EntryDefinition[];
  readonly alternateFactors?: Partial<Record<'GOBLIN' | 'DEMON', number>>;
  readonly clock?: () => Date;
  /** Reprice at least this often even without a new board (drops started events). */
  readonly ttlMs?: number;
}

export interface EdgeSnapshot {
  readonly response: EdgeBoardResponse;
  readonly byLine: ReadonlyMap<string, EdgePick>;
  /** Lines Edge could not read, kept so the Edge board still lists every line. */
  readonly unpriced: readonly UnpricedLine[];
  readonly computedAt: number;
  readonly durationMs: number;
}

export type EdgeView = 'edges' | 'alternates' | 'all';

const historySports = new Set(['NFL', 'NBA', 'MLB']);
const playerKey = (sport: string, name: string) => sport + '|' + normalizePlayerName(name);

/** A box score can arrive from several sources for the same game; keep one row per day,
 * preferring rows with full metrics over market-only graded rows. */
export function dedupeRows(rows: readonly InternalHistoryRow[]): StatRow[] {
  const byDay = new Map<string, InternalHistoryRow>();
  for (const row of rows) {
    const day = row.occurredAt.slice(0, 10), existing = byDay.get(day);
    if (!existing || (!Object.keys(existing.metrics).length && Object.keys(row.metrics).length)) byDay.set(day, row);
    else if (existing && Object.keys(row.marketValues).length) {
      byDay.set(day, { ...existing, marketValues: { ...row.marketValues, ...existing.marketValues } });
    }
  }
  return [...byDay.values()];
}

export class EdgeService {
  private current: EdgeSnapshot | null = null;
  private key: string | null = null;
  private pending: Promise<EdgeSnapshot | null> | null = null;
  private lastError: string | null = null;
  private readonly entries: readonly EntryDefinition[];
  private readonly clock: () => Date;

  constructor(private readonly options: EdgeServiceOptions) {
    this.entries = options.entries?.length ? options.entries : defaultEntries;
    this.clock = options.clock ?? (() => new Date());
  }

  status() {
    const response = this.current?.response;
    return { modelVersion: EDGE_MODEL_VERSION, computedAt: this.current ? new Date(this.current.computedAt).toISOString() : null,
      durationMs: this.current?.durationMs ?? null, counts: response?.counts ?? null,
      calibration: response?.calibration ?? null, lastError: this.lastError,
      entries: this.entries.map((entry) => describeEntry(entry)) };
  }

  async snapshot(): Promise<EdgeSnapshot | null> {
    const board = this.options.board();
    if (!board) return null;
    const key = board.board.fetchedAt + '|' + board.builtAt;
    const fresh = this.current && this.key === key &&
      this.clock().getTime() - this.current.computedAt < (this.options.ttlMs ?? 5 * 60_000);
    if (fresh) return this.current;
    if (this.pending) return this.pending;
    this.pending = this.compute(board, key).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async compute(board: BoardResponse, key: string): Promise<EdgeSnapshot | null> {
    const startedAt = Date.now();
    try {
      const now = this.clock();
      const players = new Map<string, { key: string; sport: string; playerId: string; playerName: string }>();
      for (const line of board.board.lines) {
        if (!historySports.has(line.sport) || !profileFor(line.sport, line.market).stat) continue;
        const id = playerKey(line.sport, line.playerName);
        if (!players.has(id)) players.set(id, { key: id, sport: line.sport, playerId: line.playerId, playerName: line.playerName });
      }
      const rows = this.options.history && players.size
        ? await this.options.history.rowsForPlayers([...players.values()], 60) : new Map<string, InternalHistoryRow[]>();
      const calibrationRows = await this.options.ledger?.calibrationRows().catch(() => []) ?? [];
      const calibration = fitCalibration(calibrationRows);
      const report = forecastReport(calibrationRows);
      const priced = priceBoard({ now, lines: board.board.lines, quotes: board.board.marketQuotes ?? [],
        entries: this.entries, calibration, alternateFactors: this.options.alternateFactors,
        history: (player) => { const list = rows.get(playerKey(player.sport, player.playerName)); return list ? dedupeRows(list) : undefined; } });
      const slips = buildSlips(priced.picks, priced.entries);
      const count = (tier: string) => priced.picks.filter((pick) => pick.tier === tier).length;
      const response: EdgeBoardResponse = {
        modelVersion: EDGE_MODEL_VERSION, builtAt: now.toISOString(), boardFetchedAt: board.board.fetchedAt,
        referenceEntry: priced.referenceEntry, entries: priced.entries,
        counts: { linesPriced: priced.picks.length, linesUnpriced: priced.unpriced, sharp: count('SHARP'),
          market: count('MARKET'), model: count('MODEL'), ladder: count('LADDER'),
          positiveEdge: priced.picks.filter((pick) => pick.edge !== null && pick.edge > 0).length,
          quotes: board.board.marketQuotes?.length ?? 0 },
        calibration: { status: calibration.global ? 'CALIBRATED' : 'UNCALIBRATED', graded: report.graded,
          brier: report.brier, hitRate: report.hitRate },
        picks: priced.picks, slips,
      };
      const byLine = new Map<string, EdgePick>();
      for (const pick of priced.picks) {
        byLine.set(pick.lineId, pick);
        if (pick.oppositeLineId && !byLine.has(pick.oppositeLineId)) byLine.set(pick.oppositeLineId, pick);
      }
      const snapshot = { response, byLine, unpriced: priced.unpricedLines, computedAt: now.getTime(),
        durationMs: Date.now() - startedAt };
      this.current = snapshot; this.key = key; this.lastError = null;
      void this.options.ledger?.record(priced.picks).catch(() => undefined);
      return snapshot;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'EDGE_PRICING_FAILED';
      console.error(JSON.stringify({ event: 'crowniq_edge_pricing_failed', error: this.lastError }));
      return this.current;
    }
  }
}

/** The pick for a specific line, flipping to the opposite side when that line was requested. */
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
      : pick.edge === null; // alternates: Goblin/Demon/unknown-payout lines, ranked by hit probability
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

const tableFor = (sport: string, market: string) => sport === 'MLB'
  ? market.startsWith('pitcher_') ? 'game_player_pitching_stats' : 'game_player_batter_stats' : 'game_player_stats';

/** Grades Edge picks from internal history and, when configured, fetches missing final box
 * scores from Stat API (capped per run). Uses no Odds API credits. */
export class EdgeResultsWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private last: { at: string; graded: number; fetchedPlayers: number; error: string | null } | null = null;
  constructor(private readonly ledger: EdgeLedger, private readonly history: InternalHistoryStore,
    private readonly source: Pick<StatApiOwnerResearch, 'search' | 'inspect'> | null,
    private readonly options: { maxPlayers?: number; clock?: () => Date } = {}) {}

  status() { return { scheduled: !!this.timer, running: this.running, statApi: !!this.source, last: this.last }; }
  start(intervalMs = 60 * 60_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private async gradeFromHistory(picks: readonly TrackedEdgePick[]) {
    if (!picks.length) return 0;
    const players = new Map(picks.map((pick) => [playerKey(pick.sport, pick.playerName),
      { key: playerKey(pick.sport, pick.playerName), sport: pick.sport, playerId: pick.playerId, playerName: pick.playerName }]));
    const rows = await this.history.rowsForPlayers([...players.values()], 15);
    return (await this.ledger.gradeFromRows((pick) => dedupeRows(rows.get(playerKey(pick.sport, pick.playerName)) ?? []))).graded;
  }

  async runOnce() {
    if (this.running) return this.last;
    this.running = true;
    const now = (this.options.clock ?? (() => new Date()))();
    let graded = 0, fetchedPlayers = 0, error: string | null = null;
    try {
      const supported = (pick: TrackedEdgePick) => historySports.has(pick.sport) && !!profileFor(pick.sport, pick.market).stat;
      graded += await this.gradeFromHistory((await this.ledger.awaitingResults(4)).filter(supported));
      if (this.source) {
        const remaining = (await this.ledger.awaitingResults(4)).filter((pick) => supported(pick) &&
          Date.parse(pick.eventStartTime) > now.getTime() - 4 * 86400_000);
        const groups = new Map<string, TrackedEdgePick[]>();
        for (const pick of remaining) {
          const key = playerKey(pick.sport, pick.playerName);
          groups.set(key, [...(groups.get(key) ?? []), pick]);
        }
        for (const picks of [...groups.values()].slice(0, this.options.maxPlayers ?? 40)) {
          const first = picks[0], sport = first.sport as StatApiSport;
          try {
            const found = await this.source.search(sport, first.playerName);
            const exact = found.players.filter((player: StatApiPlayer) =>
              normalizePlayerName(player.name) === normalizePlayerName(first.playerName));
            if (exact.length !== 1) continue;
            for (const table of new Set(picks.map((pick) => tableFor(pick.sport, pick.market)))) {
              const detail = await this.source.inspect(sport, exact[0].id, table);
              await this.history.recordStatDetail({ eventId: first.eventId, eventName: first.eventName,
                eventStartTime: first.eventStartTime, league: first.league, playerId: first.playerId,
                playerName: first.playerName, team: null, opponent: null, market: first.market,
                sport: first.sport as 'NFL' | 'NBA' | 'MLB' }, exact[0], detail);
            }
            fetchedPlayers++;
          } catch { /* one player's lookup failure must not stop the run */ }
        }
        graded += await this.gradeFromHistory((await this.ledger.awaitingResults(4)).filter(supported));
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'EDGE_GRADING_FAILED';
    } finally {
      this.running = false;
      this.last = { at: now.toISOString(), graded, fetchedPlayers, error };
    }
    return this.last;
  }
}

export interface HistoryBacktestSummary {
  readonly players: number;
  readonly games: number;
  readonly byMarket: Record<string, { players: number; games: number;
    edge: { logScore: number; mae: number; brierAtMedian: number };
    baseline: { logScore: number; mae: number; brierAtMedian: number } }>;
  readonly overall: { edge: { logScore: number; mae: number; brierAtMedian: number };
    baseline: { logScore: number; mae: number; brierAtMedian: number } } | null;
}

/** Walk-forward comparison of the Edge stats projection against the original GKR projection
 * (mean/SD of the last 10 games) on every player-market in internal history. */
export function backtestHistory(rows: readonly InternalHistoryRow[], maxPlayers = 400): HistoryBacktestSummary {
  const byPlayer = new Map<string, InternalHistoryRow[]>();
  for (const row of rows) {
    const key = playerKey(row.sport, row.playerName);
    byPlayer.set(key, [...(byPlayer.get(key) ?? []), row]);
  }
  const markets: Record<string, { players: number; games: number; edge: number[]; baseline: number[] }> = {};
  let players = 0;
  for (const [key, list] of [...byPlayer].slice(0, maxPlayers)) {
    const sport = key.split('|')[0], deduped = dedupeRows(list);
    if (deduped.length < 12) continue;
    players++;
    for (const market of Object.keys(marketProfilesFor(sport))) {
      const profile = profileFor(sport, market);
      if (!profile.stat) continue;
      const result = backtestProjection(deduped, profile.stat, profile, market);
      if (!result) continue;
      const bucket = markets[sport + ':' + market] ??= { players: 0, games: 0, edge: [0, 0, 0], baseline: [0, 0, 0] };
      bucket.players++; bucket.games += result.games;
      const add = (target: number[], metrics: { logScore: number; mae: number; brierAtMedian: number }) => {
        target[0] += metrics.logScore * result.games; target[1] += metrics.mae * result.games;
        target[2] += metrics.brierAtMedian * result.games;
      };
      add(bucket.edge, result.edge); add(bucket.baseline, result.baseline);
    }
  }
  const metrics = (values: number[], games: number) => ({ logScore: values[0] / games, mae: values[1] / games,
    brierAtMedian: values[2] / games });
  const byMarket = Object.fromEntries(Object.entries(markets).map(([key, value]) => [key, {
    players: value.players, games: value.games, edge: metrics(value.edge, value.games),
    baseline: metrics(value.baseline, value.games) }]));
  const games = Object.values(markets).reduce((sum, value) => sum + value.games, 0);
  const sum = (pick: 'edge' | 'baseline') => Object.values(markets).reduce((total, value) =>
    total.map((item, index) => item + value[pick][index]), [0, 0, 0]);
  return { players, games, byMarket,
    overall: games ? { edge: metrics(sum('edge'), games), baseline: metrics(sum('baseline'), games) } : null };
}

function marketProfilesFor(sport: string): Record<string, true> {
  return Object.fromEntries(Object.keys(marketProfiles).filter((key) => key.startsWith(sport + ':'))
    .map((key) => [key.slice(sport.length + 1), true as const]));
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
    .map(({ line, reason, note }) => ({ lineId: line.id, sport: line.sport, league: line.league, eventId: line.eventId,
      eventName: line.eventName, eventStartTime: line.eventStartTime, playerId: line.playerId, playerName: line.playerName,
      market: line.market, threshold: line.threshold, lineType: line.lineType,
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
