import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PropLineClient } from './propline.js';
import { proplineMarketKey, proplineLeague } from './propline.js';
import { leagueInfo } from './markets.js';
import type { DfsApp } from './scraped-line.js';

// PropLine's push half (Streaming Lite, owner 2026-10-09): instead of waiting for the next 15-minute pull, PropLine POSTs to
// CrownIQ the moment a line moves, a market is pulled, a prop grades or steam fires. Deliveries are free (they don't count
// against the daily request limit). Every delivery is HMAC-signed with a secret PropLine shows once, kept on the volume.

export type PushEvent = { event_type?: string; [key: string]: unknown };
type Subscription = { name: string; id: number; secret: string; lastSeq: number };
type Saved = { subscriptions: Subscription[] };
export interface PushHandlers {
  /** A line moved on an app: re-pull that app's sport (debounced). */
  pullSports(app: DfsApp, sportKeys: readonly string[]): Promise<unknown>;
  /** An app pulled a player's markets in a game. */
  suspend(app: DfsApp, gameId: string, player: string, marketKeys: readonly string[]): Promise<number>;
  /** A prop graded (any book): its actual stat value. */
  resolution?(event: PushEvent): void;
  /** Steam (several books moving one way). */
  steam?(event: PushEvent): void;
  /** Every delivery names its game and sport (so its results can be read back later). */
  noteGame?(gameId: string, sportKey: string): void;
}

const APPS: readonly DfsApp[] = ['prizepicks', 'underdog', 'pick6', 'dabble'];

export class PropLinePush {
  private saved: Saved = { subscriptions: [] };
  private loaded = false;
  private dirty = new Map<DfsApp, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private seenDeliveries = new Set<string>();
  private steamListeners: ((event: PushEvent) => void)[] = [];
  /** Steam deliveries also go to these (Edge's movement tracker, set up by the server). */
  onSteam(listener: (event: PushEvent) => void): void { this.steamListeners.push(listener); }
  private movedListeners: ((app: DfsApp, players: string[]) => void)[] = [];
  /** Called after a pushed move's re-pull, with the players whose lines moved (Edge reprices just them). */
  onMoved(listener: (app: DfsApp, players: string[]) => void): void { this.movedListeners.push(listener); }
  private readonly movedPlayers = new Map<DfsApp, Set<string>>();
  readonly stats = { deliveries: 0, events: {} as Record<string, number>, rejected: 0, lastAt: null as string | null,
    pulls: 0, suspended: 0, lastError: null as string | null, ensuredAt: null as string | null,
    /** The latest delivery of each type, for the owner page (shapes, not secrets). */
    samples: {} as Record<string, unknown> };

  constructor(private readonly client: PropLineClient, private readonly url: string, private readonly file: string,
    private readonly handlers: PushHandlers, private readonly flushMs = 60_000) {}

  /** Which call setup was on, for the owner page when it fails. */
  private step = 'start';

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try { this.saved = JSON.parse(await readFile(this.file, 'utf8')) as Saved; } catch { /* first run */ }
  }
  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.saved));
    await rename(temporary, this.file);
  }

  /** The subscriptions CrownIQ wants: the four apps' moves, pulls and grades in one; steam across the sports in another. */
  private wanted(sportKeys: readonly string[]): { name: string; body: Record<string, unknown> }[] {
    return [
      { name: 'apps', body: { url: this.url, events: ['line_movement', 'market_suspended', 'resolution'],
        filter_bookmaker_key: APPS.join(','), batch_max: 500, format: 'json' } },
      ...(sportKeys.length ? [{ name: 'steam', body: { url: this.url, events: ['steam'], filter_sport_key: sportKeys.join(',').slice(0, 1000),
        min_steam_score: 25, batch_max: 200, format: 'json' } }] : []),
    ];
  }

  /**
   * Makes sure CrownIQ's subscriptions exist (creating any that are missing and replacing any whose secret was lost), then
   * replays what was missed while the server was down.
   */
  async ensure(sportKeys: readonly string[]): Promise<void> {
    await this.load();
    if (sportKeys.length) this.sportKeys = sportKeys;
    try {
      this.step = 'list';
      const listed = await this.client.get<unknown>('/v1/webhooks');
      const existing = (Array.isArray(listed) ? listed : (listed as { data?: unknown[]; webhooks?: unknown[] })?.data
        ?? (listed as { webhooks?: unknown[] })?.webhooks ?? []) as { id: number; url?: string | null; events?: string[] }[];
      const keep: Subscription[] = [];
      for (const { name, body } of this.wanted(sportKeys)) {
        const mine = this.saved.subscriptions.find((item) => item.name === name);
        if (mine && existing.some((hook) => hook.id === mine.id)) {
          // Keep filters current (new sports), then catch up on anything missed.
          this.step = `update ${name}`;
          await this.client.send('PATCH', `/v1/webhooks/${mine.id}`, body).catch(() => undefined);
          keep.push(mine); continue;
        }
        // A hook at our address we hold no secret for can't be verified: replace it.
        for (const hook of existing) if (hook.url === this.url && JSON.stringify(hook.events ?? []) === JSON.stringify(body.events)
          && !this.saved.subscriptions.some((item) => item.id === hook.id))
          await this.client.send('DELETE', `/v1/webhooks/${hook.id}`).catch(() => undefined);
        this.step = `create ${name}`;
        const created = await this.client.send<{ id: number; secret: string }>('POST', '/v1/webhooks', body);
        if (created?.id && created.secret) keep.push({ name, id: created.id, secret: created.secret, lastSeq: 0 });
      }
      this.saved = { subscriptions: keep };
      await this.save();
      this.stats.ensuredAt = new Date().toISOString();
      this.step = 'replay';
      for (const subscription of keep) await this.replay(subscription).catch(() => undefined);
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
      this.stats.lastError = `${error instanceof Error ? error.message : 'ENSURE_FAILED'}${cause ? ` (${cause.code ?? cause.message ?? ''})` : ''} at ${this.step}`;
      console.warn(`[propline-push] subscriptions not set up: ${this.stats.lastError}`);
    }
  }

  /** The sports last asked for, so the owner page can re-run setup. */
  private sportKeys: readonly string[] = [];
  ensureNow(): Promise<void> { return this.ensure(this.sportKeys); }

  /** Events missed while CrownIQ was down (PropLine keeps 2 days), oldest first. */
  private async replay(subscription: Subscription): Promise<void> {
    if (!subscription.lastSeq) return;
    for (let page = 0; page < 20; page++) {
      const body = await this.client.get<{ events?: { seq: number; event_type?: string; data?: PushEvent }[]; next_seq?: number; has_more?: boolean }>(
        `/v1/webhooks/${subscription.id}/replay?since_seq=${subscription.lastSeq}&limit=500`);
      for (const event of body.events ?? []) this.apply({ ...event.data, event_type: event.event_type ?? event.data?.event_type });
      if (body.next_seq) subscription.lastSeq = Math.max(subscription.lastSeq, body.next_seq);
      if (!body.has_more) break;
    }
    await this.save();
  }

  /** A delivery: true when signed by one of our subscriptions (then its events are applied), false otherwise. */
  async receive(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<boolean> {
    await this.load();
    const header = (name: string) => { const value = headers[name]; return Array.isArray(value) ? value[0] : value; };
    const timestamp = header('x-propline-timestamp') ?? '', signature = header('x-propline-signature') ?? '';
    // PropLine retries a failed delivery for up to about an hour (10s, 30s, 2m, 10m, 30m, 1h), so signatures up to 3 hours
    // old are accepted; replays inside that window are dropped by their delivery id.
    if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 3 * 3600) { this.stats.rejected++; return false; }
    const owner = this.saved.subscriptions.find((subscription) => {
      const expected = createHmac('sha256', subscription.secret).update(`${timestamp}.`).update(raw).digest('hex');
      return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    });
    if (!owner) { this.stats.rejected++; return false; }
    const delivery = header('x-propline-delivery') ?? '';
    if (delivery && this.seenDeliveries.has(delivery)) return true;
    if (delivery) { this.seenDeliveries.add(delivery); if (this.seenDeliveries.size > 20_000) this.seenDeliveries.clear(); }
    let body: { batch?: boolean; event_type?: string; events?: { delivery_id?: number; data?: PushEvent }[] } & PushEvent;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return true; }
    const type = header('x-propline-event') ?? body.event_type;
    const events = body.batch ? (body.events ?? []).map((item) => ({ ...item.data, event_type: item.data?.event_type ?? type })) : [{ ...body, event_type: body.event_type ?? type }];
    this.stats.deliveries++; this.stats.lastAt = new Date().toISOString();
    for (const event of events) this.apply(event);
    const seq = Number(header('x-propline-sequence'));
    if (Number.isFinite(seq) && seq > owner.lastSeq) { owner.lastSeq = seq; void this.save().catch(() => undefined); }
    return true;
  }

  private apply(event: PushEvent): void {
    const type = String(event.event_type ?? 'unknown');
    this.stats.events[type] = (this.stats.events[type] ?? 0) + 1;
    this.stats.samples[type] = event;
    const app = String(event.bookmaker_key ?? '') as DfsApp, sportKey = String(event.sport_key ?? '');
    const gameId = (event.event as { id?: unknown } | undefined)?.id;
    if (gameId !== undefined && sportKey) this.handlers.noteGame?.(String(gameId), sportKey);
    // A delivery where neither the number nor the price moved (e.g. only a payout multiplier changed) needs no re-pull.
    const before = event.previous as { point?: unknown; price_american?: unknown } | undefined, after = event.current as typeof before;
    const moved = !before || !after || before.point !== after.point || before.price_american !== after.price_american;
    if (type === 'line_movement' && APPS.includes(app) && sportKey && moved) {
      const set = this.dirty.get(app) ?? new Set<string>(); set.add(sportKey); this.dirty.set(app, set);
      const player = typeof event.player_name === 'string' ? event.player_name : typeof event.description === 'string' ? event.description : null;
      if (player) { const moved = this.movedPlayers.get(app) ?? new Set<string>(); moved.add(player); this.movedPlayers.set(app, moved); }
      this.schedule();
    } else if (type === 'market_suspended' && APPS.includes(app)) {
      const game = (event.event as { id?: unknown } | undefined)?.id, player = typeof event.subject === 'string' ? event.subject : null;
      if (game === undefined || !player) return;
      const sport = leagueInfo(proplineLeague(sportKey)).sport;
      const keys = ((event.markets as { key?: string }[] | undefined) ?? []).map((market) => market.key ?? '').filter(Boolean)
        .flatMap((key) => [key, proplineMarketKey(sport, key)]);
      void this.handlers.suspend(app, `propline:${game}`, player, keys).then((removed) => { this.stats.suspended += removed; })
        .catch(() => undefined);
    } else if (type === 'resolution') this.handlers.resolution?.(event);
    else if (type === 'steam') { this.handlers.steam?.(event); for (const listener of this.steamListeners) listener(event); }
  }

  /** Moves arrive in bursts, so each app's moved sports are re-pulled together, at most once a minute. */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    const work = [...this.dirty], players = new Map(this.movedPlayers); this.dirty.clear(); this.movedPlayers.clear();
    for (const [app, sports] of work) {
      try {
        await this.handlers.pullSports(app, [...sports]); this.stats.pulls++;
        const moved = [...players.get(app) ?? []];
        if (moved.length) for (const listener of this.movedListeners) listener(app, moved);
      } catch (error) { this.stats.lastError = error instanceof Error ? error.message : 'PULL_FAILED'; }
    }
  }

  /** PrizePicks' standard payout chart as PropLine publishes it (free reference data). */
  dfsPayouts(): Promise<unknown> { return this.client.get('/v1/dfs/payouts'); }

  status() {
    return { url: this.url, subscriptions: this.saved.subscriptions.map(({ name, id, lastSeq }) => ({ name, id, lastSeq })), ...this.stats,
      waiting: Object.fromEntries([...this.dirty].map(([app, sports]) => [app, [...sports]])) };
  }
}
