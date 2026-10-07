import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { propLineSchema } from '@crowniq/contracts';
import type { PropLine, Sport } from '@crowniq/contracts';
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
  /** Decimal odds, when the request asked for them (the consensus books' prices). */
  price: z.number().positive().finite().nullish(),
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
  /**
   * Step 5a (from claude/edge-engine d46fb69): sportsbooks asked for in the same odds call as PrizePicks. The Odds API bills
   * each group of up to 10 bookmakers as one region, so up to nine extra books don't change the credit cost per market.
   * Their two-sided prices feed Edge only, never a GKR score.
   */
  readonly consensusBookmakers?: readonly string[];
  /** Where the last pull's consensus quotes are kept, so a restart between the twice-daily pulls doesn't drop them. */
  readonly quotesFile?: string | null;
}

/** One consensus book's Over and Under for a player, market and number from the last pull (decimal odds). */
export interface ConsensusQuote {
  readonly sport: Sport; readonly sportKey: string; readonly eventId: string; readonly startTime: string;
  readonly home: string | null; readonly away: string | null; readonly book: string; readonly marketKey: string;
  readonly player: string; readonly point: number; over: number | null; under: number | null; readonly fetchedAt: string;
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
  private quotes: ConsensusQuote[] = [];
  private quotesLoaded = false;

  constructor(private readonly options: FullPrizePicksOptions) {
    if (!options.apiKey.trim()) throw new Error('THE_ODDS_API_KEY_REQUIRED');
    this.fetchFn = options.fetchFn ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.the-odds-api.com';
    this.maxEvents = options.maxEvents ?? 5000;
    this.maxCredits = options.maxCreditsPerRefresh ?? 10000;
    this.consensusBooks = [...new Set((options.consensusBookmakers ?? []).map((book) => book.trim().toLowerCase())
      .filter((book) => book && book !== 'prizepicks'))];
    if (this.consensusBooks.length > 9 || this.consensusBooks.some((book) => !/^[a-z0-9_]+$/.test(book))) throw new Error('INVALID_CONSENSUS_BOOKMAKERS');
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1 ||
      !Number.isSafeInteger(this.maxCredits) || this.maxCredits < 1) {
      throw new Error('INVALID_ODDS_API_REFRESH_BUDGET');
    }
  }

  /** The last pull's two-sided consensus quotes, keyed like the Odds API PrizePicks lines (same market normalization). */
  consensusQuotes(): readonly ConsensusQuote[] {
    if (!this.quotes.length && this.options.quotesFile && !this.quotesLoaded) {
      this.quotesLoaded = true;
      try { this.quotes = JSON.parse(readFileSync(this.options.quotesFile, 'utf8')) as ConsensusQuote[]; } catch { /* none yet */ }
    }
    return this.quotes.filter((quote) => quote.over && quote.under);
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
    const sportKeys = new Set<string>();
    const marketKeys = new Set<string>();
    const quotes = new Map<string, ConsensusQuote>(), pulledAt = new Date().toISOString();
    for (const { sport, event, markets } of targets) {
      const path = '/v4/sports/' + encodeURIComponent(sport.key) +
        '/events/' + encodeURIComponent(event.id) + '/odds';
      // Small chunks keep URLs short and ensure each request's maximum cost
      // is known even when a bookmaker lists many different markets.
      for (let index = 0; index < markets.length; index += 20) {
        const batch = markets.slice(index, index + 20);
        const odds = oddsSchema.parse(await this.getJson(path, batch.length, coverage, {
          bookmakers: ['prizepicks', ...this.consensusBooks].join(','), markets: batch.join(','),
          includeMultipliers: 'true', includeSids: 'true', ...(this.consensusBooks.length ? { oddsFormat: 'decimal' } : {}),
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
        // The consensus books' Over and Under at each number, joined back together.
        for (const book of odds.bookmakers.filter((item) => this.consensusBooks.includes(item.key))) {
          for (const market of book.markets.filter((item) => batch.includes(item.key))) {
            for (const outcome of market.outcomes) {
              const player = outcome.description?.trim();
              if ((outcome.name !== 'Over' && outcome.name !== 'Under') || !player || outcome.point == null || !(outcome.price && outcome.price > 1)) continue;
              const key = [event.id, book.key, market.key, player.toLowerCase(), outcome.point].join('|');
              const quote = quotes.get(key) ?? { sport: crownSport(sport.key), sportKey: sport.key, eventId: event.id,
                startTime: event.commence_time, home: event.home_team ?? null, away: event.away_team ?? null, book: book.key,
                marketKey: market.key, player, point: outcome.point, over: null, under: null, fetchedAt: pulledAt };
              if (outcome.name === 'Over') quote.over = outcome.price; else quote.under = outcome.price;
              quotes.set(key, quote);
            }
          }
        }
      }
    }
    this.quotes = [...quotes.values()];
    if (this.options.quotesFile && this.consensusBooks.length) {
      try { mkdirSync(dirname(this.options.quotesFile), { recursive: true }); writeFileSync(this.options.quotesFile, JSON.stringify(this.quotes)); }
      catch { /* best effort */ }
    }
    coverage.selections = selections.length;
    coverage.marketKeys = [...marketKeys].sort();
    coverage.sportKeysWithLines = [...sportKeys].sort();
    coverage.complete = true;
    // Edge 2.0 budget report (spec §1.1b, §10): credits per refresh, before and after more bookmakers join this call.
    console.log(`[odds-api] PrizePicks pull: ${coverage.eventsWithPrizePicks}/${coverage.eventsDiscovered} events, ` +
      `${coverage.marketsDiscovered} markets, ${coverage.oddsRequests} odds requests, ${selections.length} outcomes, ` +
      `${coverage.creditsSpent} credits spent, ${coverage.creditsRemaining ?? '?'} left; consensus books ${this.consensusBooks.join(',') || 'none'}: ` +
      `${this.quotes.filter((quote) => quote.over && quote.under).length} two-sided quotes ${JSON.stringify(Object.fromEntries(
        [...new Set(this.quotes.map((quote) => quote.sport))].map((sport) => [sport, this.quotes.filter((quote) => quote.sport === sport && quote.over && quote.under).length])))}`);
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
      homeTeam: event.home_team ?? null, awayTeam: event.away_team ?? null,
      market: normalizePrizePicksMarketKey(normalizedSport,marketKey),
      threshold: outcome.point, availableDirections: [direction], lineType, fetchedAt,
      ...(multiplier == null ? {} : { payoutMultiplier: multiplier }),
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

/** Decimal odds as American odds (2.5 → +150, 1.5 → -200). */
const american = (decimal: number) => Math.round(decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1));

/**
 * The consensus quotes as Edge's fair prices: each book's Over and Under at one number with the vig removed (multiplicative).
 * Market keys follow the Odds API PrizePicks lines' own normalization, so they meet the same lines.
 */
export function consensusFairPrices(quotes: readonly ConsensusQuote[]): import('./context/sharp-props.js').FairPrice[] {
  return quotes.flatMap((quote) => {
    if (!quote.over || !quote.under || quote.sport === 'OTHER') return [];
    const over = 1 / quote.over, under = 1 / quote.under;
    if (over + under < .95) return [];
    return [{ book: quote.book, sport: quote.sport, player: quote.player, market: normalizePrizePicksMarketKey(quote.sport, quote.marketKey),
      line: quote.point, fairOver: Math.round(over / (over + under) * 10_000) / 10_000, overAmerican: american(quote.over),
      underAmerican: american(quote.under), startTime: quote.startTime, home: quote.home, away: quote.away, observedAt: quote.fetchedAt }];
  });
}
