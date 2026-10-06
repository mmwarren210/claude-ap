import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildSlips, EDGE_MODEL_VERSION, generateEntries } from '@crowniq/edge';
import { z } from 'zod';
import type { EdgePlatform } from '@crowniq/contracts';
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
}

const platformSchema = z.enum(EDGE_PLATFORMS as [EdgePlatform, ...EdgePlatform[]]).default('prizepicks');

export function registerEdgeRoutes(app: FastifyInstance, deps: EdgeRouteDeps): void {
  const { edge, now } = deps;
  const edgeQuery = z.object({ platform: platformSchema, view: z.enum(['edges', 'alternates', 'all']).default('edges'),
    sport: z.string().trim().min(1).max(20).optional(), market: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(150),
    minProbability: z.coerce.number().min(0).max(1).optional() }).strict();

  app.get('/v1/edge', async (request, reply) => {
    const query = edgeQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ code: 'INVALID_EDGE_QUERY' });
    const snapshot = await edge.snapshot(query.data.platform);
    if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
    const nowMs = now().getTime();
    const filters = { nowMs, limit: query.data.limit, ...(query.data.sport ? { sport: query.data.sport } : {}),
      ...(query.data.market ? { market: query.data.market } : {}),
      ...(query.data.minProbability !== undefined ? { minProbability: query.data.minProbability } : {}) };
    const picks = viewPicks(snapshot, query.data.view, filters);
    const live = (slip: { legs: { lineId: string }[] }) => slip.legs.every((leg) => {
      const pick = snapshot.byLine.get(leg.lineId); return !!pick && Date.parse(pick.eventStartTime) > nowMs; });
    const slips = query.data.sport || query.data.market
      ? buildSlips(viewPicks(snapshot, 'edges', { ...filters, limit: 500 }), snapshot.response.entries, { minEvents: snapshot.minEvents })
      : snapshot.response.slips.filter(live);
    return { ...snapshot.response, picks, slips };
  });

  app.get('/v1/edge/board', async (request, reply) => {
    const query = z.object({ platform: platformSchema, sport: z.string().trim().min(1).max(20).optional(), market: z.string().trim().min(1).max(80).optional(),
      q: z.string().trim().max(60).optional(), filter: z.enum(['all', 'picks', 'no_read']).default('all'),
      sort: z.enum(['start', 'edge', 'probability']).default('start'),
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
      maxPerGame: z.number().int().min(1).max(3).default(2), maxLegUses: z.number().int().min(1).max(5).default(1) })
      .strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_GEN_REQUEST' });
    const snapshot = await edge.snapshot(body.data.platform);
    if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
    const entry = snapshot.response.entries.find((item) => item.type === body.data.type && item.size === body.data.size);
    if (!entry) return reply.code(422).send({ code: 'ENTRY_UNSUPPORTED' });
    const nowMs = now().getTime();
    const slips = generateEntries(snapshot.response.picks, entry, { count: body.data.count, nowMs,
      ...(body.data.sport ? { sport: body.data.sport } : {}),
      ...(body.data.from ? { from: Date.parse(body.data.from) } : {}), ...(body.data.to ? { to: Date.parse(body.data.to) } : {}),
      maxPerEvent: body.data.maxPerGame, maxLegUses: body.data.maxLegUses, minEvents: snapshot.minEvents });
    const pool = snapshot.response.picks.filter((pick) => pick.edge !== null && pick.edge > 0 && pick.rating !== 'NONE' &&
      Date.parse(pick.eventStartTime) > nowMs && (!body.data.sport || pick.sport === body.data.sport) &&
      (!body.data.from || Date.parse(pick.eventStartTime) >= Date.parse(body.data.from)) &&
      (!body.data.to || Date.parse(pick.eventStartTime) < Date.parse(body.data.to))).length;
    const notes = [`${pool} positive-EV standard lines were eligible.`];
    if (slips.length < body.data.count) notes.push(slips.length
      ? `Only ${slips.length} of ${body.data.count} entries had enough distinct +EV legs; Edge does not pad entries with weak legs.`
      : 'Not enough +EV legs across two or more games for this entry right now.');
    notes.push(body.data.platform === 'draftkings' || body.data.platform === 'hardrock'
      ? 'A parlay pays the legs’ odds multiplied together and only if every leg wins; each leg also works as a single bet. Same-game legs are correlated.'
      : 'Payouts are the app’s published chart as CrownIQ keeps it, times each pick’s own multiplier; confirm in the app. Same-game legs are correlated.');
    return { modelVersion: EDGE_MODEL_VERSION, builtAt: new Date(nowMs).toISOString(), pool, slips, notes };
  });

  app.get('/v1/edge/line/:lineId', async (request, reply) => {
    const params = z.object({ lineId: z.string().min(1).max(300) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_LINE_ID' });
    const platform = z.object({ platform: platformSchema }).safeParse(request.query);
    const snapshot = await edge.snapshot(platform.success ? platform.data.platform : 'prizepicks');
    if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
    const pick = pickForLine(snapshot, params.data.lineId);
    if (pick) return { pick, referenceEntry: snapshot.response.referenceEntry };
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
      lineIds: z.array(z.string().min(1).max(300)).min(2).max(20) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_SLIP' });
    const snapshot = await edge.snapshot(body.data.platform);
    if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
    const entry = snapshot.response.entries.find((item) => item.type === body.data.type && item.size === body.data.lineIds.length);
    if (!entry) return reply.code(422).send({ code: 'ENTRY_UNSUPPORTED' });
    const slip = customSlip(snapshot, entry, body.data.lineIds);
    return slip ? { slip } : reply.code(422).send({ code: 'EDGE_LINE_UNPRICED' });
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
    owner.post('/grade', async (_request, reply) => deps.worker ? deps.worker.runOnce()
      : reply.code(503).send({ code: 'EDGE_GRADING_UNCONFIGURED' }));
    owner.get('/backtest', async (_request, reply) => {
      if (!deps.internalHistory) return reply.code(503).send({ code: 'HISTORY_UNCONFIGURED' });
      return backtestHistory(await deps.internalHistory.allRows());
    });
  }, { prefix: '/v1/owner/edge' });
}
