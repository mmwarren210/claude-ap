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
  nhl: 'NHL', atp: 'TENNIS', wta: 'TENNIS', ...Object.fromEntries(soccerLeagues.map((league) => [league, 'SOCCER' as Sport])) };
/** Every league pulled by default: player props for the ones CrownIQ covers, game lines for all of them. */
export const sharpLeagues: readonly string[] = ['nfl', 'ncaaf', 'mlb', 'nba', 'wnba', 'nhl', 'atp', 'wta', ...soccerLeagues];

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
    'player_rushing_+_receiving_yards': 'rush_plus_rec_yds' },
  NCAAFB: { player_passing_yards: 'passing_yards', player_rushing_yards: 'player_rush_yds',
    player_receiving_yards: 'player_reception_yds', player_receptions: 'player_receptions',
    'player_passing_+_rushing_yards': 'pass_plus_rush_yds', player_passing_touchdowns: 'player_pass_tds',
    player_passing_attempts: 'player_pass_attempts', player_passing_completions: 'player_pass_completions',
    player_rushing_attempts: 'player_rush_attempts' },
  MLB: { player_hits: 'batter_hits', 'player_hits_+_runs_+_rbis': 'batter_hits_runs_rbis', player_home_runs: 'batter_home_runs',
    player_total_bases: 'batter_total_bases', player_walks: 'batter_walks', player_rbis: 'rbis', player_runs: 'runs',
    player_strikeouts: 'pitcher_strikeouts', player_singles: 'singles', player_doubles: 'doubles',
    player_stolen_bases: 'stolen_bases', player_hits_allowed: 'hits_allowed', player_earned_runs: 'earned_runs',
    player_walks_allowed: 'walks_allowed', player_pitching_outs: 'pitching_outs' },
  NBA: basketball, WNBA: basketball,
  NHL: { player_shots_on_goal: 'shots_on_goal', player_points: 'points', player_saves: 'saves', player_assists: 'assists',
    player_goals: 'goals', player_blocked_shots: 'blocked_shots', player_power_play_points: 'power_play_points',
    anytime_goal_scorer: 'goals' },
  // Hard Rock's "player total games" is the games that player wins (market "team_total", lines 7.5–13.5), the same stat as
  // DraftKings' "games won"; DraftKings' own "player total games" (4.5, 7.5) is a set stat and is left out (bookMarket).
  TENNIS: { player_total_games: 'games_won', player_games_won: 'games_won', player_aces: 'aces',
    player_double_faults: 'double_faults' },
  SOCCER: { player_shots: 'shots', player_shots_on_target: 'sot', player_assists: 'assists', player_goals: 'goals',
    player_fouls: 'fouls', player_saves: 'goalie_saves' },
};

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
  return marketKeys[sport]?.[type];
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
 * Anytime goal scorer (NHL). SharpAPI sends one "Yes" price per player (selection "other", no line) and no "No"
 * side, so the book's cut can't be removed player by player. Instead, per book and game: player goals are close to Poisson,
 * so the fair chances must satisfy sum(-ln(1 - p)) = the game's expected goals (from the no-vig total, less ~3% own goals).
 * Each Yes is divided by the one factor k that makes that hold. Games without a total, or with k outside 1.0–MAX_CUT (an
 * incomplete player list), are left out rather than guessed. The result is the over of 0.5 goals.
 */
/** The most a book's Yes prices may be shaded (FanDuel's NHL anytime Yes runs ~1.3–1.6× fair); beyond it, skip the game. */
const MAX_CUT = 1.8;
export const scorerSkips = { groups: 0, noTotal: 0, few: 0, low: 0, high: 0, priced: 0, samples: [] as string[] };

export function scorerFairPrices(rows: readonly unknown[], games: readonly GamePrice[]): FairPrice[] {
  Object.assign(scorerSkips, { groups: 0, noTotal: 0, few: 0, low: 0, high: 0, priced: 0, samples: [] });
  const totals = expectedGoals(games);
  const groups = new Map<string, Row[]>();
  for (const value of rows) {
    const row = value as Row;
    if (row.market_type !== 'anytime_goal_scorer' || row.selection_type !== 'other' || row.is_live === true || row.is_active === false ||
      typeof row.player_name !== 'string' || !(Number(row.odds_probability) > 0 && Number(row.odds_probability) < 1)) continue;
    // NHL only: soccer books price whole squads, bench included, so the chances can't be scaled to the game's goals. And
    // DraftKings' "anytime" rows carry first-goal prices (audit 2026-10-06: Eichel +550 at DraftKings, +155 at FanDuel).
    if (leagueSports[String(row.league)] !== 'NHL' || row.sportsbook === 'draftkings') continue;
    const key = `${String(row.sportsbook)}|${String(row.event_id)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out: FairPrice[] = [];
  for (const list of groups.values()) {
    scorerSkips.groups++;
    const goals = totals.get(String(list[0]!.event_id));
    if (!goals) { scorerSkips.noTotal++; if (scorerSkips.samples.length < 3) scorerSkips.samples.push(`no total ${String(list[0]!.event_id)} ${String(list[0]!.home_team)}`); continue; }
    if (list.length < 10) { scorerSkips.few++; continue; }
    const target = goals * 0.97, implied = list.map((row) => Number(row.odds_probability));
    const sum = (k: number) => implied.reduce((total, p) => total - Math.log(1 - Math.min(p / k, 0.99)), 0);
    if (sum(1) < target || sum(MAX_CUT) > target) {
      if (sum(1) < target) scorerSkips.low++; else scorerSkips.high++;
      if (scorerSkips.samples.length < 4) scorerSkips.samples.push(`${String(list[0]!.sportsbook)} ${String(list[0]!.league)} n=${list.length} sum=${sum(1).toFixed(2)} goals=${goals.toFixed(2)}`);
      continue;
    }
    scorerSkips.priced++;
    let lo = 1, hi = MAX_CUT;
    for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (sum(mid) > target) lo = mid; else hi = mid; }
    const k = (lo + hi) / 2;
    for (const row of list) {
      out.push({ book: String(row.sportsbook), sport: 'NHL', player: String(row.player_name), market: 'goals', line: 0.5,
        fairOver: Math.round(Number(row.odds_probability) / k * 10_000) / 10_000,
        overAmerican: typeof row.odds_american === 'number' ? row.odds_american : null, underAmerican: null,
        startTime: String(row.event_start_time), home: typeof row.home_team === 'string' ? row.home_team : null,
        away: typeof row.away_team === 'string' ? row.away_team : null,
        ...(row.is_stale_pregame_price === true ? { stale: true } : {}), ...(typeof row.timestamp === 'string' ? { observedAt: row.timestamp } : {}) });
    }
  }
  return out;
}

export interface SharpPropsStatus {
  readonly configured: boolean; readonly fetchedAt: string | null; readonly prices: number;
  readonly lastError: string | null; readonly requests: number;
  readonly overOnly?: number; readonly games?: number; readonly pickem?: number;
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
  constructor(private readonly apiKey: string | null, private readonly file: string | null,
    private readonly options: { books?: readonly string[]; leagues?: readonly string[]; maxPagesPerLeague?: number;
      /** Pause between requests; SharpAPI's Hobby plan allows 120 a minute. */
      requestGapMs?: number; retryScale?: number } = {},
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
        overOnly?: OverOnlyPrice[]; games?: GamePrice[]; pickem?: PickemLine[] };
      this.prices = saved.prices; this.fetchedAt = saved.fetchedAt; this.overOnly = saved.overOnly ?? []; this.games = saved.games ?? [];
      this.pickem = saved.pickem ?? [];
    } catch { /* first run */ }
  }

  /** Called after each successful refresh (the server keeps a history of the books' view of the board). */
  whenRefreshed(callback: (prices: readonly FairPrice[], at: Date) => unknown): void { this.onRefreshed.push(callback); }

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
    return { fetchedAt: this.fetchedAt, lines: this.pickem };
  }

  async status(): Promise<SharpPropsStatus> {
    await this.load();
    return { configured: !!this.apiKey, fetchedAt: this.fetchedAt, prices: this.prices.length, lastError: this.lastError,
      requests: this.requests, overOnly: this.overOnly.length, games: this.games.length,
      pickem: this.pickem.length };
  }

  /** One refresh at a time: a second call waits for the running one instead of doubling the requests. */
  refresh(): Promise<SharpPropsStatus> {
    this.running ??= this.refreshNow().finally(() => { this.running = null; });
    return this.running;
  }

  private async refreshNow(): Promise<SharpPropsStatus> {
    await this.load();
    if (!this.apiKey) { this.lastError = 'SHARPAPI_KEY_MISSING'; return this.status(); }
    const rows: unknown[] = [], gameRows: unknown[] = [];
    const books = this.options.books ?? ['draftkings', 'hardrock', 'fanduel'];
    // Player props for the leagues CrownIQ covers. (Full-game lines were only for Kalshi, removed 2026-10-06.)
    const leagues = this.options.leagues ?? sharpLeagues;
    // NHL game goal totals: they set the scale that takes the cut out of anytime-scorer prices.
    const jobs = [...leagues.map((league) => ({ league, props: true })),
      ...leagues.filter((league) => league === 'nhl').map((league) => ({ league, props: false }))];
    try {
      for (const { league, props } of jobs) {
        let cursor: string | null = null;
        for (let page = 0; page < (props ? this.options.maxPagesPerLeague ?? 60 : 10); page++) {
          const url = new URL(`${API}/odds`);
          url.searchParams.set('sportsbooks', books.join(','));
          url.searchParams.set('league', league);
          if (props) url.searchParams.set('is_player_prop', 'true');
          else url.searchParams.set('market_type', 'total_goals');
          url.searchParams.set('is_live', 'false');
          url.searchParams.set('limit', '200');
          if (cursor) url.searchParams.set('cursor', cursor);
          if (this.requests++ > 0) await new Promise((resolve) => setTimeout(resolve, this.options.requestGapMs ?? 700));
          const response = await this.fetchRetrying(url);
          if (response.status === 404 || response.status === 400) break; // league not offered
          if (!response.ok) throw new Error(`SHARPAPI_HTTP_${response.status}`);
          const body = await response.json() as { data?: unknown[]; pagination?: { has_more?: boolean; next_cursor?: string } };
          (props ? rows : gameRows).push(...(body.data ?? []).map(normalizeRow));
          if (!body.pagination?.has_more || !body.pagination.next_cursor) break;
          cursor = body.pagination.next_cursor;
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'SHARPAPI_FAILED';
      console.warn(`[sharp] refresh failed after ${this.requests} requests: ${this.lastError}`);
      // The rows fetched before the failure still feed the market audit; the saved prices stay as they were.
      this.auditMarkets(rows.filter((row) => !isPickemRow(row)));
      return this.status();
    }
    console.log(`[sharp] refresh fetched ${rows.length} prop rows in ${this.requests} requests`);
    // Pick'em rows (PrizePicks) are lines, not prices: kept apart so they never count toward a fair price.
    const bookRows = rows.filter((row) => !isPickemRow(row));
    const games = gamePrices(gameRows.filter((row) => !isPickemRow(row)));
    const scorers = scorerFairPrices(bookRows, games);
    if (scorers.length || rows.some((row) => (row as Row).market_type === 'anytime_goal_scorer'))
      console.log(`[sharp] anytime scorer: ${scorers.length} goals prices from ${expectedGoals(games).size} game totals; ${JSON.stringify(scorerSkips)}; total event ids e.g. ${[...expectedGoals(games).keys()].slice(0, 2).join(', ')}`);
    const prices = [...fairPrices(bookRows), ...scorers];
    this.auditMarkets(bookRows);
    if (!prices.length) { this.lastError = 'NO_PRICES'; return this.status(); }
    this.prices = prices; this.overOnly = overOnlyPrices(bookRows); this.games = games;
    this.pickem = pickemLines(rows);
    this.fetchedAt = this.clock().toISOString(); this.lastError = null;
    if (this.file) {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ fetchedAt: this.fetchedAt, prices, overOnly: this.overOnly, games: this.games,
        pickem: this.pickem }));
      await rename(temporary, this.file);
    }
    for (const callback of this.onRefreshed) { try { await callback(prices, this.clock()); } catch { /* best effort */ } }
    return this.status();
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

  start(intervalMinutes: number): void {
    if (this.timer || !this.apiKey || intervalMinutes <= 0) return;
    this.refresh().catch(() => undefined);
    this.timer = setInterval(() => { this.refresh().catch(() => undefined); }, intervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
