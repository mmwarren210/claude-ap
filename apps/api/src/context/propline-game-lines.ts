import type { PropLineClient } from '../scrapers/propline.js';
import { proplineLeague } from '../scrapers/propline.js';
import type { GameLine } from './feeds.js';

// Game lines (moneyline, spread, total) from PropLine (owner, 2026-10-09: replaces the Apify Pinnacle feed). Pinnacle first,
// then DraftKings and FanDuel where Pinnacle has no price. One request per sport with props, kept 30 minutes. Display and
// game-environment context only (game script, player page, Edge's game environment).

type Outcome = { name?: string; price?: number | null; point?: number | null };
type Event = { home_team?: string | null; away_team?: string | null; commence_time?: string;
  bookmakers?: { key: string; markets?: { key: string; outcomes?: Outcome[] }[] }[] };

const PREFERRED = ['pinnacle', 'draftkings', 'fanduel'];
const implied = (american: number) => american > 0 ? 100 / (american + 100) : -american / (-american + 100);

/** One event's game lines from the first book (Pinnacle first) that prices each market. */
export function eventGameLines(event: Event, league: string): GameLine[] {
  const home = event.home_team?.trim(), away = event.away_team?.trim(), start = event.commence_time;
  if (!home || !away || !start) return [];
  const books = [...(event.bookmakers ?? [])].sort((a, b) => PREFERRED.indexOf(a.key) - PREFERRED.indexOf(b.key));
  const out: GameLine[] = [];
  for (const [key, market] of [['h2h', 'moneyline'], ['spreads', 'spread'], ['totals', 'total']] as const) {
    for (const book of books) {
      const outcomes = book.markets?.find((item) => item.key === key)?.outcomes ?? [];
      // Moneyline and spread list each team; the total lists Over (read as "home") and Under ("away").
      const first = key === 'totals' ? outcomes.find((item) => /^over$/i.test(item.name ?? '')) : outcomes.find((item) => item.name === home);
      const second = key === 'totals' ? outcomes.find((item) => /^under$/i.test(item.name ?? '')) : outcomes.find((item) => item.name === away);
      if (typeof first?.price !== 'number' || typeof second?.price !== 'number') continue;
      const a = implied(first.price), b = implied(second.price);
      out.push({ league, home, away, startTime: new Date(start).toISOString(), market,
        line: key === 'h2h' ? null : typeof first.point === 'number' ? first.point : null,
        homePrice: first.price, awayPrice: second.price, homeFair: a / (a + b), awayFair: b / (a + b), sourceUrl: null });
      break;
    }
  }
  return out;
}

/** Every sport's game lines, refreshed at most every 30 minutes (a failed sport keeps its last lines). */
export function proplineGameLines(client: PropLineClient, ttlMs = 30 * 60_000, clock: () => number = Date.now): () => Promise<GameLine[]> {
  let cached: { at: number; lines: GameLine[] } | null = null;
  let loading: Promise<GameLine[]> | null = null;
  const bySport = new Map<string, GameLine[]>();
  return async () => {
    if (cached && clock() - cached.at < ttlMs) return cached.lines;
    loading ??= (async () => {
      const sports = await client.propMarkets([]).catch(() => new Map<string, string[]>());
      await Promise.all([...sports.keys()].map(async (sportKey) => {
        try {
          const body = await client.get<unknown>(`/v1/sports/${sportKey}/odds?markets=h2h,spreads,totals&bookmakers=${PREFERRED.join(',')}`);
          const events = Array.isArray(body) ? body as Event[] : [];
          bySport.set(sportKey, events.flatMap((event) => eventGameLines(event, proplineLeague(sportKey))));
        } catch { /* keep this sport's last lines */ }
      }));
      cached = { at: clock(), lines: [...bySport.values()].flat() };
      return cached.lines;
    })().finally(() => { loading = null; });
    return loading;
  };
}
