import type { FastifyInstance, FastifyRequest } from 'fastify';
import { backedLeg, buildSlips, EDGE_MODEL_VERSION, generateEntries, isAlternate } from '@crowniq/edge';
import { z } from 'zod';
import type { EdgePick, EdgePlatform } from '@crowniq/contracts';
import { cdf, makeDistribution } from '@crowniq/edge';
import { canonicalMarket, playerKey } from './market-map.js';
import type { InternalHistoryStore } from '../internal-history.js';
import type { EdgeLedger } from './ledger.js';
import { backtestHistory, boardPage, customSlip, EDGE_PLATFORMS, pickForLine, viewPicks } from './service.js';
import type { EdgeResultsWorker, EdgeService } from './service.js';
import type { SnapshotStore } from './snapshots.js';

// The /v1/edge routes (ported from claude/edge-engine). Every /v1 route already needs a signed-in profile; owner routes
// answer 404 to anyone else.

export interface EdgeRouteDeps {
  readonly edge: EdgeService;
  readonly ledger: EdgeLedger | null;
  readonly worker: EdgeResultsWorker | null;
  readonly snapshots: SnapshotStore | null;
  readonly internalHistory: InternalHistoryStore | null;
  readonly isOwner: (request: FastifyRequest) => Promise<boolean>;
  readonly now: () => Date;
  /** Source freshness and spend for the owner health page (spec §10). */
  readonly health?: () => Promise<Record<string, unknown>>;
  /** Platforms whose ranked picks and entries are held (a new feed not yet cleared by the side-bias check). */
  readonly held?: (platform: string) => boolean;
}

/** A time's calendar date in Eastern time ("today" for the slate). */
export const easternDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);

const platformSchema = z.enum(EDGE_PLATFORMS as [EdgePlatform, ...EdgePlatform[]]).default('prizepicks');

/** The fair distribution around the line (spec §8 line detail): P(stat = x) for whole numbers, or density bins for normal stats. */
export function distributionPoints(pick: EdgePick): { x: number; p: number }[] {
  const { family, mean, sd } = pick.projection;
  const dist = makeDistribution(family, mean, sd * sd, family !== 'NORMAL');
  const low = Math.max(0, Math.floor(mean - 3 * sd)), high = Math.ceil(mean + 3 * sd), step = Math.max(1, Math.ceil((high - low) / 40));
  const out: { x: number; p: number }[] = [];
  for (let x = low; x <= high; x += step) {
    const p = family === 'NORMAL' ? cdf({ ...dist, discrete: false }, x + step) - cdf({ ...dist, discrete: false }, x) : cdf(dist, x + step - 1) - cdf(dist, x - 1);
    out.push({ x, p: Math.round(p * 10_000) / 10_000 });
  }
  return out;
}

/** Each platform's number for this player and stat over the last 24 hours (the movement sparkline), from the snapshot store. */
export function lineMovement(snapshots: Pick<SnapshotStore, 'playerHistory'>, pick: EdgePick, nowMs: number) {
  const market = canonicalMarket(pick.sport, pick.market), byPlatform = new Map<string, { t: string; number: number }[]>();
  for (const row of snapshots.playerHistory(playerKey(pick.sport, pick.playerName), new Date(nowMs - 86_400_000).toISOString())) {
    if (row.number === null || row.side !== 'MORE' || canonicalMarket(pick.sport, row.market) !== market) continue;
    if (row.lineType && !/^(regular|standard)$/i.test(row.lineType)) continue;
    const list = byPlatform.get(row.platform) ?? [];
    // Books post ladders: keep the number nearest the pick's for each sighting.
    const last = list[list.length - 1];
    if (last && last.t === row.observedAt) { if (Math.abs(row.number - pick.threshold) < Math.abs(last.number - pick.threshold)) last.number = row.number; continue; }
    list.push({ t: row.observedAt, number: row.number });
    byPlatform.set(row.platform, list);
  }
  return [...byPlatform].map(([platform, points]) => ({ platform, points: points.slice(-60) }));
}

export function registerEdgeRoutes(app: FastifyInstance, deps: EdgeRouteDeps): void {
  const { edge, now } = deps;
  const held = (platform: string) => (deps.held ?? (() => false))(platform);
  const edgeQuery = z.object({ platform: platformSchema, view: z.enum(['edges', 'alternates', 'all']).default('edges'),
    sport: z.string().trim().min(1).max(20).optional(), market: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(150),
    minProbability: z.coerce.number().min(0).max(1).optional(),
    /** Best entries from today's games only (Eastern date), or any upcoming game. */
    day: z.enum(['all', 'today']).default('all') }).strict();

  app.get('/v1/edge', async (request, reply) => {
    const query = edgeQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ code: 'INVALID_EDGE_QUERY' });
    const snapshot = await edge.snapshot(query.data.platform);
    if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
    const nowMs = now().getTime();
    const filters = { nowMs, limit: query.data.limit, ...(query.data.sport ? { sport: query.data.sport } : {}),
      ...(query.data.market ? { market: query.data.market } : {}),
      ...(query.data.minProbability !== undefined ? { minProbability: query.data.minProbability } : {}) };
    // A platform on hold (a new feed not yet cleared by the side-bias check, 9b) shows no ranked picks or entries; its
    // Board still lists every line with Edge's read.
    if (held(query.data.platform) && query.data.view !== 'all') return { ...snapshot.response, picks: [], slips: [] };
    const picks = viewPicks(snapshot, query.data.view, filters);
    const live = (slip: { legs: { lineId: string }[] }) => slip.legs.every((leg) => {
      const pick = snapshot.byLine.get(leg.lineId); return !!pick && Date.parse(pick.eventStartTime) > nowMs; });
    const today = query.data.day === 'today' ? easternDay(new Date(nowMs)) : null;
    const slips = query.data.sport || query.data.market || today
      ? buildSlips(viewPicks(snapshot, 'edges', { ...filters, limit: 500 }).filter((pick) => !today || easternDay(new Date(pick.eventStartTime)) === today),
        snapshot.response.entries, { minEvents: snapshot.minEvents })
      : snapshot.response.slips.filter(live);
    return { ...snapshot.response, picks, slips };
  });

  app.get('/v1/edge/board', async (request, reply) => {
    const query = z.object({ platform: platformSchema, sport: z.string().trim().min(1).max(20).optional(), market: z.string().trim().min(1).max(80).optional(),
      q: z.string().trim().max(60).optional(), filter: z.enum(['all', 'picks', 'no_read']).default('all'),
      sort: z.enum(['start', 'edge', 'probability', 'rank']).default('start'),
      offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(100) })
      .strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ code: 'INVALID_EDGE_QUERY' });
    const snapshot = await edge.snapshot(query.data.platform);
    if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
    const { sport, market, q, platform: _platform, ...rest } = query.data;
    return boardPage(snapshot, { ...rest, ...(sport ? { sport } : {}), ...(market ? { market } : {}), ...(q ? { q } : {}),
      nowMs: now().getTime() });
  });

  app.post('/v1/edge/gen', async (request, reply) => {
    const body = z.object({ platform: platformSchema, type: z.enum(['POWER', 'FLEX', 'PARLAY']), size: z.number().int().min(2).max(20),
      count: z.number().int().min(1).max(10).default(3), sport: z.string().trim().min(1).max(20).optional(),
      from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
      maxPerGame: z.number().int().min(1).max(3).default(2), maxLegUses: z.number().int().min(1).max(5).default(1),
      objective: z.enum(['ev', 'growth']).default('ev'),
      // Goblins and Demons go in only when the member turns them on.
      alternates: z.boolean().default(false) })
      .strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_GEN_REQUEST' });
    const snapshot = await edge.snapshot(body.data.platform);
    if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
    const entry = snapshot.response.entries.find((item) => item.type === body.data.type && item.size === body.data.size);
    if (!entry) return reply.code(422).send({ code: 'ENTRY_UNSUPPORTED' });
    const nowMs = now().getTime();
    if (held(body.data.platform)) return { modelVersion: EDGE_MODEL_VERSION, builtAt: new Date(nowMs).toISOString(), pool: 0, slips: [],
      notes: ['Edge entries for this platform are on hold while its new prices are checked for one-sided bias.'] };
    const slips = generateEntries(snapshot.response.picks, entry, { count: body.data.count, nowMs,
      ...(body.data.sport ? { sport: body.data.sport } : {}),
      ...(body.data.from ? { from: Date.parse(body.data.from) } : {}), ...(body.data.to ? { to: Date.parse(body.data.to) } : {}),
      maxPerEvent: body.data.maxPerGame, maxLegUses: body.data.maxLegUses, minEvents: snapshot.minEvents, objective: body.data.objective, alternates: body.data.alternates });
    const pool = snapshot.response.picks.filter((pick) => pick.edge !== null && pick.edge > 0 && pick.rating !== 'NONE' &&
      Date.parse(pick.eventStartTime) > nowMs && (!body.data.sport || pick.sport === body.data.sport) &&
      (!body.data.from || Date.parse(pick.eventStartTime) >= Date.parse(body.data.from)) &&
      (!body.data.to || Date.parse(pick.eventStartTime) < Date.parse(body.data.to)) && backedLeg(pick));
    const alternates = pool.filter(isAlternate).length;
    const notes = [body.data.alternates
      ? `${pool.length} positive-EV lines were eligible, ${alternates} of them Goblins or Demons.`
      : `${pool.length - alternates} positive-EV standard lines were eligible.${alternates ? ` Turn on Goblins & Demons to add ${alternates} more.` : ''}`];
    if (body.data.alternates && body.data.type === 'FLEX' && slips.some((slip) => slip.legs.some((leg) => leg.payoutMultiplier && leg.payoutMultiplier !== 1)))
      notes.push('PrizePicks changes Flex payouts for Goblins and Demons; Edge estimates them. Load an entry into My Slip and type your app’s payouts for the exact number.');
    if (slips.length < body.data.count) notes.push(slips.length
      ? `Only ${slips.length} of ${body.data.count} entries had enough distinct +EV legs; Edge does not pad entries with weak legs.`
      : 'Not enough +EV legs across two or more games for this entry right now.');
    notes.push(body.data.platform === 'draftkings' || body.data.platform === 'hardrock'
      ? 'A parlay pays the legs’ odds multiplied together and only if every leg wins; each leg also works as a single bet. Same-game legs are correlated.'
      : 'Payouts are the app’s published chart as CrownIQ keeps it, times each pick’s own multiplier; confirm in the app.');
    notes.push('Same-game legs are priced with CrownIQ’s prior correlations (QB + receiver +0.35, teammates’ points −0.05, ' +
      'pitcher strikeouts vs opposing hitters −0.15, any two in one game +0.05).');
    if (body.data.objective === 'growth') notes.push('Built for long-run bankroll growth (Kelly): favours steadier entries over the highest EV.');
    return { modelVersion: EDGE_MODEL_VERSION, builtAt: new Date(nowMs).toISOString(), pool: body.data.alternates ? pool.length : pool.length - alternates, slips, notes };
  });

  app.get('/v1/edge/line/:lineId', async (request, reply) => {
    const params = z.object({ lineId: z.string().min(1).max(300) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_LINE_ID' });
    const platform = z.object({ platform: platformSchema }).safeParse(request.query);
    const snapshot = await edge.snapshot(platform.success ? platform.data.platform : 'prizepicks');
    if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
    const pick = pickForLine(snapshot, params.data.lineId);
    if (pick) return { pick, referenceEntry: snapshot.response.referenceEntry, distribution: distributionPoints(pick),
      movement: deps.snapshots ? lineMovement(deps.snapshots, pick, now().getTime()) : [] };
    const unread = snapshot.unpriced.find((item) => item.line.id === params.data.lineId);
    return unread ? reply.code(404).send({ code: 'EDGE_LINE_UNPRICED', reason: unread.reason, note: unread.note })
      : reply.code(404).send({ code: 'EDGE_LINE_NOT_FOUND' });
  });

  app.get('/v1/edge/player/:playerId', async (request, reply) => {
    const params = z.object({ playerId: z.string().min(1).max(300) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_PLAYER_ID' });
    const platform = z.object({ platform: platformSchema }).safeParse(request.query);
    const snapshot = await edge.snapshot(platform.success ? platform.data.platform : 'prizepicks');
    if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
    return { picks: snapshot.response.picks.filter((pick) => pick.playerId === params.data.playerId)
      .sort((a, b) => a.market.localeCompare(b.market) || a.threshold - b.threshold) };
  });

  app.post('/v1/edge/slip', async (request, reply) => {
    const body = z.object({ platform: platformSchema, type: z.enum(['POWER', 'FLEX', 'PARLAY']),
      lineIds: z.array(z.string().min(1).max(300)).min(2).max(20),
      // The payouts the app showed for this exact ticket (hits → multiple), when the member typed them in.
      payouts: z.record(z.string().regex(/^\d{1,2}$/), z.number().min(0).max(10_000)).optional() }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_SLIP' });
    const snapshot = await edge.snapshot(body.data.platform);
    if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
    const entry = snapshot.response.entries.find((item) => item.type === body.data.type && item.size === body.data.lineIds.length);
    if (!entry) return reply.code(422).send({ code: 'ENTRY_UNSUPPORTED' });
    const payouts = body.data.payouts && Object.values(body.data.payouts).some((value) => value > 0) ? body.data.payouts : undefined;
    const slip = customSlip(snapshot, entry, body.data.lineIds, now().getTime(), payouts);
    return slip ? { slip } : reply.code(422).send({ code: 'EDGE_LINE_UNPRICED' });
  });

  // In-app alerts (spec §8): stale lines with a real edge, at most one per player per hour.
  app.get('/v1/edge/alerts', async (request, reply) => {
    const query = z.object({ platform: z.enum(EDGE_PLATFORMS as [EdgePlatform, ...EdgePlatform[]]).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ code: 'INVALID_EDGE_QUERY' });
    await edge.snapshot(query.data.platform ?? 'prizepicks');
    return { alerts: edge.alertList(query.data.platform ?? null, now().getTime()).slice(0, 50) };
  });

  app.get('/v1/edge/performance', async (_request, reply) => {
    if (!deps.ledger) return reply.code(503).send({ code: 'EDGE_TRACKING_UNCONFIGURED' });
    return { status: edge.status(), grading: deps.worker?.status() ?? null, ...await deps.ledger.report() };
  });

  app.register(async (owner) => {
    owner.addHook('preHandler', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!await deps.isOwner(request)) return reply.code(404).send({ code: 'NOT_FOUND' });
    });
    owner.get('/status', async () => ({ status: edge.status(), grading: deps.worker?.status() ?? null,
      snapshots: deps.snapshots?.status() ?? null }));
    owner.get('/stale', async () => edge.staleReplay(7));
    // The health page (spec §10): per-source freshness, match rates, MARKET_MISMATCH, snapshot rows per hour, Odds API credits,
    // scraper spend, grading coverage, and the learned tables.
    owner.get('/health', async () => {
      const status = edge.status();
      const platforms = Object.fromEntries(Object.entries(status.reports).map(([platform, report]) => [platform, {
        lines: report.lines, read: report.read, noRead: report.noRead, plusEv: report.plusEv,
        matchRate: report.match && report.match.linesWithBookPrice ? Math.round(report.match.linesMatched / report.match.linesWithBookPrice * 1000) / 1000 : null,
        marketMismatch: report.match?.mismatches ?? 0, ambiguous: report.match?.ambiguous ?? 0, noEvent: report.match?.noEvent ?? 0 }]));
      return { checkedAt: now().toISOString(), edge: { computedAt: status.computedAt, lastError: status.lastError, platforms,
        weakTiers: status.weakTiers, sideBias: edge.sideBias() }, snapshots: deps.snapshots?.status() ?? null,
        grading: deps.worker?.status() ?? null, gradingCoverage: deps.ledger ? (await deps.ledger.report()).gradingCoverage : null,
        dispersion: status.dispersion ? { fittedAt: status.dispersion.fittedAt, markets: Object.keys(status.dispersion.markets).length } : null,
        bookWeights: status.bookWeights ? { fittedAt: status.bookWeights.fittedAt, scores: status.bookWeights.scores } : null,
        ...await deps.health?.().catch((error: unknown) => ({ healthError: error instanceof Error ? error.message : String(error) })) ?? {} };
    });
    owner.post('/grade', async (_request, reply) => deps.worker ? deps.worker.runOnce()
      : reply.code(503).send({ code: 'EDGE_GRADING_UNCONFIGURED' }));
    owner.get('/backtest', async (_request, reply) => {
      if (!deps.internalHistory) return reply.code(503).send({ code: 'HISTORY_UNCONFIGURED' });
      return backtestHistory(await deps.internalHistory.allRows());
    });
  }, { prefix: '/v1/owner/edge' });
}
