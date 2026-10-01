import { createHash } from 'node:crypto';
import { propLineSchema } from '@crowniq/contracts';
import type { PropLine } from '@crowniq/contracts';
import type { OddsProvider } from '@crowniq/engine';
import { z } from 'zod';

// First live slice: a bounded NFL passing-yards board. Add verified mappings by
// sport/market instead of sending unknown provider keys into a generic model.
const sportKey = 'americanfootball_nfl';
const marketNames: Readonly<Record<string, string>> = {
  player_pass_yds: 'passing_yards',
  player_pass_yds_alternate: 'passing_yards',
};

const eventSchema = z.object({
  id: z.string().min(1),
  sport_key: z.literal(sportKey),
  commence_time: z.iso.datetime({ offset: true }),
  home_team: z.string().min(1),
  away_team: z.string().min(1),
});

const outcomeSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  point: z.number().finite().optional(),
  sid: z.union([z.string().min(1), z.number()]).nullish(),
  multiplier: z.number().positive().finite().nullish(),
});

const eventOddsSchema = eventSchema.extend({
  bookmakers: z.array(z.object({
    key: z.string(),
    markets: z.array(z.object({
      key: z.string(),
      outcomes: z.array(outcomeSchema),
    })),
  })),
});

type Event = z.infer<typeof eventSchema>;
type Outcome = z.infer<typeof outcomeSchema>;

export interface RawPrizePicksSelection {
  readonly event: Event;
  readonly marketKey: string;
  readonly outcome: Outcome;
}

export interface TheOddsApiOptions {
  readonly apiKey: string;
  readonly marketKeys?: readonly string[];
  readonly maxEvents?: number;
  readonly maxCreditsPerRefresh?: number;
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

export class TheOddsApiProvider implements OddsProvider<RawPrizePicksSelection> {
  readonly id = 'the-odds-api:prizepicks';
  private readonly marketKeys: readonly string[];
  private readonly maxEvents: number;
  private readonly maxCredits: number;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private creditsRemaining: number | null = null;
  private lastRequestCost: number | null = null;
  private lastHttpStatus: number | null = null;

  constructor(private readonly options: TheOddsApiOptions) {
    if (!options.apiKey.trim()) throw new Error('THE_ODDS_API_KEY_REQUIRED');
    const markets = options.marketKeys ?? ['player_pass_yds', 'player_pass_yds_alternate'];
    if (!markets.length || new Set(markets).size !== markets.length ||
      markets.some((market) => !Object.hasOwn(marketNames, market))) {
      throw new Error('UNSUPPORTED_ODDS_API_MARKET_CONFIGURATION');
    }
    this.marketKeys = markets;
    this.maxEvents = options.maxEvents ?? 20;
    this.maxCredits = options.maxCreditsPerRefresh ?? 40;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1 ||
      !Number.isInteger(this.maxCredits) || this.maxCredits < 1) {
      throw new Error('INVALID_ODDS_API_REFRESH_BUDGET');
    }
    this.baseUrl = options.baseUrl ?? 'https://api.the-odds-api.com';
    this.fetchFn = options.fetchFn ?? fetch;
  }

  getHealth() {
    return { creditsRemaining: this.creditsRemaining, lastRequestCost: this.lastRequestCost,
      lastHttpStatus: this.lastHttpStatus };
  }

  async fetchPrizePicksLines(): Promise<readonly RawPrizePicksSelection[]> {
    const eventsUrl = this.url('/v4/sports/' + sportKey + '/events');
    const events = z.array(eventSchema).parse(await this.getJson(eventsUrl));
    // Fail before spending any paid credits if the entire configured board is
    // too large for the quota budget. Never publish a partial board as complete.
    if (events.length > this.maxEvents || events.length * this.marketKeys.length > this.maxCredits) {
      throw new Error('ODDS_API_REFRESH_BUDGET_EXCEEDED');
    }

    const selections: RawPrizePicksSelection[] = [];
    for (const event of events) {
      const url = this.url('/v4/sports/' + sportKey + '/events/' + encodeURIComponent(event.id) + '/odds');
      url.searchParams.set('bookmakers', 'prizepicks');
      url.searchParams.set('markets', this.marketKeys.join(','));
      url.searchParams.set('includeMultipliers', 'true');
      url.searchParams.set('includeSids', 'true');
      const odds = eventOddsSchema.parse(await this.getJson(url));
      if (odds.id !== event.id || odds.sport_key !== event.sport_key) {
        throw new Error('ODDS_API_EVENT_MISMATCH');
      }
      for (const bookmaker of odds.bookmakers) {
        if (bookmaker.key !== 'prizepicks') continue;
        for (const market of bookmaker.markets) {
          if (!this.marketKeys.includes(market.key)) continue;
          for (const outcome of market.outcomes) {
            if (outcome.name !== 'Over' && outcome.name !== 'Under') continue;
            if (!outcome.description?.trim() || outcome.point === undefined) {
              throw new Error('ODDS_API_INCOMPLETE_PLAYER_PROP');
            }
            selections.push({ event, marketKey: market.key, outcome });
          }
        }
      }
    }
    return selections;
  }

  normalize(raw: RawPrizePicksSelection, fetchedAt: string): PropLine {
    const { event, marketKey, outcome } = raw;
    const direction = outcome.name === 'Over' ? 'MORE' : 'LESS';
    if (!marketNames[marketKey] || !outcome.description?.trim() || outcome.point === undefined ||
      (outcome.name !== 'Over' && outcome.name !== 'Under')) {
      throw new Error('ODDS_API_INCOMPLETE_PLAYER_PROP');
    }
    const alternate = marketKey.endsWith('_alternate');
    const multiplier = outcome.multiplier;
    // A whole-board pass compares each alternate against a matching Regular
    // line and its offered direction; indicative price is not a tier label.
    const lineType = alternate ? 'UNKNOWN_ALTERNATE' : 'REGULAR';
    const key = [event.id, marketKey, outcome.description.trim().toLowerCase(),
      outcome.point, direction].join('|');
    const sourceId = outcome.sid == null ? 'surrogate:' + hash(key) : String(outcome.sid);
    return propLineSchema.parse({
      id: 'the-odds-api:' + hash(key + '|' + sourceId),
      provider: 'prizepicks',
      sourceLineId: sourceId,
      sourceLineIdIsSynthetic: outcome.sid == null,
      sourceMarketKey: marketKey,
      sport: 'NFL', league: 'NFL', eventId: event.id,
      eventName: event.away_team + ' @ ' + event.home_team,
      eventStartTime: event.commence_time,
      playerId: 'NFL:' + hash(outcome.description.trim().toLowerCase()),
      playerName: outcome.description.trim(),
      team: null, opponent: null,
      market: marketNames[marketKey], threshold: outcome.point,
      availableDirections: [direction], lineType, fetchedAt,
      ...(multiplier == null ? {} : { payoutMultiplier: multiplier }),
    });
  }

  private url(path: string): URL {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('apiKey', this.options.apiKey);
    return url;
  }

  private async getJson(url: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    } catch {
      this.lastHttpStatus = null;
      throw new Error('ODDS_API_CONNECTION_FAILED');
    }
    this.lastHttpStatus = response.status;
    const remaining = Number(response.headers.get('x-requests-remaining'));
    const last = Number(response.headers.get('x-requests-last'));
    if (response.headers.has('x-requests-remaining') && Number.isFinite(remaining)) {
      this.creditsRemaining = remaining;
    }
    if (response.headers.has('x-requests-last') && Number.isFinite(last)) this.lastRequestCost = last;
    if (!response.ok) throw new Error('ODDS_API_HTTP_' + response.status);
    try { return await response.json(); }
    catch { throw new Error('ODDS_API_INVALID_JSON'); }
  }
}
