import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MarketOdds } from './context/feeds.js';

// Live prediction-market prices from Kalshi's free public API (no key, no Apify cost), read every 10
// minutes. Display only. When a read fails, the last good prices stay, and the server falls back to the daily Apify feed
// once they are more than 30 minutes old.

export type LivePlatform = 'kalshi';

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
/** Kalshi's game-winner series per league. */
export const kalshiSeries: readonly string[] = ['KXNFLGAME', 'KXNCAAFGAME', 'KXMLBGAME', 'KXNBAGAME', 'KXWNBAGAME', 'KXNHLGAME'];

type Row = Record<string, unknown>;
const asRow = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {};
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const num = (value: unknown) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};
/** Kalshi prices come in cents (yes_ask: 34) or dollars (yes_ask_dollars: "0.3400"); returns cents. */
const cents = (market: Row, field: string) => num(market[field]) ?? (num(market[`${field}_dollars`]) !== null
  ? Math.round(num(market[`${field}_dollars`])! * 10_000) / 100 : null);

/**
 * Kalshi game-winner markets: one per team, "Kansas City at Las Vegas — Las Vegas". Yes is priced at the ask (what a buyer
 * pays) and No at 100 minus the bid, so a pick's price is a real buy price, not a midpoint.
 */
export function kalshiOdds(events: readonly unknown[]): MarketOdds[] {
  const out: MarketOdds[] = [];
  for (const value of events) {
    const event = asRow(value), title = text(event.title);
    const markets = Array.isArray(event.markets) ? event.markets : [];
    for (const item of markets) {
      const market = asRow(item), subject = text(market.yes_sub_title) ?? text(market.subtitle);
      const ask = cents(market, 'yes_ask'), bid = cents(market, 'yes_bid');
      if (!title || !subject || ask === null || ask <= 0 || ask >= 100 || (market.status !== undefined &&
        market.status !== 'active' && market.status !== 'open')) continue;
      out.push({ platform: 'kalshi', eventTitle: title, question: `${title} — ${subject}`,
        outcomes: [{ name: 'Yes', probability: ask }, { name: 'No', probability: bid === null ? 100 - ask : 100 - bid }],
        volume24h: num(market.volume_24h), closeTime: text(market.expected_expiration_time) ?? text(market.close_time),
        url: text(event.event_ticker) ? `https://kalshi.com/markets/${String(event.series_ticker ?? '').toLowerCase()}/${
          String(event.event_ticker).toLowerCase()}` : 'https://kalshi.com/sports' });
    }
  }
  return out;
}

export interface LiveStatus {
  readonly fetchedAt: Record<LivePlatform, string | null>; readonly markets: Record<LivePlatform, number>;
  readonly lastError: Record<LivePlatform, string | null>;
}

/** Keeps the latest live Kalshi prices, refreshed on an interval and saved to disk. */
export class LiveMarkets {
  private state: Record<LivePlatform, { fetchedAt: string | null; items: MarketOdds[]; lastError: string | null }> = {
    kalshi: { fetchedAt: null, items: [], lastError: null } };
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly file: string | null, private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date()) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try { const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<typeof this.state>; if (saved.kalshi) this.state.kalshi = saved.kalshi; } catch { /* first run */ }
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return response.json();
  }

  private async readKalshi(): Promise<MarketOdds[]> {
    const events: unknown[] = [];
    for (const series of kalshiSeries) {
      let cursor = '';
      for (let page = 0; page < 5; page++) {
        const body = asRow(await this.json(`${KALSHI}/events?series_ticker=${series}&status=open&with_nested_markets=true&limit=100${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
        events.push(...(Array.isArray(body.events) ? body.events : []).map((event) => ({ ...asRow(event), series_ticker: series })));
        cursor = text(body.cursor) ?? '';
        if (!cursor) break;
      }
    }
    return kalshiOdds(events);
  }

  /** Reads Kalshi now. A failed platform keeps its last good prices and reports the error. */
  async refresh(): Promise<LiveStatus> {
    await this.load();
    for (const platform of ['kalshi'] as const) {
      try {
        const items = await this.readKalshi();
        if (!items.length) throw new Error('NO_MARKETS');
        this.state[platform] = { fetchedAt: this.clock().toISOString(), items, lastError: null };
      } catch (error) {
        this.state[platform].lastError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      }
    }
    if (this.file) {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.state));
      await rename(temporary, this.file);
    }
    return this.status();
  }

  /** The platform's live prices when they are under maxAgeMinutes old, else null (the caller falls back to the feed). */
  async items(platform: LivePlatform, maxAgeMinutes = 30): Promise<{ fetchedAt: string; items: MarketOdds[] } | null> {
    await this.load();
    const { fetchedAt, items } = this.state[platform];
    if (!fetchedAt || this.clock().getTime() - Date.parse(fetchedAt) > maxAgeMinutes * 60_000) return null;
    return { fetchedAt, items };
  }

  async status(): Promise<LiveStatus> {
    await this.load();
    return { fetchedAt: { kalshi: this.state.kalshi.fetchedAt },
      markets: { kalshi: this.state.kalshi.items.length },
      lastError: { kalshi: this.state.kalshi.lastError } };
  }

  start(minutes = 10): void {
    if (this.timer) return;
    const run = () => { void this.refresh().catch(() => undefined); };
    setTimeout(run, 20_000).unref();
    this.timer = setInterval(run, minutes * 60_000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
