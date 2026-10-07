import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Edge 2.0 data check (spec §1.1b): does The Odds API return Underdog and DK Pick6 lines with payout multipliers? One
// event-odds call per sport (one market, three DFS books = one region, about 1 credit each), once per data disk: the
// result is saved and logged as `[edge-probe]`, never the key or the request URL.

type Outcome = { name?: string; description?: string; point?: number; multiplier?: number | null };
type Book = { key: string; markets?: { key: string; outcomes?: Outcome[] }[] };

export type ProbeBook = { key: string; outcomes: number; withPoint: number; withMultiplier: number; multipliers: number[] };
export type ProbeResult = { sport: string; market: string; eventId: string | null; status: number | null;
  creditsLast: number | null; creditsRemaining: number | null; books: ProbeBook[]; error?: string };

/** Counts per bookmaker in one event-odds response. */
export function summarizeBooks(books: readonly Book[], wanted: readonly string[]): ProbeBook[] {
  return wanted.map((key) => {
    const outcomes = books.filter((book) => book.key === key).flatMap((book) => book.markets ?? []).flatMap((market) => market.outcomes ?? []);
    const multipliers = outcomes.flatMap((outcome) => typeof outcome.multiplier === 'number' ? [outcome.multiplier] : []);
    return { key, outcomes: outcomes.length, withPoint: outcomes.filter((outcome) => typeof outcome.point === 'number').length,
      withMultiplier: multipliers.length, multipliers: [...new Set(multipliers)].sort((a, b) => a - b).slice(0, 12) };
  });
}

const BOOKS = ['prizepicks', 'underdog', 'pick6'];
const SPORTS: readonly [string, string][] = [['americanfootball_nfl', 'player_receptions'], ['baseball_mlb', 'batter_hits']];

/**
 * Step 2a and 5b checks, once per data disk: Pinnacle player props (NFL, MLB), AFL disposals and goals, and the soccer
 * shots, shots on target and anytime scorer markets PrizePicks carries, at the US books CrownIQ would ask for.
 */
export const PROBES_V2: readonly { sport: string; markets: string; books: readonly string[] }[] = [
  { sport: 'americanfootball_nfl', markets: 'player_receptions', books: ['pinnacle'] },
  { sport: 'baseball_mlb', markets: 'batter_hits', books: ['pinnacle'] },
  { sport: 'aussierules_afl', markets: 'player_disposals,player_goals_scored_over', books: ['pinnacle', 'sportsbet', 'tab', 'betr_au', 'draftkings', 'fanduel'] },
  { sport: 'soccer_epl', markets: 'player_shots,player_shots_on_target,player_goal_scorer_anytime', books: ['pinnacle', 'fanduel', 'draftkings', 'betmgm', 'williamhill_us'] },
];

export async function probeOddsApi(apiKey: string, fetchFn: typeof fetch = fetch, now = () => Date.now(),
  probes: readonly { sport: string; markets: string; books: readonly string[] }[] = SPORTS.map(([sport, markets]) => ({ sport, markets, books: BOOKS }))): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const { sport, markets: market, books } of probes) {
    const result: ProbeResult = { sport, market, eventId: null, status: null, creditsLast: null, creditsRemaining: null, books: [] };
    try {
      const events = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/events`);
      events.searchParams.set('apiKey', apiKey);
      const listed = await fetchFn(events, { signal: AbortSignal.timeout(15_000) });
      const rows = listed.ok ? await listed.json() as { id: string; commence_time: string }[] : [];
      const next = rows.filter((row) => Date.parse(row.commence_time) > now() + 30 * 60_000)
        .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time))[0];
      if (!next) { result.error = listed.ok ? 'NO_UPCOMING_EVENT' : `EVENTS_HTTP_${listed.status}`; results.push(result); continue; }
      result.eventId = next.id;
      const odds = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/events/${encodeURIComponent(next.id)}/odds`);
      odds.searchParams.set('apiKey', apiKey);
      odds.searchParams.set('bookmakers', books.join(','));
      odds.searchParams.set('markets', market);
      odds.searchParams.set('includeMultipliers', 'true');
      odds.searchParams.set('oddsFormat', 'decimal');
      const response = await fetchFn(odds, { signal: AbortSignal.timeout(15_000) });
      result.status = response.status;
      const header = (name: string) => { const value = Number(response.headers.get(name)); return response.headers.has(name) && Number.isFinite(value) ? value : null; };
      result.creditsLast = header('x-requests-last'); result.creditsRemaining = header('x-requests-remaining');
      const body = response.ok ? await response.json() as { bookmakers?: Book[] } : null;
      result.books = summarizeBooks(body?.bookmakers ?? [], books);
    } catch (error) { result.error = error instanceof Error ? error.message.slice(0, 80) : 'FAILED'; }
    results.push(result);
  }
  return results;
}

/** Runs the probe once per data disk (the saved file marks it done). */
export async function probeOddsApiOnce(apiKey: string | undefined, file: string,
  probes?: readonly { sport: string; markets: string; books: readonly string[] }[]): Promise<void> {
  if (!apiKey?.trim() || existsSync(file)) return;
  const results = await probeOddsApi(apiKey.trim(), fetch, () => Date.now(), probes);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  for (const result of results) console.log(`[edge-probe] ${JSON.stringify(result)}`);
}
