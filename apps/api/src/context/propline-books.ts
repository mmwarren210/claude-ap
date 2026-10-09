import type { Sport } from '@crowniq/contracts';
import { normalizePrizePicksMarketKey } from '../prizepicks-line-types.js';
import { leagueInfo } from '../scrapers/markets.js';
import type { PropLineClient } from '../scrapers/propline.js';
import { proplineLeague } from '../scrapers/propline.js';
import { sharpTypeFor } from './sharp-props.js';

// Sportsbook player-prop prices from PropLine (owner, 2026-10-08: DraftKings, Hard Rock and the line-shopping books all come
// from PropLine). Each PropLine outcome becomes the row shape the sportsbook feed already reads (SharpAPI's), so fair prices,
// over-only props, game totals, the DraftKings/Hard Rock tabs, line shopping, Edge and GKR+ all work unchanged.

/** The books priced for Edge and line shopping: the two book tabs first, then sharp and big books for fair prices. */
export const PROPLINE_PRICE_BOOKS = ['draftkings', 'hardrock', 'fanduel', 'betmgm', 'betrivers', 'fanatics', 'pinnacle', 'bovada',
  'novig', 'prophetx'];

/** PropLine sport keys to the league keys the sportsbook feed maps to CrownIQ sports. */
export function sharpLeagueFor(sportKey: string): string | null {
  const fixed: Readonly<Record<string, string>> = { football_nfl: 'nfl', football_ncaaf: 'ncaaf', baseball_mlb: 'mlb', basketball_nba: 'nba',
    basketball_wnba: 'wnba', hockey_nhl: 'nhl', tennis: 'atp', basketball_ncaab: 'ncaab', mma_ufc: 'ufc',
    soccer_epl: 'england_-_premier_league', soccer_la_liga: 'spain_-_la_liga', soccer_serie_a: 'italy_-_serie_a',
    soccer_bundesliga: 'germany_-_bundesliga', soccer_ligue_1: 'france_-_ligue_1', soccer_mls: 'usa_-_major_league_soccer',
    soccer_uefa_champions_league: 'uefa_-_champions_league', soccer_uefa_europa_league: 'uefa_-_europa_league',
    soccer_eredivisie: 'netherlands_-_eredivisie', soccer_primeira_liga: 'portugal_-_primeira_liga', soccer_liga_mx: 'mexico_-_liga_mx',
    soccer_championship: 'england_-_championship', soccer_brasileirao: 'brazil_-_serie_a', soccer_uefa_nations_league: 'uefa_-_nations_league' };
  if (fixed[sportKey]) return fixed[sportKey]!;
  return sportKey.startsWith('soccer_') ? 'england_-_premier_league' : null;
}

/** PropLine market keys whose CrownIQ key differs by sport (everything else follows the Odds API naming CrownIQ uses). */
function crowniqKey(sport: Sport, key: string): string {
  const shared: Readonly<Record<string, string>> = { player_pass_rush_yds: 'pass_plus_rush_yds', player_rush_reception_yds: 'rush_plus_rec_yds',
    player_longest_completion: 'player_pass_longest_completion', batter_rbis: 'rbis', batter_runs_scored: 'runs', batter_runs: 'runs', batter_singles: 'singles',
    batter_doubles: 'doubles', batter_stolen_bases: 'stolen_bases', pitcher_hits_allowed: 'hits_allowed', pitcher_earned_runs: 'earned_runs',
    pitcher_walks: 'walks_allowed', pitcher_outs: 'pitching_outs', player_aces: 'aces', player_double_faults: 'double_faults',
    player_games_won: 'games_won', player_total_games: 'games_won' };
  const nhl: Readonly<Record<string, string>> = { goalie_saves: 'saves', player_goals: 'goals', player_assists: 'assists', player_saves: 'saves', player_shots: 'shots_on_goal',
    player_blocked_shots: 'blocked_shots', player_power_play_points: 'power_play_points' };
  const soccer: Readonly<Record<string, string>> = { player_shots: 'shots', player_shots_on_target: 'sot', player_goals: 'goals',
    player_assists: 'assists', player_fouls: 'fouls', player_saves: 'goalie_saves', player_goalkeeper_saves: 'goalie_saves' };
  return (sport === 'NHL' ? nhl[key] : sport === 'SOCCER' ? soccer[key] : undefined) ?? shared[key] ?? normalizePrizePicksMarketKey(sport, key);
}

/** Yes/no scorer markets as the feed's anytime-scorer types ("Yes" is the over of 0.5). */
const scorerType = (sport: Sport, key: string) => /anytime_(td|touchdown)/.test(key) && (sport === 'NFL' || sport === 'NCAAFB')
  ? 'anytime_touchdown_scorer' : /anytime_goal/.test(key) && (sport === 'NHL' || sport === 'SOCCER') ? 'anytime_goal_scorer' : null;

const probability = (american: number) => american > 0 ? 100 / (american + 100) : -american / (-american + 100);

interface Outcome { name?: string; description?: string | null; point?: number | null; price?: number | null; last_seen_at?: string | null }
interface Event { id: string | number; home_team?: string | null; away_team?: string | null; commence_time?: string;
  bookmakers?: { key: string; markets?: { key: string; outcomes?: Outcome[] }[] }[] }

/** One event's outcomes as feed rows; game totals separately. Unmapped market keys are counted, never guessed. */
export function proplineRows(event: Event, sportKey: string, unmapped: Map<string, number>): { rows: unknown[]; gameRows: unknown[] } {
  const league = sharpLeagueFor(sportKey), sport = leagueInfo(proplineLeague(sportKey)).sport;
  if (!league) return { rows: [], gameRows: [] };
  const rows: unknown[] = [], gameRows: unknown[] = [];
  const totalType = sport === 'NHL' ? 'total_goals' : sport === 'NFL' || sport === 'NCAAFB' ? 'total_points' : sport === 'TENNIS' ? 'total_games' : null;
  for (const book of event.bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      const base = { sportsbook: book.key, league, sport: sport.toLowerCase(), event_id: `propline:${event.id}`,
        event_start_time: event.commence_time, home_team: event.home_team ?? null, away_team: event.away_team ?? null,
        is_live: false, is_active: true, is_pickem: false, is_stale_pregame_price: false };
      if (market.key === 'totals') {
        if (!totalType) continue;
        for (const outcome of market.outcomes ?? []) {
          if (typeof outcome.price !== 'number' || typeof outcome.point !== 'number') continue;
          gameRows.push({ ...base, market_type: totalType, selection_type: String(outcome.name).toLowerCase(), line: outcome.point,
            odds_american: outcome.price, odds_probability: probability(outcome.price), timestamp: outcome.last_seen_at ?? null });
        }
        continue;
      }
      const type = scorerType(sport, market.key) ?? sharpTypeFor(sport, crowniqKey(sport, market.key));
      if (!type) { unmapped.set(`${sport}:${market.key}`, (unmapped.get(`${sport}:${market.key}`) ?? 0) + 1); continue; }
      for (const outcome of market.outcomes ?? []) {
        const player = outcome.description?.trim();
        if (!player || typeof outcome.price !== 'number' || !Number.isFinite(outcome.price) || outcome.price === 0) continue;
        rows.push({ ...base, market_type: type, selection_type: String(outcome.name).toLowerCase(), line: outcome.point ?? null,
          player_name: player, odds_american: outcome.price, odds_probability: probability(outcome.price),
          timestamp: outcome.last_seen_at ?? null });
      }
    }
  }
  return { rows, gameRows };
}

/** The last good answer per sport and market chunk, so a chunk that fails keeps its prices instead of emptying them. */
export type PropLineRowMemory = Map<string, { at: number; rows: unknown[]; gameRows: unknown[] }>;

/**
 * Every discovered sport's prop markets for the price books, as feed rows (a few bulk requests per sport). A chunk that
 * fails is tried once more; if it still fails, its last good rows (up to 2 hours old) stand in, so one slow answer never
 * leaves Edge without book prices.
 */
export async function fetchPropLineRows(client: PropLineClient, books: readonly string[] = PROPLINE_PRICE_BOOKS,
  memory: PropLineRowMemory | null = null, clock: () => number = Date.now):
  Promise<{ rows: unknown[]; gameRows: unknown[]; failed: string[]; unmapped: Record<string, number>; requests: number; reused?: number }> {
  const before = client.requests, failed: string[] = [];
  const markets = await client.propMarkets(failed);
  const rows: unknown[] = [], gameRows: unknown[] = [], unmapped = new Map<string, number>();
  let reused = 0;
  const add = (part: { rows: unknown[]; gameRows: unknown[] }) => {
    for (const row of part.rows) rows.push(row);
    for (const row of part.gameRows) gameRows.push(row);
  };
  await Promise.all([...markets].map(async ([sportKey, keys]) => {
    if (!sharpLeagueFor(sportKey)) return;
    const wanted = [...keys, 'totals'];
    for (let index = 0; index < wanted.length; index += 15) {
      const chunk = wanted.slice(index, index + 15), key = `${sportKey}|${chunk.join(',')}`;
      const path = `/v1/sports/${sportKey}/odds?markets=${chunk.join(',')}&bookmakers=${books.join(',')}`;
      const body = await client.get<unknown>(path).catch(() => client.get<unknown>(path)).catch(() => undefined);
      if (body === undefined) {
        failed.push(`${sportKey}:${index / 15}`);
        const last = memory?.get(key);
        if (last && clock() - last.at < 2 * 3600_000) { add(last); reused++; }
        continue;
      }
      const part = { rows: [] as unknown[], gameRows: [] as unknown[] };
      for (const event of Array.isArray(body) ? body as Event[] : []) { const out = proplineRows(event, sportKey, unmapped);
        for (const row of out.rows) part.rows.push(row);
        for (const row of out.gameRows) part.gameRows.push(row); }
      memory?.set(key, { at: clock(), ...part });
      add(part);
    }
  }));
  return { rows, gameRows, failed, unmapped: Object.fromEntries([...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 25)),
    requests: client.requests - before, ...(memory ? { reused } : {}) };
}
