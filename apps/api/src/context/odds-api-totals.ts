import type { GamePrice } from './sharp-props.js';

// Football game totals from The Odds API, for the anytime-TD prices SharpAPI can't scale: it posts totals only a few days
// out, so most of next Sunday's games had TD prices and no total (26 of 65 groups on 2026-10-07). One request per sport
// (the totals market, one region) costs 1 credit and returns every listed game; it is asked at most hourly.
// SharpAPI's own totals win where both exist (the scorer lookup reads them last).

const SPORTS: readonly [string, string][] = [['americanfootball_nfl', 'nfl'], ['americanfootball_ncaaf', 'ncaaf']];
const HOUR = 3600_000;

type Outcome = { name?: string; price?: number; point?: number };
type Event = { id?: string; commence_time?: string; home_team?: string; away_team?: string;
  bookmakers?: { key?: string; markets?: { key?: string; outcomes?: Outcome[] }[] }[] };

/** One event list as GamePrice total rows (both sides, the raw implied chance; the scorer removes the cut). */
export function totalsFromOdds(events: readonly Event[], league: string): GamePrice[] {
  const out: GamePrice[] = [];
  for (const event of events) {
    if (!event.id || !event.home_team || !event.away_team || !event.commence_time) continue;
    for (const book of event.bookmakers ?? []) for (const market of book.markets ?? []) {
      if (market.key !== 'totals') continue;
      for (const outcome of market.outcomes ?? []) {
        const side = outcome.name === 'Over' ? 'over' : outcome.name === 'Under' ? 'under' : null;
        if (!side || !(Number(outcome.price) > 1) || !Number.isFinite(outcome.point)) continue;
        out.push({ book: `odds-api:${book.key ?? '?'}`, league, sport: league === 'nfl' ? 'NFL' : 'NCAAFB', eventId: `odds-api:${event.id}`,
          home: event.home_team, away: event.away_team, startTime: event.commence_time, market: 'total', line: outcome.point!,
          side, probability: 1 / outcome.price!, american: null });
      }
    }
  }
  return out;
}

export class OddsApiTotals {
  private cached: { at: number; games: GamePrice[] } | null = null;
  private loading: Promise<GamePrice[]> | null = null;
  constructor(private readonly apiKey: string | null, private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date()) {}

  /** The latest football totals; refetched when an hour old. A failed sport keeps whatever else came back. */
  async games(): Promise<GamePrice[]> {
    if (!this.apiKey) return [];
    if (this.cached && this.clock().getTime() - this.cached.at < HOUR) return this.cached.games;
    this.loading ??= this.fetchAll().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async fetchAll(): Promise<GamePrice[]> {
    const games: GamePrice[] = [];
    let remaining: string | null = null;
    for (const [sport, league] of SPORTS) {
      try {
        const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?${new URLSearchParams({ apiKey: this.apiKey!,
          regions: 'us', markets: 'totals', oddsFormat: 'decimal' })}`;
        const response = await this.fetchFn(url, { signal: AbortSignal.timeout(20_000) });
        remaining = response.headers.get('x-requests-remaining') ?? remaining;
        if (!response.ok) { console.warn(`[odds-totals] ${sport} HTTP ${response.status}`); continue; }
        games.push(...totalsFromOdds(await response.json() as Event[], league));
      } catch (error) { console.warn(`[odds-totals] ${sport} failed`, error instanceof Error ? error.message : error); }
    }
    console.log(`[odds-totals] ${new Set(games.map((game) => game.eventId)).size} football games with totals; ${remaining ?? '?'} credits left`);
    this.cached = { at: this.clock().getTime(), games };
    return games;
  }
}
