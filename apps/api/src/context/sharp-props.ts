import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Sport } from '@crowniq/contracts';
import { normalizedName } from './match.js';

// Sportsbook player-prop prices (DraftKings, Hard Rock) from SharpAPI, used as reference odds and for CrownIQ's own +EV.
// Reference only: nothing here feeds GKR scoring.

const API = 'https://api.sharpapi.io/api/v1';
const soccerLeagues = ['england_-_premier_league', 'spain_-_la_liga', 'uefa_-_champions_league', 'germany_-_bundesliga',
  'italy_-_serie_a', 'france_-_ligue_1', 'usa_-_major_league_soccer', 'uefa_-_europa_league', 'uefa_-_nations_league',
  'brazil_-_serie_a', 'netherlands_-_eredivisie', 'portugal_-_primeira_liga', 'mexico_-_liga_mx', 'england_-_championship'];
const leagueSports: Readonly<Record<string, Sport>> = { nfl: 'NFL', ncaaf: 'NCAAFB', mlb: 'MLB', nba: 'NBA', wnba: 'WNBA',
  nhl: 'NHL', atp: 'TENNIS', wta: 'TENNIS', atp_challenger: 'TENNIS', ncaab: 'NCAAB', ncaaw: 'NCAAW', euroleague: 'EUROLEAGUE',
  nba_cup: 'NBA', kbo: 'KBO', ufc: 'OTHER', ...Object.fromEntries(soccerLeagues.map((league) => [league, 'SOCCER' as Sport])) };
/**
 * Every league pulled by default (CROWNIQ_SHARP_LEAGUES overrides). College basketball has no props until November; its
 * leagues stay in the list and start on their own when SharpAPI lists them.
 */
export const sharpLeagues: readonly string[] = ['nfl', 'ncaaf', 'mlb', 'nba', 'wnba', 'nhl', 'atp', 'wta', 'atp_challenger',
  'ncaab', 'ncaaw', 'euroleague', 'nba_cup', 'kbo', 'ufc', ...soccerLeagues];

const basketball: Readonly<Record<string, string>> = { player_points: 'player_points', player_rebounds: 'player_rebounds',
  player_assists: 'player_assists', player_made_threes: 'player_threes',
  'player_points_+_rebounds_+_assists': 'player_points_rebounds_assists', 'player_points_+_rebounds': 'player_points_rebounds',
  'player_points_+_assists': 'player_points_assists', 'player_rebounds_+_assists': 'player_rebounds_assists' };
/** SharpAPI market types to CrownIQ market keys. Only exact, unambiguous matches; anything else is left out. */
const marketKeys: Readonly<Partial<Record<Sport, Readonly<Record<string, string>>>>> = {
  NFL: { player_passing_yards: 'passing_yards', player_passing_attempts: 'player_pass_attempts',
    player_passing_completions: 'player_pass_completions', player_passing_touchdowns: 'player_pass_tds',
    player_rushing_yards: 'player_rush_yds', player_rushing_attempts: 'player_rush_attempts',
    player_receiving_yards: 'player_reception_yds', player_receptions: 'player_receptions',
    player_kicking_points: 'player_kicking_points', player_sacks: 'player_sacks',
    'player_tackles_+_assists': 'player_tackles_assists', 'player_passing_+_rushing_yards': 'pass_plus_rush_yds',
    'player_rushing_+_receiving_yards': 'rush_plus_rec_yds', player_longest_reception: 'player_reception_longest',
    player_longest_rush: 'player_rush_longest', player_longest_passing_completion: 'player_pass_longest_completion' },
  NCAAFB: { player_passing_yards: 'passing_yards', player_rushing_yards: 'player_rush_yds',
    player_receiving_yards: 'player_reception_yds', player_receptions: 'player_receptions',
    'player_passing_+_rushing_yards': 'pass_plus_rush_yds', player_passing_touchdowns: 'player_pass_tds',
    player_passing_attempts: 'player_pass_attempts', player_passing_completions: 'player_pass_completions',
    player_rushing_attempts: 'player_rush_attempts', player_longest_reception: 'player_reception_longest',
    player_longest_rush: 'player_rush_longest' },
  MLB: { player_hits: 'batter_hits', 'player_hits_+_runs_+_rbis': 'batter_hits_runs_rbis', player_home_runs: 'batter_home_runs',
    player_total_bases: 'batter_total_bases', player_walks: 'batter_walks', player_rbis: 'rbis', player_runs: 'runs',
    player_strikeouts: 'pitcher_strikeouts', player_singles: 'singles', player_doubles: 'doubles',
    player_stolen_bases: 'stolen_bases', player_hits_allowed: 'hits_allowed', player_earned_runs: 'earned_runs',
    player_walks_allowed: 'walks_allowed', player_pitching_outs: 'pitching_outs' },
  NBA: basketball, WNBA: basketball, NCAAB: basketball, NCAAW: basketball, EUROLEAGUE: basketball,
  NHL: { player_shots_on_goal: 'shots_on_goal', player_points: 'points', player_saves: 'saves', player_assists: 'assists',
    player_goals: 'goals', player_blocked_shots: 'blocked_shots', player_power_play_points: 'power_play_points',
    anytime_goal_scorer: 'goals', player_shots: 'shots_on_goal' },
  // Hard Rock's "player total games" is the games that player wins (market "team_total", lines 7.5–13.5), the same stat as
  // DraftKings' "games won"; DraftKings' own "player total games" (4.5, 7.5) is a set stat and is left out (bookMarket).
  TENNIS: { player_total_games: 'games_won', player_games_won: 'games_won', player_aces: 'aces',
    player_double_faults: 'double_faults' },
  SOCCER: { player_shots: 'shots', player_shots_on_target: 'sot', player_assists: 'assists', player_goals: 'goals',
    player_fouls: 'fouls', player_saves: 'goalie_saves' },
};

/** The full-game player-prop market types CrownIQ reads for a sport (step 1d), plus the anytime-scorer markets. */
export function fullGameTypes(sport: Sport | undefined): string[] {
  if (!sport) return [];
  const scorer = sport === 'NHL' || sport === 'SOCCER' ? ['anytime_goal_scorer'] : sport === 'NFL' || sport === 'NCAAFB' ? ['anytime_touchdown_scorer'] : [];
  // NHL "player_shots" is shots on goal (4e, confirmed 2026-10-07: median gap 0 across 18 players); the audit keeps checking.
  return [...Object.keys(marketKeys[sport] ?? {}), ...scorer];
}

/**
 * Step 4e: whether NHL "player_shots" means shots on goal. For each player both are listed for, the gap between the two
 * markets' main numbers; a median near 0 means the same stat (mapped once confirmed in the log).
 */
export function shotsAudit(rows: readonly unknown[]): { players: number; medianGap: number | null; sample: string[] } {
  const lines = new Map<string, { shots: number[]; sog: number[] }>();
  for (const value of rows) {
    const row = value as Row;
    if (leagueSports[String(row.league)] !== 'NHL' || typeof row.line !== 'number' || typeof row.player_name !== 'string' || row.selection_type !== 'over') continue;
    const kind = row.market_type === 'player_shots' ? 'shots' : row.market_type === 'player_shots_on_goal' ? 'sog' : null;
    if (!kind) continue;
    const entry = lines.get(normalizedName(row.player_name)) ?? { shots: [], sog: [] };
    entry[kind].push(row.line); lines.set(normalizedName(row.player_name), entry);
  }
  const middle = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const gaps = [...lines].filter(([, entry]) => entry.shots.length && entry.sog.length)
    .map(([player, entry]) => ({ player, gap: middle(entry.shots) - middle(entry.sog), shots: middle(entry.shots), sog: middle(entry.sog) }));
  return { players: gaps.length, medianGap: gaps.length ? middle(gaps.map((item) => item.gap)) : null,
    sample: gaps.slice(0, 5).map((item) => `${item.player} shots ${item.shots} / SOG ${item.sog}`) };
}

/** Partial-game (1st half, quarter, period) market types, read in their own pass (step 4c fills these in). */
export function partialTypes(sport: Sport | undefined): string[] {
  return sport ? Object.keys(partialKeys[sport] ?? {}) : [];
}

/** SharpAPI partial-game market types to CrownIQ keys; the segment stays in the key (step 4c). */
const partialKeys: Readonly<Partial<Record<Sport, Readonly<Record<string, string>>>>> = Object.fromEntries(
  (['NFL', 'NCAAFB', 'NBA', 'WNBA', 'NCAAB', 'NCAAW', 'NHL'] as const).map((sport) => [sport, Object.fromEntries(
    Object.entries(marketKeys[sport] ?? {}).flatMap(([type, key]) => sport === 'NHL'
      ? [[`1st_period_${type}`, `1p_${key}`]] : [[`1st_half_${type}`, `1h_${key}`], [`1st_quarter_${type}`, `1q_${key}`]]))]));

/** Yes/no scorer markets: "Yes" is the over of 0.5 (one or more), "No" the under. */
const scorerMarkets = new Set(['anytime_goal_scorer', 'anytime_touchdown_scorer']);

/**
 * Turns a yes/no scorer row (audit 2026-10-06: NHL goals were unpriced because books list them only as "anytime goal scorer")
 * into the over/under of 0.5 every other function reads. Other rows pass through unchanged.
 */
export function normalizeRow(value: unknown): unknown {
  const row = value as Row;
  if (!scorerMarkets.has(String(row.market_type))) return value;
  const side = String(row.selection_type).toLowerCase();
  const selection = side === 'yes' || side === 'over' ? 'over' : side === 'no' || side === 'under' ? 'under' : null;
  if (!selection || (row.line !== null && row.line !== undefined && row.line !== 0.5)) return value;
  return { ...row, selection_type: selection, line: 0.5 };
}

/** A row's CrownIQ market key, with the few book-specific exceptions (see TENNIS above). */
function bookMarket(sport: Sport, book: string, type: string): string | undefined {
  if (sport === 'TENNIS' && type === 'player_total_games' && book !== 'hardrock') return undefined;
  // Market audit (2026-10-06, MARKET_MISMATCH samples): FanDuel's "rebounds + assists" carries points+rebounds+assists numbers
  // (A'ja Wilson 37.5) and DraftKings' "walks allowed" carries strikeout numbers (Chris Sale 7.5). Both are left out.
  if (book === 'fanduel' && type === 'player_rebounds_+_assists') return undefined;
  if (book === 'draftkings' && sport === 'MLB' && type === 'player_walks_allowed') return undefined;
  return marketKeys[sport]?.[type] ?? partialKeys[sport]?.[type];
}

/** One book's de-vigged price for one player, stat and number. */
export interface FairPrice {
  readonly book: string; readonly sport: Sport; readonly player: string; readonly market: string; readonly line: number;
  /** The book's no-vig chance the stat goes over the number, 0–1. */
  readonly fairOver: number;
  readonly overAmerican: number | null; readonly underAmerican: number | null;
  readonly startTime: string; readonly home: string | null; readonly away: string | null;
  /** SharpAPI marks a pregame price it hasn't seen move with the market as stale; when it last saw the price. */
  readonly stale?: boolean; readonly observedAt?: string;
}

interface Row {
  sportsbook?: unknown; league?: unknown; market_type?: unknown; selection_type?: unknown; line?: unknown;
  odds_probability?: unknown; odds_american?: unknown; player_name?: unknown; event_start_time?: unknown;
  home_team?: unknown; away_team?: unknown; is_live?: unknown; is_active?: unknown; event_id?: unknown;
  is_pickem?: unknown; is_alternate_line?: unknown; is_stale_pregame_price?: unknown; timestamp?: unknown;
}

/** Pick'em apps' rows (PrizePicks, PrizePicks Flex): their price is the app's payout, not a market, so they never count as
 * a sportsbook price. */
export const isPickemRow = (value: unknown) => {
  const row = value as Row;
  return row.is_pickem === true || /^(prizepicks|underdog|pick6|sleeper|dabble|betr)/.test(String(row.sportsbook));
};

/** One pick'em line from SharpAPI (PrizePicks): the number, which sides are offered, and the app's payout price. */
export interface PickemLine {
  readonly book: string; readonly league: string; readonly sport: Sport | null; readonly eventId: string;
  readonly home: string | null; readonly away: string | null; readonly startTime: string; readonly player: string;
  /** SharpAPI's market type, and CrownIQ's market key when it maps exactly. */
  readonly marketType: string; readonly market: string | null; readonly line: number;
  readonly sides: readonly ('MORE' | 'LESS')[]; readonly american: number | null;
  readonly alternate: boolean; readonly stale: boolean; readonly observedAt: string | null;
}

/** SharpAPI's pick'em rows joined into one line per book, player, market and number. */
export function pickemLines(rows: readonly unknown[]): PickemLine[] {
  const lines = new Map<string, PickemLine>();
  for (const value of rows) {
    const row = value as Row;
    if (!isPickemRow(row) || row.is_live === true || row.is_active === false || typeof row.line !== 'number' ||
      typeof row.player_name !== 'string' || (row.selection_type !== 'over' && row.selection_type !== 'under')) continue;
    const sport = leagueSports[String(row.league)] ?? null;
    const key = JSON.stringify([row.sportsbook, row.event_id, normalizedName(row.player_name), row.market_type, row.line]);
    const side = row.selection_type === 'over' ? 'MORE' as const : 'LESS' as const;
    const existing = lines.get(key);
    if (existing) { if (!existing.sides.includes(side)) lines.set(key, { ...existing, sides: [...existing.sides, side].sort() }); continue; }
    lines.set(key, { book: String(row.sportsbook), league: String(row.league), sport, eventId: String(row.event_id),
      home: typeof row.home_team === 'string' ? row.home_team : null, away: typeof row.away_team === 'string' ? row.away_team : null,
      startTime: String(row.event_start_time), player: row.player_name, marketType: String(row.market_type),
      market: sport ? bookMarket(sport, String(row.sportsbook), String(row.market_type)) ?? null : null, line: row.line,
      sides: [side], american: typeof row.odds_american === 'number' ? row.odds_american : null,
      alternate: row.is_alternate_line === true, stale: row.is_stale_pregame_price === true,
      observedAt: typeof row.timestamp === 'string' ? row.timestamp : null });
  }
  return [...lines.values()];
}

/** Pairs each book's Over and Under at the same number and removes the vig: fair over = p(over) / (p(over) + p(under)). */
export function fairPrices(rows: readonly unknown[]): FairPrice[] {
  const pairs = new Map<string, { over?: Row; under?: Row }>();
  for (const value of rows) {
    const row = value as Row;
    const sport = leagueSports[String(row.league)], market = sport ? bookMarket(sport, String(row.sportsbook), String(row.market_type)) : undefined;
    if (!sport || !market || row.is_live === true || row.is_active === false || typeof row.line !== 'number' ||
      typeof row.player_name !== 'string' || (row.selection_type !== 'over' && row.selection_type !== 'under')) continue;
    const key = JSON.stringify([row.sportsbook, row.event_id, normalizedName(row.player_name), market, row.line]);
    const pair = pairs.get(key) ?? {};
    pair[row.selection_type] = row;
    pairs.set(key, pair);
  }
  const prices: FairPrice[] = [];
  for (const { over, under } of pairs.values()) {
    const pOver = Number(over?.odds_probability), pUnder = Number(under?.odds_probability);
    if (!over || !under || !(pOver > 0) || !(pUnder > 0) || pOver + pUnder < 0.95) continue;
    const sport = leagueSports[String(over.league)]!;
    prices.push({ book: String(over.sportsbook), sport, player: String(over.player_name), market: bookMarket(sport, String(over.sportsbook), String(over.market_type))!,
      line: over.line as number, fairOver: Math.round(pOver / (pOver + pUnder) * 10_000) / 10_000,
      overAmerican: typeof over.odds_american === 'number' ? over.odds_american : null,
      underAmerican: typeof under.odds_american === 'number' ? under.odds_american : null,
      startTime: String(over.event_start_time), home: typeof over.home_team === 'string' ? over.home_team : null,
      away: typeof over.away_team === 'string' ? over.away_team : null,
      ...(over.is_stale_pregame_price === true || under.is_stale_pregame_price === true ? { stale: true } : {}),
      ...(typeof over.timestamp === 'string' ? { observedAt: over.timestamp } : {}) });
  }
  return prices;
}

/** A one-sided price (an over with no under at the same number): the price is the chance it implies. */
export interface OverOnlyPrice {
  readonly book: string; readonly sport: Sport; readonly player: string; readonly market: string; readonly line: number;
  readonly price: number; readonly american: number | null; readonly startTime: string;
  readonly home: string | null; readonly away: string | null;
}
/** One side of a full-game line (winner, spread or total) from a book or exchange. */
export interface GamePrice {
  readonly book: string; readonly league: string; readonly sport: string; readonly eventId: string;
  readonly home: string; readonly away: string; readonly startTime: string;
  readonly market: 'moneyline' | 'spread' | 'total'; readonly line: number | null;
  readonly side: 'home' | 'away' | 'over' | 'under'; readonly probability: number; readonly american: number | null;
}

const gameMarkets: Readonly<Record<string, GamePrice['market']>> = { moneyline: 'moneyline', point_spread: 'spread',
  total_points: 'total', total_runs: 'total', total_goals: 'total', total_games: 'total' };
export const gameMarketTypes = Object.keys(gameMarkets);

/**
 * Over-only player props: any book's over with no under at the same number (DraftKings'
 * soccer shots), so there's no cut to remove. History can still read them.
 */
export function overOnlyPrices(rows: readonly unknown[]): OverOnlyPrice[] {
  const out: OverOnlyPrice[] = [];
  const key = (row: Row) => JSON.stringify([row.sportsbook, row.event_id, String(row.player_name ?? ''), row.market_type, row.line]);
  const unders = new Set(rows.filter((value) => (value as Row).selection_type === 'under').map((value) => key(value as Row)));
  for (const value of rows) {
    const row = value as Row;
    const sport = leagueSports[String(row.league)], market = sport ? bookMarket(sport, String(row.sportsbook), String(row.market_type)) : undefined;
    const price = Number(row.odds_probability);
    if (!sport || !market || unders.has(key(row)) || row.selection_type !== 'over' || row.is_live === true ||
      row.is_active === false || typeof row.line !== 'number' || typeof row.player_name !== 'string' || !(price > 0 && price < 1)) continue;
    out.push({ book: String(row.sportsbook), sport, player: row.player_name, market, line: row.line, price,
      american: typeof row.odds_american === 'number' ? row.odds_american : null, startTime: String(row.event_start_time),
      home: typeof row.home_team === 'string' ? row.home_team : null, away: typeof row.away_team === 'string' ? row.away_team : null });
  }
  return out;
}

/** Full-game winner, spread and total sides (no halves, quarters or 3-way lines). */
export function gamePrices(rows: readonly unknown[]): GamePrice[] {
  const out: GamePrice[] = [];
  for (const value of rows) {
    const row = value as Row & { sport?: unknown; selection_type?: unknown };
    const market = gameMarkets[String(row.market_type)], side = String(row.selection_type), probability = Number(row.odds_probability);
    if (!market || row.is_live === true || row.is_active === false || !(probability > 0 && probability < 1) ||
      (row as { is_stale_pregame_price?: unknown }).is_stale_pregame_price === true ||
      typeof row.home_team !== 'string' || typeof row.away_team !== 'string') continue;
    if (market === 'total' ? side !== 'over' && side !== 'under' : side !== 'home' && side !== 'away') continue;
    if (market !== 'moneyline' && typeof row.line !== 'number') continue;
    // Soccer winners have a draw: a two-way fair price would be wrong, so they're left out (spreads and totals stay).
    if (market === 'moneyline' && String(row.sport) === 'soccer') continue;
    out.push({ book: String(row.sportsbook), league: String(row.league), sport: String(row.sport ?? ''), eventId: String(row.event_id),
      home: row.home_team, away: row.away_team, startTime: String(row.event_start_time), market,
      line: market === 'moneyline' ? null : row.line as number, side: side as GamePrice['side'], probability,
      american: typeof row.odds_american === 'number' ? row.odds_american : null });
  }
  return out;
}

/** P(N > line) for a Poisson count with mean `mean` (line is x.5). */
function poissonOver(mean: number, line: number): number {
  let term = Math.exp(-mean), cdf = term;
  for (let k = 1; k <= Math.floor(line); k++) { term *= mean / k; cdf += term; }
  return 1 - cdf;
}

/** Each event's expected total goals: the median, over books, of the Poisson mean that fits the book's no-vig total. */
export function expectedGoals(games: readonly GamePrice[]): Map<string, number> {
  const sides = new Map<string, { over?: number; under?: number; line: number; event: string }>();
  for (const game of games) {
    if (game.market !== 'total' || game.line === null) continue;
    const key = `${game.book}|${game.eventId}|${game.line}`;
    const entry = sides.get(key) ?? { line: game.line, event: game.eventId };
    entry[game.side as 'over' | 'under'] = game.probability; sides.set(key, entry);
  }
  const means = new Map<string, number[]>();
  for (const { over, under, line, event } of sides.values()) {
    if (!over || !under || line % 1 === 0) continue;
    const target = over / (over + under);
    let lo = 0.05, hi = 20;
    for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (poissonOver(mid, line) < target) lo = mid; else hi = mid; }
    means.set(event, [...(means.get(event) ?? []), (lo + hi) / 2]);
  }
  return new Map([...means].map(([event, list]) => { const sorted = list.sort((a, b) => a - b); return [event, sorted[Math.floor(sorted.length / 2)]!]; }));
}

/**
 * Anytime goal scorer (NHL) and anytime touchdown scorer (NFL, college). SharpAPI sends one "Yes" price per player (selection "other", no line) and no "No"
 * side, so the book's cut can't be removed player by player. Instead, per book and game: player goals are close to Poisson,
 * so the fair chances must satisfy sum(-ln(1 - p)) = the game's expected goals (from the no-vig total, less ~3% own goals);
 * touchdowns the same way against the game's expected rush + receiving TDs (0.105 per expected point).
 * Each Yes is divided by the one factor k that makes that hold. Games without a total, or with k outside 1.0–MAX_CUT (an
 * incomplete player list), are left out rather than guessed. The result is the over of 0.5 goals or touchdowns.
 */
/** The most a book's Yes prices may be shaded (FanDuel's NHL anytime Yes runs ~1.3–1.6× fair); beyond it, skip the game. */
const MAX_CUT = 1.8;
export const scorerSkips = { groups: 0, noTotal: 0, few: 0, low: 0, high: 0, priced: 0, samples: [] as string[] };

/** The standard normal quantile (Acklam's approximation, |error| < 1e-8 in the middle, enough for a de-vigged total). */
function normalQuantile(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  if (q < .02425) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0]! * r + c[1]!) * r + c[2]!) * r + c[3]!) * r + c[4]!) * r + c[5]!) / ((((d[0]! * r + d[1]!) * r + d[2]!) * r + d[3]!) * r + 1); }
  if (q > 1 - .02425) return -normalQuantile(1 - q);
  const r = q - .5, t = r * r;
  return (((((a[0]! * t + a[1]!) * t + a[2]!) * t + a[3]!) * t + a[4]!) * t + a[5]!) * r / (((((b[0]! * t + b[1]!) * t + b[2]!) * t + b[3]!) * t + b[4]!) * t + 1);
}

/**
 * Each football game's expected total points: the median over books of the total line moved by its no-vig lean (points
 * spread ~13.5 around the mean, so mean = line + 13.5 × z).
 */
export function expectedPoints(games: readonly GamePrice[]): Map<string, number> {
  const sides = new Map<string, { over?: number; under?: number; line: number; event: string }>();
  for (const game of games) {
    if (game.market !== 'total' || game.line === null) continue;
    const key = `${game.book}|${game.eventId}|${game.line}`;
    const entry = sides.get(key) ?? { line: game.line, event: game.eventId };
    entry[game.side as 'over' | 'under'] = game.probability; sides.set(key, entry);
  }
  const means = new Map<string, number[]>();
  for (const { over, under, line, event } of sides.values()) {
    if (!over || !under) continue;
    means.set(event, [...(means.get(event) ?? []), line + 13.5 * normalQuantile(over / (over + under))]);
  }
  return new Map([...means].map(([event, list]) => { const sorted = list.sort((a, b) => a - b); return [event, sorted[Math.floor(sorted.length / 2)]!]; }));
}

/** Rush + receiving touchdowns per point scored (NFL and college: about 2.45 offensive TDs on 23 points a team). */
const TDS_PER_POINT = .105;

export function scorerFairPrices(rows: readonly unknown[], games: readonly GamePrice[]): FairPrice[] {
  Object.assign(scorerSkips, { groups: 0, noTotal: 0, few: 0, low: 0, high: 0, priced: 0, samples: [] });
  // Totals and props can carry different event ids for one game (a "_b2" suffix on the props), so both are keyed by the
  // teams and the date too.
  const byGame = (game: { home: string | null; away: string | null; startTime: string }) =>
    `${normalizedName(game.home ?? '')}|${normalizedName(game.away ?? '')}|${game.startTime.slice(0, 10)}`;
  const rekey = (list: readonly GamePrice[], totals: Map<string, number>) => {
    for (const game of list) { const total = totals.get(game.eventId); if (total) totals.set(byGame(game), total); }
    return totals;
  };
  const goalGames = games.filter((game) => game.league === 'nhl'), pointGames = games.filter((game) => game.league === 'nfl' || game.league === 'ncaaf');
  const goalTotals = rekey(goalGames, expectedGoals(goalGames)), pointTotals = rekey(pointGames, expectedPoints(pointGames));
  // Sources name teams differently ("ari cardinals" / "Arizona Cardinals", "california" / "California Golden Bears"): a
  // group with no exact key takes the one game that day whose two teams both loosely match.
  const loose = (totals: Map<string, number>, teams: string) => {
    const [home, away, date] = teams.split('|');
    const same = (a: string, b: string) => { const x = a.split(' '), y = b.split(' ');
      if (!x[0] || !y[0]) return false;
      const [short, long] = x.length <= y.length ? [x, y] : [y, x];
      return x.at(-1) === y.at(-1) && x.length > 1 && y.length > 1 || short.every((word, index) => long[index] === word); };
    const hits = [...totals].filter(([key]) => { const [h, a, d] = key.split('|');
      return d === date && h !== undefined && a !== undefined && (same(h, home!) && same(a, away!) || same(h, away!) && same(a, home!)); });
    return hits.length === 1 ? hits[0]![1] : 0;
  };
  const groups = new Map<string, Row[]>();
  for (const value of rows) {
    const row = value as Row;
    const sport = leagueSports[String(row.league)];
    const kind = row.market_type === 'anytime_goal_scorer' && sport === 'NHL' ? 'goals'
      : row.market_type === 'anytime_touchdown_scorer' && (sport === 'NFL' || sport === 'NCAAFB') ? 'tds' : null;
    if (!kind || row.selection_type !== 'other' || row.is_live === true || row.is_active === false ||
      typeof row.player_name !== 'string' || !(Number(row.odds_probability) > 0 && Number(row.odds_probability) < 1)) continue;
    // Soccer is left out: books price whole squads, bench included, so the chances can't be scaled to the game's goals. And
    // DraftKings' NHL "anytime" rows carry first-goal prices (audit 2026-10-06: Eichel +550 at DraftKings, +155 at FanDuel).
    if (kind === 'goals' && row.sportsbook === 'draftkings') continue;
    const key = `${kind}|${String(row.sportsbook)}|${String(row.event_id)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out: FairPrice[] = [];
  for (const [key, list] of groups) {
    scorerSkips.groups++;
    const kind = key.split('|')[0]!, event = String(list[0]!.event_id);
    const teams = byGame({ home: typeof list[0]!.home_team === 'string' ? list[0]!.home_team : null,
      away: typeof list[0]!.away_team === 'string' ? list[0]!.away_team : null, startTime: String(list[0]!.event_start_time) });
    // Expected scoring events in the game: NHL goals less ~3% own goals; football rush + receiving TDs from the points.
    const totals = kind === 'goals' ? goalTotals : pointTotals, total = totals.get(event) ?? totals.get(teams) ?? loose(totals, teams);
    const expected = kind === 'goals' ? total * .97 : total * TDS_PER_POINT;
    if (!expected) {
      scorerSkips.noTotal++;
      if (scorerSkips.samples.length < 3) scorerSkips.samples.push(`no total ${kind} ${event} (${teams}); totals for ${[...totals.keys()].filter((item) => item.includes('|')).slice(0, 4).join(', ')}`);
      continue;
    }
    if (list.length < (kind === 'goals' ? 10 : 15)) { scorerSkips.few++; continue; }
    const target = expected, implied = list.map((row) => Number(row.odds_probability));
    const sum = (k: number) => implied.reduce((total, p) => total - Math.log(1 - Math.min(p / k, 0.99)), 0);
    if (sum(1) < target || sum(MAX_CUT) > target) {
      if (sum(1) < target) scorerSkips.low++; else scorerSkips.high++;
      if (scorerSkips.samples.length < 6) scorerSkips.samples.push(`${String(list[0]!.sportsbook)} ${String(list[0]!.league)} n=${list.length} sum=${sum(1).toFixed(2)} expected=${expected.toFixed(2)}`);
      continue;
    }
    scorerSkips.priced++;
    let lo = 1, hi = MAX_CUT;
    for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (sum(mid) > target) lo = mid; else hi = mid; }
    const k = (lo + hi) / 2;
    for (const row of list) {
      out.push({ book: String(row.sportsbook), sport: leagueSports[String(row.league)]!, player: String(row.player_name),
        market: kind === 'goals' ? 'goals' : 'anytime_tds', line: 0.5,
        fairOver: Math.round(Number(row.odds_probability) / k * 10_000) / 10_000,
        overAmerican: typeof row.odds_american === 'number' ? row.odds_american : null, underAmerican: null,
        startTime: String(row.event_start_time), home: typeof row.home_team === 'string' ? row.home_team : null,
        away: typeof row.away_team === 'string' ? row.away_team : null,
        ...(row.is_stale_pregame_price === true ? { stale: true } : {}), ...(typeof row.timestamp === 'string' ? { observedAt: row.timestamp } : {}) });
    }
  }
  return out;
}

/**
 * Step 4d: a tennis match's total games, from each book's no-vig game total, as both players' "Total Games" line (the
 * PrizePicks stat is the match's games, not the player's).
 */
export function tennisTotalPrices(games: readonly GamePrice[]): FairPrice[] {
  const pairs = new Map<string, { over?: GamePrice; under?: GamePrice }>();
  for (const game of games) {
    if (game.market !== 'total' || game.line === null || leagueSports[game.league] !== 'TENNIS') continue;
    const key = `${game.book}|${game.eventId}|${game.line}`;
    const pair = pairs.get(key) ?? {};
    pair[game.side as 'over' | 'under'] = game; pairs.set(key, pair);
  }
  const out: FairPrice[] = [];
  for (const { over, under } of pairs.values()) {
    if (!over || !under || over.probability + under.probability < .95) continue;
    const fairOver = Math.round(over.probability / (over.probability + under.probability) * 10_000) / 10_000;
    for (const player of [over.home, over.away]) out.push({ book: over.book, sport: 'TENNIS', player, market: 'total_games', line: over.line!,
      fairOver, overAmerican: over.american, underAmerican: under.american, startTime: over.startTime, home: over.home, away: over.away });
  }
  return out;
}

/**
 * Step 6: a UFC fight's total rounds, from each book's no-vig over/under, as both fighters' "Total Rounds" line (PrizePicks
 * lists it per fighter; it is the fight's total). Sport OTHER, as PrizePicks' UFC board is.
 */
export function fightTotals(rows: readonly unknown[]): FairPrice[] {
  const pairs = new Map<string, { over?: Row; under?: Row }>();
  for (const value of rows) {
    const row = value as Row;
    if (row.league !== 'ufc' || row.market_type !== 'total_rounds' || typeof row.line !== 'number' || row.is_live === true ||
      typeof row.home_team !== 'string' || typeof row.away_team !== 'string' || (row.selection_type !== 'over' && row.selection_type !== 'under')) continue;
    const key = `${String(row.sportsbook)}|${String(row.event_id)}|${row.line}`;
    const pair = pairs.get(key) ?? {};
    pair[row.selection_type] = row; pairs.set(key, pair);
  }
  const out: FairPrice[] = [];
  for (const { over, under } of pairs.values()) {
    const pOver = Number(over?.odds_probability), pUnder = Number(under?.odds_probability);
    if (!over || !under || !(pOver > 0) || !(pUnder > 0) || pOver + pUnder < .95) continue;
    for (const fighter of [over.home_team as string, over.away_team as string]) out.push({ book: String(over.sportsbook), sport: 'OTHER',
      player: fighter, market: 'total_rounds', line: over.line as number, fairOver: Math.round(pOver / (pOver + pUnder) * 10_000) / 10_000,
      overAmerican: typeof over.odds_american === 'number' ? over.odds_american : null, underAmerican: typeof under.odds_american === 'number' ? under.odds_american : null,
      startTime: String(over.event_start_time), home: over.home_team as string, away: over.away_team as string });
  }
  return out;
}

/** SharpAPI game totals and spreads as game lines (the game-environment input), one per game and market (first book). */
export function sharpGameLines(games: readonly GamePrice[]): import('./feeds.js').GameLine[] {
  const out = new Map<string, import('./feeds.js').GameLine>();
  for (const game of games) {
    if ((game.market !== 'total' && game.market !== 'spread') || game.line === null) continue;
    if (game.market === 'spread' && game.side !== 'home') continue;
    const key = `${game.eventId}|${game.market}`;
    if (!out.has(key)) out.set(key, { league: game.league.toUpperCase(), home: game.home, away: game.away, startTime: game.startTime,
      market: game.market, line: game.line, homePrice: null, awayPrice: null, homeFair: null, awayFair: null, sourceUrl: null });
  }
  // A game with a total and no run line (SharpAPI lists only KBO totals) splits the total evenly.
  for (const line of [...out.values()]) {
    const event = [...out].find(([, value]) => value === line)![0].split('|')[0]!;
    if (line.market === 'total' && !out.has(`${event}|spread`)) out.set(`${event}|spread`, { ...line, market: 'spread', line: 0 });
  }
  return [...out.values()];
}

export interface SharpPropsStatus {
  readonly configured: boolean; readonly fetchedAt: string | null; readonly prices: number;
  readonly lastError: string | null; readonly requests: number;
  readonly overOnly?: number; readonly games?: number; readonly pickem?: number;
  /** SharpAPI's PrizePicks pass: ok, rows and lines read, when, and the error when it failed (the board then uses the backups). */
  readonly prizePicksFeed?: { ok: boolean; rows: number; lines: number; at: string; error: string | null } | null;
  readonly requestsLastHour?: number;
  /** Requested books with no rows in any league two refreshes running (step 1a). */
  readonly selectedButEmpty?: readonly string[];
  /** The plan's selected books, when SharpAPI answered book_not_selected. */
  readonly planSelects?: readonly string[];
  /** Books SharpAPI answers "book_unavailable" for (its feed for that book is down), from the last refresh's check. */
  readonly unavailable?: readonly string[];
}

/**
 * Keeps the latest DraftKings and Hard Rock player-prop prices from SharpAPI, refreshed on an interval and saved to disk.
 * A failed refresh keeps the previous prices.
 */
export class SharpPropsFeed {
  private prices: FairPrice[] = [];
  private pickem: PickemLine[] = [];
  private overOnly: OverOnlyPrice[] = [];
  private games: GamePrice[] = [];
  private fetchedAt: string | null = null;
  private lastError: string | null = null;
  private requests = 0;
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SharpPropsStatus> | null = null;
  private onRefreshed: ((prices: readonly FairPrice[], at: Date) => unknown)[] = [];
  private onPickem: ((lines: readonly PickemLine[], ok: boolean, at: Date) => unknown)[] = [];
  /** The PrizePicks pass: whether it worked, rows and lines it read, when, and why not. */
  private pickemStatus: { ok: boolean; rows: number; lines: number; at: string; error: string | null } | null = null;
  private lastStartedAt = 0;
  private requestTimes: number[] = [];
  private emptyStreaks = new Map<string, number>();
  private notSelected: string[] | null = null;
  private unavailable: string[] = [];
  /** Partial-game market types SharpAPI has listed (from the PrizePicks pass), the only ones the books' partial pass asks for. */
  private readonly knownPartials = new Set<string>();
  constructor(private readonly apiKey: string | null, private readonly file: string | null,
    private readonly options: { books?: readonly string[]; leagues?: readonly string[]; maxPagesPerLeague?: number;
      /** Pause between requests; SharpAPI's Hobby plan allows 120 a minute. */
      requestGapMs?: number; retryScale?: number;
      /** More football game totals (The Odds API) for the anytime-TD prices; SharpAPI's own totals win. */
      extraTotals?: () => Promise<readonly GamePrice[]> } = {},
    private readonly fetchFn: typeof fetch = fetch, private readonly clock: () => Date = () => new Date()) {}

  private loading: Promise<void> | null = null;
  /** Reads the saved prices once; callers arriving while the read runs wait for it (none see an empty feed). */
  private load(): Promise<void> {
    this.loading ??= this.loadNow();
    return this.loading;
  }
  private async loadNow() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { fetchedAt: string; prices: FairPrice[];
        overOnly?: OverOnlyPrice[]; games?: GamePrice[]; pickem?: PickemLine[]; pickemAt?: string };
      this.prices = saved.prices; this.fetchedAt = saved.fetchedAt; this.overOnly = saved.overOnly ?? []; this.games = saved.games ?? [];
      // PrizePicks lines come back after a restart only when the pass is under 90 minutes old (one refresh); older ones wait
      // for a live pass, so stale lines never show as current.
      const at = saved.pickemAt ?? saved.fetchedAt;
      if (saved.pickem?.length && this.clock().getTime() - Date.parse(at) < 90 * 60_000) {
        this.pickem = saved.pickem;
        this.pickemStatus = { ok: true, rows: saved.pickem.length, lines: saved.pickem.length, at, error: null };
      }
    } catch { /* first run */ }
  }

  /** Called after each successful refresh (the server keeps a history of the books' view of the board). */
  whenRefreshed(callback: (prices: readonly FairPrice[], at: Date) => unknown): void { this.onRefreshed.push(callback); }
  /** Called after each PrizePicks pass with its lines, or with none and ok = false when it failed (fail closed). */
  whenPickem(callback: (lines: readonly PickemLine[], ok: boolean, at: Date) => unknown): void { this.onPickem.push(callback); }

  async current(): Promise<{ fetchedAt: string | null; prices: FairPrice[] }> {
    await this.load();
    return { fetchedAt: this.fetchedAt, prices: this.prices };
  }

  /** Over-only player props (a book's over with no under) and any full-game lines, from the same refresh. */
  async extras(): Promise<{ fetchedAt: string | null; overOnly: OverOnlyPrice[]; games: GamePrice[] }> {
    await this.load();
    return { fetchedAt: this.fetchedAt, overOnly: this.overOnly, games: this.games };
  }

  /** PrizePicks lines from the same refresh (SharpAPI's pick'em books). */
  async pickemLines(): Promise<{ fetchedAt: string | null; lines: PickemLine[] }> {
    await this.load();
    return { fetchedAt: this.pickemStatus?.at ?? null, lines: this.pickem };
  }

  async status(): Promise<SharpPropsStatus> {
    await this.load();
    return { configured: !!this.apiKey, fetchedAt: this.fetchedAt, prices: this.prices.length, lastError: this.lastError,
      requests: this.requests, overOnly: this.overOnly.length, games: this.games.length,
      pickem: this.pickem.length, prizePicksFeed: this.pickemStatus, requestsLastHour: this.requestsLastHour(),
      selectedButEmpty: [...this.emptyStreaks].filter(([, streak]) => streak >= 2).map(([book]) => book),
      ...(this.notSelected ? { planSelects: this.notSelected } : {}), unavailable: this.unavailable };
  }

  /** One refresh at a time: a second call waits for the running one instead of doubling the requests. */
  refresh(): Promise<SharpPropsStatus> {
    this.running ??= this.refreshNow().finally(() => { this.running = null; });
    return this.running;
  }

  /** Pages through one league's rows for these query parameters; `capped` when the page cap stopped it early. */
  private async pages(league: string, params: Record<string, string>, cap: number): Promise<{ rows: unknown[]; capped: boolean }> {
    const rows: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < cap; page++) {
      const url = new URL(`${API}/odds`);
      url.searchParams.set('league', league);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      url.searchParams.set('is_live', 'false');
      url.searchParams.set('limit', '200');
      if (cursor) url.searchParams.set('cursor', cursor);
      if (this.requests++ > 0) await new Promise((resolve) => setTimeout(resolve, this.options.requestGapMs ?? 700));
      this.requestTimes.push(this.clock().getTime());
      const response = await this.fetchRetrying(url);
      if (response.status === 404 || response.status === 400 || response.status === 403) {
        // A league not offered ends quietly; a book the plan hasn't selected is said out loud with the plan's list.
        const body = await response.json().catch(() => null) as { error?: { code?: string; details?: { selected?: unknown } }; code?: string; details?: { selected?: unknown } } | null;
        const code = body?.error?.code ?? body?.code, selected = body?.error?.details?.selected ?? body?.details?.selected;
        if (code === 'book_not_selected') {
          this.notSelected = Array.isArray(selected) ? selected.map(String) : [];
          console.warn(`[sharp] book_not_selected (${league}, asked ${params.sportsbooks}); the plan selects: ${JSON.stringify(selected ?? null)}`);
        } else if (response.status === 403) throw new Error(`SHARPAPI_HTTP_403${code ? `_${code}` : ''}`);
        else if (response.status === 400 && params.market_type) console.warn(`[sharp] ${league} market_type list rejected (${code ?? 'no code'}): ${params.market_type.slice(0, 200)}`);
        return { rows, capped: false };
      }
      if (!response.ok) throw new Error(`SHARPAPI_HTTP_${response.status}`);
      const body = await response.json() as { data?: unknown[]; pagination?: { has_more?: boolean; next_cursor?: string } };
      rows.push(...(body.data ?? []).map(normalizeRow));
      if (!body.pagination?.has_more || !body.pagination.next_cursor) return { rows, capped: false };
      cursor = body.pagination.next_cursor;
    }
    return { rows, capped: true };
  }

  private async refreshNow(): Promise<SharpPropsStatus> {
    await this.load();
    if (!this.apiKey) { this.lastError = 'SHARPAPI_KEY_MISSING'; return this.status(); }
    const rows: unknown[] = [], gameRows: unknown[] = [];
    const requested = this.options.books ?? ['draftkings', 'hardrock', 'fanduel'];
    // Pick'em apps get their own pass (step 0): mixed into the books' requests they were cut off by the page cap.
    const books = requested.filter((book) => !/^(prizepicks|underdog|pick6|sleeper|dabble|betr)/.test(book));
    const wantsPrizePicks = requested.some((book) => book.startsWith('prizepicks'));
    // Player props for the leagues CrownIQ covers. (Full-game lines were only for Kalshi, removed 2026-10-06.)
    const leagues = this.options.leagues ?? sharpLeagues;
    const cap = this.options.maxPagesPerLeague ?? 60;
    let booksOk = false;
    this.lastStartedAt = this.clock().getTime();
    // PrizePicks first: its rows name every partial-game market type SharpAPI really has (a list holding one name it doesn't
    // know is rejected whole: "invalid_filter"), so the books' partial pass asks only for those.
    if (wantsPrizePicks) await this.refreshPrizePicks(leagues, cap);
    const perLeague: Record<string, Record<string, number>> = {}, capped: string[] = [], partialRows: Record<string, number> = {};
    try {
      for (const league of leagues) {
        const sport = leagueSports[league];
        // Step 1d: only the market types CrownIQ reads, as one comma-separated list per pass (no page flooding);
        // the partial-game types get their own pass.
        for (const [index, types] of [fullGameTypes(sport), partialTypes(sport).filter((type) => this.knownPartials.has(type))].entries()) {
          if (!books.length || !types.length) continue;
          const pass = await this.pages(league, { sportsbooks: books.join(','), is_player_prop: 'true', market_type: types.join(',') }, cap);
          rows.push(...pass.rows);
          if (index === 1) partialRows[league] = pass.rows.length;
          if (pass.capped) capped.push(league);
          for (const value of pass.rows) { const book = String((value as Row).sportsbook); (perLeague[league] ??= {})[book] = (perLeague[league]?.[book] ?? 0) + 1; }
        }
        // Game totals: NHL goals and football points set the scale that takes the cut out of anytime-scorer prices (4a);
        // tennis total games price PrizePicks' "Total Games" lines (4d).
        // Step 6: UFC total rounds, distance and method; KBO run totals and run lines (into the game environment).
        const totalType = { nhl: 'total_goals', nfl: 'total_points', ncaaf: 'total_points', atp: 'total_games', wta: 'total_games',
          atp_challenger: 'total_games', ufc: 'total_rounds,go_the_distance,method_of_victory', kbo: 'total_runs,point_spread' }[league];
        if (totalType && books.length) gameRows.push(...(await this.pages(league, { sportsbooks: books.join(','), market_type: totalType }, 10)).rows);
      }
      booksOk = true;
      console.log(`[sharp-books] rows per league and book ${JSON.stringify(perLeague)}; partial-game rows ${JSON.stringify(partialRows)}; page cap hit: ${capped.join(', ') || 'none'}; ` +
        `requests last hour ${this.requestsLastHour()}`);
      // Step 1a: a requested book with no rows in any league, two refreshes running, is flagged.
      for (const book of books) {
        const any = Object.values(perLeague).some((byBook) => (byBook[book] ?? 0) > 0);
        this.emptyStreaks.set(book, any ? 0 : (this.emptyStreaks.get(book) ?? 0) + 1);
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'SHARPAPI_FAILED';
      console.warn(`[sharp] refresh failed after ${this.requests} requests: ${this.lastError}`);
      // The rows fetched before the failure still feed the market audit; the saved prices stay as they were.
      this.auditMarkets(rows.filter((row) => !isPickemRow(row)));
    }
    // A requested book with no rows: one probe each says whether SharpAPI's feed for it is down ("book_unavailable").
    const empty = books.filter((book) => !rows.some((row) => (row as Row).sportsbook === book));
    if (empty.length) {
      const probe = await this.probeBooks(empty).catch(() => null);
      this.unavailable = Object.entries((probe?.books ?? {}) as Record<string, { code: string | null }>).filter(([, item]) => item.code === 'book_unavailable').map(([book]) => book);
      if (this.unavailable.length) console.warn(`[sharp] SharpAPI reports ${this.unavailable.join(', ')} unavailable (its feed for the book is down)`);
    } else this.unavailable = [];
    if (booksOk) {
      console.log(`[sharp] refresh fetched ${rows.length} prop rows in ${this.requests} requests`);
      // Pick'em rows (PrizePicks) are lines, not prices: kept apart so they never count toward a fair price.
      const bookRows = rows.filter((row) => !isPickemRow(row));
      const games = gamePrices(gameRows.filter((row) => !isPickemRow(row)));
      const extraTotals = this.options.extraTotals ? await this.options.extraTotals().catch(() => []) : [];
      const scorers = scorerFairPrices(bookRows, [...extraTotals, ...games]);
      if (scorers.length || rows.some((row) => scorerMarkets.has(String((row as Row).market_type))))
        console.log(`[sharp] anytime scorer: ${scorers.filter((price) => price.market === 'goals').length} goals and ${scorers.filter((price) => price.market === 'anytime_tds').length} TD prices; ${JSON.stringify(scorerSkips)}; tennis total games ${tennisTotalPrices(games).length}`);
      const fights = fightTotals(gameRows.filter((row) => !isPickemRow(row)));
      const types = (league: string) => [...new Set(gameRows.filter((row) => (row as Row).league === league).map((row) => String((row as Row).market_type)))];
      if (leagues.includes('ufc') || leagues.includes('kbo'))
        console.log(`[sharp] step 6 games: ufc types ${JSON.stringify(types('ufc'))}, ${fights.length} total-rounds prices; kbo types ${JSON.stringify(types('kbo'))}`);
      const prices = [...fairPrices(bookRows), ...scorers, ...tennisTotalPrices(games), ...fights];
      this.auditMarkets(bookRows);
      const shots = shotsAudit(bookRows);
      if (shots.players) console.log(`[sharp-audit] NHL player_shots vs shots on goal: ${JSON.stringify(shots)}`);
      if (!prices.length) this.lastError = 'NO_PRICES';
      else {
        this.prices = prices; this.overOnly = overOnlyPrices(bookRows); this.games = games;
        this.fetchedAt = this.clock().toISOString(); this.lastError = null;
        await this.save();
        for (const callback of this.onRefreshed) { try { await callback(prices, this.clock()); } catch { /* best effort */ } }
      }
    }
    return this.status();
  }

  /**
   * PrizePicks' regular lines from SharpAPI (step 0: the primary source; scrapers and The Odds API back it up). Fails closed:
   * a failed or empty pass clears the lines rather than keeping old ones as current, and the listeners hear it.
   */
  private async refreshPrizePicks(leagues: readonly string[], cap: number): Promise<void> {
    const rows: unknown[] = [];
    let error: string | null = null;
    try {
      for (const league of leagues) rows.push(...(await this.pages(league, { sportsbooks: 'prizepicks', is_player_prop: 'true' }, cap)).rows);
    } catch (failure) { error = failure instanceof Error ? failure.message : 'SHARPAPI_FAILED'; }
    for (const value of rows) { const type = String((value as Row).market_type); if (/^1st_(half|quarter|period)_/.test(type)) this.knownPartials.add(type); }
    const lines = error ? [] : pickemLines(rows).filter((line) => line.book.startsWith('prizepicks'));
    if (!error && !lines.length) error = 'NO_PRIZEPICKS_ROWS';
    const at = this.clock().toISOString();
    this.pickem = error ? [] : lines;
    this.pickemStatus = { ok: !error, rows: rows.length, lines: lines.length, at, error };
    if (error) console.warn(`[sharp] PrizePicks feed down (${error}); the board falls back to The Odds API and the scrapers`);
    else console.log(`[sharp] PrizePicks ${lines.length} lines from ${rows.length} rows`);
    await this.save();
    for (const callback of this.onPickem) { try { await callback(this.pickem, !error, this.clock()); } catch { /* best effort */ } }
  }

  private async save(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ fetchedAt: this.fetchedAt, prices: this.prices, overOnly: this.overOnly,
      games: this.games, pickem: this.pickem, pickemAt: this.pickemStatus?.at ?? null }));
    await rename(temporary, this.file);
  }

  /** Market audit: the player-prop market types CrownIQ doesn't map yet, per league (a missing mapping means no book prices). */
  private auditMarkets(bookRows: readonly unknown[]): void {
    const unmapped = new Map<string, number>();
    for (const value of bookRows) {
      const row = value as Row, sport = leagueSports[String(row.league)];
      if (!sport || typeof row.player_name !== 'string' || bookMarket(sport, String(row.sportsbook), String(row.market_type))) continue;
      const key = `${sport}:${String(row.market_type)}`;
      unmapped.set(key, (unmapped.get(key) ?? 0) + 1);
    }
    const scorer = bookRows.find((value) => scorerMarkets.has(String((value as Row).market_type))) as Row | undefined;
    if (scorer) console.log(`[sharp-audit] scorer sample: ${JSON.stringify({ book: scorer.sportsbook, league: scorer.league,
      market: scorer.market_type, selection: scorer.selection_type, line: scorer.line, p: scorer.odds_probability })}`);
    if (unmapped.size) console.log(`[sharp-audit] unmapped player markets: ${[...unmapped].sort((x, y) => y[1] - x[1]).slice(0, 30)
      .map(([key, count]) => `${key}(${count})`).join(' ')}`);
  }

  /**
   * One SharpAPI request; a 429 (rate limit) waits for Retry-After (else 15, 30, 60 s) and tries again, up to 3 retries,
   * so one busy minute doesn't throw away a whole refresh.
   */
  /**
   * One request per book (NFL, one row) to see what SharpAPI answers for it: the HTTP status, its error code and the
   * plan's selected books when it names them, and whether a row came back. Diagnostics only (the admin route).
   */
  async probeBooks(books: readonly string[], league = 'nfl') {
    if (!this.apiKey) return { configured: false, books: {} };
    const out: Record<string, { status: number; code: string | null; rows: number; selected?: unknown }> = {};
    for (const book of books) {
      const url = new URL(`${API}/odds`);
      for (const [key, value] of Object.entries({ league, sportsbooks: book, is_live: 'false', limit: '1' })) url.searchParams.set(key, value);
      const response = await this.fetchRetrying(url).catch(() => null);
      if (!response) { out[book] = { status: 0, code: 'NETWORK', rows: 0 }; continue; }
      const body = await response.json().catch(() => null) as { data?: unknown[]; error?: { code?: string; details?: { selected?: unknown } }; code?: string } | null;
      out[book] = { status: response.status, code: body?.error?.code ?? body?.code ?? null, rows: body?.data?.length ?? 0,
        ...(body?.error?.details?.selected ? { selected: body.error.details.selected } : {}) };
    }
    return { configured: true, requested: this.options.books ?? null, books: out };
  }

  private async fetchRetrying(url: URL): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchFn(url, { headers: { 'X-API-Key': this.apiKey! }, signal: AbortSignal.timeout(30_000) });
      if (response.status !== 429 || attempt >= 3) return response;
      const after = Number(response.headers.get('retry-after'));
      const waitMs = Math.min(120_000, Number.isFinite(after) && after > 0 ? after * 1000 : 15_000 * 2 ** attempt) * (this.options.retryScale ?? 1);
      console.warn(`[sharp] rate limited; retrying in ${Math.round(waitMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Step 1e: checks every `intervalMinutes` (15) and refreshes then when a game starts within 3 hours, otherwise once an hour.
   */
  start(intervalMinutes: number): void {
    if (this.timer || !this.apiKey || intervalMinutes <= 0) return;
    this.refresh().catch(() => undefined);
    this.timer = setInterval(() => { if (this.due()) this.refresh().catch(() => undefined); }, intervalMinutes * 60_000);
    this.timer.unref();
  }

  /** Whether a refresh is due: a game within 3 hours (every tick), else an hour since the last refresh started. */
  due(): boolean {
    const now = this.clock().getTime();
    if (now - this.lastStartedAt >= 55 * 60_000) return true;
    const starts = [...this.prices.map((price) => price.startTime), ...this.pickem.map((line) => line.startTime)];
    return starts.some((start) => { const at = Date.parse(start); return at > now && at - now <= 3 * 3600_000; });
  }

  /** SharpAPI requests in the last hour (the plan allows 120 a minute). */
  requestsLastHour(): number {
    const cutoff = this.clock().getTime() - 3600_000;
    while (this.requestTimes.length && this.requestTimes[0]! < cutoff) this.requestTimes.shift();
    return this.requestTimes.length;
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
