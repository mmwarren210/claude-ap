import { createHash } from 'node:crypto';
import { marketQuoteSchema, propLineSchema } from '@crowniq/contracts';
import type { MarketQuote, PropLine, Sport } from '@crowniq/contracts';
import type { OddsProvider } from '@crowniq/engine';
import { normalizePrizePicksMarketKey } from './prizepicks-line-types.js';
import { z } from 'zod';

const sportSchema = z.object({
  key: z.string().min(1), title: z.string().min(1), active: z.boolean().optional(),
});
const eventSchema = z.object({
  id: z.string().min(1), sport_key: z.string().min(1),
  commence_time: z.iso.datetime({ offset: true }),
  home_team: z.string().nullish(), away_team: z.string().nullish(),
});
const marketListSchema = z.object({
  id: z.string(), sport_key: z.string(),
  bookmakers: z.array(z.object({
    key: z.string(), markets: z.array(z.object({ key: z.string().min(1) })),
  })),
});
const outcomeSchema = z.object({
  name: z.string(), description: z.string().nullish(),
  point: z.number().finite().nullish(),
  sid: z.union([z.string().min(1), z.number()]).nullish(),
  multiplier: z.number().positive().finite().nullish(),
  price: z.number().finite().nullish(),
});
const oddsSchema = eventSchema.extend({
  bookmakers: z.array(z.object({
    key: z.string(), markets: z.array(z.object({
      key: z.string(), outcomes: z.array(outcomeSchema),
    })),
  })),
});

type ProviderSport = z.infer<typeof sportSchema>;
type Event = z.infer<typeof eventSchema>;
type Outcome = z.infer<typeof outcomeSchema>;
interface Target { readonly sport: ProviderSport; readonly event: Event; readonly markets: readonly string[] }
interface RawSelection {
  readonly sport: ProviderSport;
  readonly event: Event;
  readonly marketKey: string;
  readonly outcome: Outcome;
}

export interface FullPullCoverage {
  sportsScanned: number;
  eventsDiscovered: number;
  eventsWithPrizePicks: number;
  marketsDiscovered: number;
  oddsRequests: number;
  selections: number;
  skippedOutcomes: number;
  creditsSpent: number;
  creditsRemaining: number | null;
  complete: boolean;
  marketKeys: string[];
  sportKeysWithLines: string[];
}

export interface FullPrizePicksOptions {
  readonly apiKey: string;
  readonly fetchFn?: typeof fetch;
  readonly baseUrl?: string;
  readonly maxEvents?: number;
  readonly maxCreditsPerRefresh?: number;
  /** Sportsbooks requested alongside PrizePicks in the same odds call. The Odds API bills
   * each group of up to 10 bookmakers as one region, so up to nine extra books do not
   * change the per-market credit cost. Their prices feed the Edge engine only. */
  readonly consensusBookmakers?: readonly string[];
}

interface RawQuote {
  readonly sport: ProviderSport; readonly event: Event; readonly bookmaker: string;
  readonly marketKey: string; readonly player: string; readonly point: number;
  over: number | null; under: number | null;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const excludedMarket = /^(h2h|spreads|totals|alternate_spreads|alternate_totals|team_totals|alternate_team_totals|outrights)(_|$)/;

function crownSport(key: string): Sport {
  if (key === 'americanfootball_nfl') return 'NFL';
  if (key === 'americanfootball_ncaaf') return 'NCAAFB';
  if (key === 'baseball_mlb') return 'MLB';
  if (key === 'baseball_kbo') return 'KBO';
  if (key === 'basketball_nba') return 'NBA';
  if (key === 'basketball_wnba') return 'WNBA';
  if (key === 'icehockey_nhl') return 'NHL';
  if (key.startsWith('tennis_')) return 'TENNIS';
  if (key.startsWith('tabletennis_') || key.startsWith('table_tennis_')) return 'TABLE_TENNIS';
  if (key.startsWith('badminton_')) return 'BADMINTON';
  if (key.startsWith('handball_')) return 'HANDBALL';
  if (key.startsWith('soccer_')) return 'SOCCER';
  if (key.startsWith('aussierules_') || key.startsWith('australianrules_')) return 'AFL';
  if (key.startsWith('darts_')) return 'DARTS';
  if (/counterstrike|cs2/.test(key)) return 'CS2';
  if (key.includes('valorant')) return 'VALORANT';
  if (key.includes('dota')) return 'DOTA';
  if (key.includes('apex')) return 'APEX';
  if (key.includes('leagueoflegends')) return 'LOL';
  return 'OTHER';
}

export class FullPrizePicksProvider implements OddsProvider<RawSelection> {
  readonly id = 'the-odds-api:prizepicks:full';
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxEvents: number;
  private readonly maxCredits: number;
  private creditsRemaining: number | null = null;
  private lastRequestCost: number | null = null;
  private lastHttpStatus: number | null = null;
  private coverage: FullPullCoverage | null = null;
  private readonly consensusBooks: readonly string[];
  private quotes: RawQuote[] = [];

  constructor(private readonly options: FullPrizePicksOptions) {
    if (!options.apiKey.trim()) throw new Error('THE_ODDS_API_KEY_REQUIRED');
    this.fetchFn = options.fetchFn ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.the-odds-api.com';
    this.maxEvents = options.maxEvents ?? 5000;
    this.maxCredits = options.maxCreditsPerRefresh ?? 10000;
    this.consensusBooks = [...new Set((options.consensusBookmakers ?? [])
      .map((book) => book.trim().toLowerCase()).filter((book) => book && book !== 'prizepicks'))];
    if (this.consensusBooks.length > 9 || this.consensusBooks.some((book) => !/^[a-z0-9_]+$/.test(book))) {
      throw new Error('INVALID_CONSENSUS_BOOKMAKERS');
    }
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1 ||
      !Number.isSafeInteger(this.maxCredits) || this.maxCredits < 1) {
      throw new Error('INVALID_ODDS_API_REFRESH_BUDGET');
    }
  }

  getHealth() {
    return { creditsRemaining: this.creditsRemaining, lastRequestCost: this.lastRequestCost,
      lastHttpStatus: this.lastHttpStatus, coverage: this.coverage };
  }

  async fetchPrizePicksLines(): Promise<readonly RawSelection[]> {
    const coverage: FullPullCoverage = {
      sportsScanned: 0, eventsDiscovered: 0, eventsWithPrizePicks: 0,
      marketsDiscovered: 0, oddsRequests: 0, selections: 0, skippedOutcomes: 0,
      creditsSpent: 0, creditsRemaining: this.creditsRemaining, complete: false,
      marketKeys: [], sportKeysWithLines: [],
    };
    this.coverage = coverage;
    const sports = z.array(sportSchema).parse(await this.getJson('/v4/sports', 0, coverage));
    if (this.creditsRemaining === null) throw new Error('ODDS_API_MISSING_QUOTA_HEADERS');
    const events: { sport: ProviderSport; event: Event }[] = [];
    for (const sport of sports.filter((item) => item.active !== false)) {
      const found = z.array(eventSchema).parse(await this.getJson(
        '/v4/sports/' + encodeURIComponent(sport.key) + '/events', 0, coverage));
      coverage.sportsScanned++;
      for (const event of found) {
        if (event.sport_key !== sport.key) throw new Error('ODDS_API_EVENT_MISMATCH');
        events.push({ sport, event });
      }
    }
    coverage.eventsDiscovered = events.length;
    if (events.length > this.maxEvents) throw new Error('ODDS_API_EVENT_LIMIT_EXCEEDED');
    // Discovery costs one credit per event. Do not begin it unless every
    // available event can be checked for PrizePicks markets.
    this.requireBudget(events.length, coverage);

    const targets: Target[] = [];
    for (const { sport, event } of events) {
      const path = '/v4/sports/' + encodeURIComponent(sport.key) +
        '/events/' + encodeURIComponent(event.id);
      const listing = marketListSchema.parse(await this.getJson(
        path + '/markets', 1, coverage, { bookmakers: 'prizepicks' }));
      if (listing.id !== event.id || listing.sport_key !== sport.key) {
        throw new Error('ODDS_API_EVENT_MISMATCH');
      }
      const markets = [...new Set(listing.bookmakers
        .filter((book) => book.key === 'prizepicks')
        .flatMap((book) => book.markets.map((market) => market.key)))]
        .filter((key) => !excludedMarket.test(key));
      if (markets.length) {
        coverage.eventsWithPrizePicks++;
        coverage.marketsDiscovered += markets.length;
        targets.push({ sport, event, markets });
      }
    }
    // Event odds cost at most one credit per requested market for one book.
    // Do not fetch a partial board if the remaining account quota is smaller.
    this.requireBudget(coverage.marketsDiscovered, coverage);

    const selections: RawSelection[] = [];
    const quotes = new Map<string, RawQuote>();
    const bookmakers = ['prizepicks', ...this.consensusBooks].join(',');
    const sportKeys = new Set<string>();
    const marketKeys = new Set<string>();
    for (const { sport, event, markets } of targets) {
      const path = '/v4/sports/' + encodeURIComponent(sport.key) +
        '/events/' + encodeURIComponent(event.id) + '/odds';
      // Small chunks keep URLs short and ensure each request's maximum cost
      // is known even when a bookmaker lists many different markets.
      for (let index = 0; index < markets.length; index += 20) {
        const batch = markets.slice(index, index + 20);
        const odds = oddsSchema.parse(await this.getJson(path, batch.length, coverage, {
          bookmakers, markets: batch.join(','),
          includeMultipliers: 'true', includeSids: 'true',
          ...(this.consensusBooks.length ? { oddsFormat: 'decimal' } : {}),
        }));
        coverage.oddsRequests++;
        if (odds.id !== event.id || odds.sport_key !== sport.key) {
          throw new Error('ODDS_API_EVENT_MISMATCH');
        }
        for (const book of odds.bookmakers.filter((item) => item.key === 'prizepicks')) {
          for (const market of book.markets.filter((item) => batch.includes(item.key))) {
            for (const outcome of market.outcomes) {
              if ((outcome.name !== 'Over' && outcome.name !== 'Under') ||
                !outcome.description?.trim() || outcome.point == null) {
                coverage.skippedOutcomes++;
                continue;
              }
              selections.push({ sport, event, marketKey: market.key, outcome });
              sportKeys.add(sport.key);
              marketKeys.add(market.key);
            }
          }
        }
        for (const book of odds.bookmakers.filter((item) => this.consensusBooks.includes(item.key))) {
          for (const market of book.markets.filter((item) => batch.includes(item.key))) {
            for (const outcome of market.outcomes) {
              const player = outcome.description?.trim();
              if ((outcome.name !== 'Over' && outcome.name !== 'Under') || !player ||
                outcome.point == null || outcome.price == null || !(outcome.price > 1)) continue;
              const key = [event.id, book.key, market.key, player.toLowerCase(), outcome.point].join('|');
              const quote = quotes.get(key) ?? { sport, event, bookmaker: book.key, marketKey: market.key,
                player, point: outcome.point, over: null, under: null };
              if (outcome.name === 'Over') quote.over = outcome.price; else quote.under = outcome.price;
              quotes.set(key, quote);
            }
          }
        }
      }
    }
    this.quotes = [...quotes.values()];
    coverage.selections = selections.length;
    coverage.marketKeys = [...marketKeys].sort();
    coverage.sportKeysWithLines = [...sportKeys].sort();
    coverage.complete = true;
    return selections;
  }

  normalize(raw: RawSelection, fetchedAt: string): PropLine {
    const { sport, event, marketKey, outcome } = raw;
    if (!outcome.description?.trim() || outcome.point == null ||
      (outcome.name !== 'Over' && outcome.name !== 'Under')) {
      throw new Error('ODDS_API_INCOMPLETE_PLAYER_PROP');
    }
    const direction = outcome.name === 'Over' ? 'MORE' : 'LESS';
    const multiplier = outcome.multiplier;
    const alternate = marketKey.endsWith('_alternate');
    // A payout number alone cannot identify whether an Over/Under outcome is
    // easier or harder than the matching Regular threshold. Classify after
    // normalizing the complete board so the Regular reference is available.
    const lineType = alternate ? 'UNKNOWN_ALTERNATE' : 'REGULAR';
    const key = [sport.key, event.id, marketKey, outcome.description.trim().toLowerCase(),
      outcome.point, direction].join('|');
    const sourceId = outcome.sid == null ? 'surrogate:' + hash(key) : String(outcome.sid);
    const normalizedSport=crownSport(sport.key);
    return propLineSchema.parse({
      id: 'the-odds-api:' + hash(key + '|' + sourceId), provider: 'prizepicks',
      sourceLineId: sourceId, sourceLineIdIsSynthetic: outcome.sid == null,
      sourceSportKey: sport.key, sourceMarketKey: marketKey,
      sport: normalizedSport, league: sport.title,
      eventId: event.id, eventName: event.away_team && event.home_team
        ? event.away_team + ' @ ' + event.home_team : sport.title + ' / ' + event.id,
      eventStartTime: event.commence_time,
      playerId: sport.key + ':' + hash(outcome.description.trim().toLowerCase()),
      playerName: outcome.description.trim(), team: null, opponent: null,
      market: normalizePrizePicksMarketKey(normalizedSport,marketKey),
      threshold: outcome.point, availableDirections: [direction], lineType, fetchedAt,
      ...(multiplier == null ? {} : { payoutMultiplier: multiplier }),
    });
  }

  /** Sportsbook quotes from the most recent complete pull, for the Edge engine. */
  marketQuotes(fetchedAt: string): MarketQuote[] {
    return this.quotes.flatMap((quote) => {
      const sport = crownSport(quote.sport.key);
      const parsed = marketQuoteSchema.safeParse({ bookmaker: quote.bookmaker, sport,
        sourceSportKey: quote.sport.key, eventId: quote.event.id, sourceMarketKey: quote.marketKey,
        market: normalizePrizePicksMarketKey(sport, quote.marketKey), playerName: quote.player,
        point: quote.point, overPrice: quote.over, underPrice: quote.under, fetchedAt });
      return parsed.success ? [parsed.data] : [];
    });
  }

  private requireBudget(estimate: number, coverage: FullPullCoverage): void {
    if (this.creditsRemaining === null || estimate > this.creditsRemaining ||
      coverage.creditsSpent + estimate > this.maxCredits) {
      throw new Error('ODDS_API_INSUFFICIENT_CREDITS_FOR_FULL_BOARD');
    }
  }

  private async getJson(path: string, estimatedCost: number, coverage: FullPullCoverage,
    params: Record<string, string> = {}): Promise<unknown> {
    if (estimatedCost) this.requireBudget(estimatedCost, coverage);
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('apiKey', this.options.apiKey);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try { response = await this.fetchFn(url, { signal: AbortSignal.timeout(15000) }); }
    catch { this.lastHttpStatus = null; throw new Error('ODDS_API_CONNECTION_FAILED'); }
    this.lastHttpStatus = response.status;
    const remaining = response.headers.get('x-requests-remaining');
    const spent = response.headers.get('x-requests-last');
    if (remaining != null && Number.isSafeInteger(Number(remaining))) {
      this.creditsRemaining = Number(remaining);
    }
    if (spent != null && Number.isSafeInteger(Number(spent))) {
      this.lastRequestCost = Number(spent);
      coverage.creditsSpent += Number(spent);
    }
    coverage.creditsRemaining = this.creditsRemaining;
    if (!response.ok) throw new Error('ODDS_API_HTTP_' + response.status);
    try { return await response.json(); }
    catch { throw new Error('ODDS_API_INVALID_JSON'); }
  }
}
