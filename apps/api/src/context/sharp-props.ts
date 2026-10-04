import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Sport } from '@crowniq/contracts';
import { normalizedName } from './match.js';

// Sportsbook player-prop prices (DraftKings, Hard Rock) from SharpAPI, used as reference odds and for CrownIQ's own +EV.
// Reference only: nothing here feeds GKR scoring.

const API = 'https://api.sharpapi.io/api/v1';
const leagueSports: Readonly<Record<string, Sport>> = { nfl: 'NFL', ncaaf: 'NCAAFB', mlb: 'MLB', nba: 'NBA', wnba: 'WNBA',
  nhl: 'NHL' };

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
    player_receiving_yards: 'player_reception_yds' },
  MLB: { player_hits: 'batter_hits', 'player_hits_+_runs_+_rbis': 'batter_hits_runs_rbis', player_home_runs: 'batter_home_runs',
    player_total_bases: 'batter_total_bases', player_walks: 'batter_walks', player_rbis: 'rbis', player_runs: 'runs',
    player_strikeouts: 'pitcher_strikeouts' },
  NBA: basketball, WNBA: basketball,
  NHL: { player_shots_on_goal: 'shots_on_goal', player_points: 'points', player_saves: 'saves' },
};

/** One book's de-vigged price for one player, stat and number. */
export interface FairPrice {
  readonly book: string; readonly sport: Sport; readonly player: string; readonly market: string; readonly line: number;
  /** The book's no-vig chance the stat goes over the number, 0–1. */
  readonly fairOver: number;
  readonly overAmerican: number | null; readonly underAmerican: number | null;
  readonly startTime: string; readonly home: string | null; readonly away: string | null;
}

interface Row {
  sportsbook?: unknown; league?: unknown; market_type?: unknown; selection_type?: unknown; line?: unknown;
  odds_probability?: unknown; odds_american?: unknown; player_name?: unknown; event_start_time?: unknown;
  home_team?: unknown; away_team?: unknown; is_live?: unknown; is_active?: unknown; event_id?: unknown;
}

/** Pairs each book's Over and Under at the same number and removes the vig: fair over = p(over) / (p(over) + p(under)). */
export function fairPrices(rows: readonly unknown[]): FairPrice[] {
  const pairs = new Map<string, { over?: Row; under?: Row }>();
  for (const value of rows) {
    const row = value as Row;
    const sport = leagueSports[String(row.league)], market = sport ? marketKeys[sport]?.[String(row.market_type)] : undefined;
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
    prices.push({ book: String(over.sportsbook), sport, player: String(over.player_name), market: marketKeys[sport]![String(over.market_type)]!,
      line: over.line as number, fairOver: Math.round(pOver / (pOver + pUnder) * 10_000) / 10_000,
      overAmerican: typeof over.odds_american === 'number' ? over.odds_american : null,
      underAmerican: typeof under.odds_american === 'number' ? under.odds_american : null,
      startTime: String(over.event_start_time), home: typeof over.home_team === 'string' ? over.home_team : null,
      away: typeof over.away_team === 'string' ? over.away_team : null });
  }
  return prices;
}

export interface SharpPropsStatus {
  readonly configured: boolean; readonly fetchedAt: string | null; readonly prices: number;
  readonly lastError: string | null; readonly requests: number;
}

/**
 * Keeps the latest DraftKings and Hard Rock player-prop prices from SharpAPI, refreshed on an interval and saved to disk.
 * A failed refresh keeps the previous prices.
 */
export class SharpPropsFeed {
  private prices: FairPrice[] = [];
  private fetchedAt: string | null = null;
  private lastError: string | null = null;
  private requests = 0;
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly apiKey: string | null, private readonly file: string | null,
    private readonly options: { books?: readonly string[]; leagues?: readonly string[]; maxPagesPerLeague?: number } = {},
    private readonly fetchFn: typeof fetch = fetch, private readonly clock: () => Date = () => new Date()) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { fetchedAt: string; prices: FairPrice[] };
      this.prices = saved.prices; this.fetchedAt = saved.fetchedAt;
    } catch { /* first run */ }
  }

  async current(): Promise<{ fetchedAt: string | null; prices: FairPrice[] }> {
    await this.load();
    return { fetchedAt: this.fetchedAt, prices: this.prices };
  }

  async status(): Promise<SharpPropsStatus> {
    await this.load();
    return { configured: !!this.apiKey, fetchedAt: this.fetchedAt, prices: this.prices.length, lastError: this.lastError,
      requests: this.requests };
  }

  async refresh(): Promise<SharpPropsStatus> {
    await this.load();
    if (!this.apiKey) { this.lastError = 'SHARPAPI_KEY_MISSING'; return this.status(); }
    const rows: unknown[] = [];
    try {
      for (const league of this.options.leagues ?? ['nfl', 'ncaaf', 'mlb', 'nba', 'wnba', 'nhl']) {
        let cursor: string | null = null;
        for (let page = 0; page < (this.options.maxPagesPerLeague ?? 40); page++) {
          const url = new URL(`${API}/odds`);
          url.searchParams.set('sportsbooks', (this.options.books ?? ['draftkings', 'hardrock']).join(','));
          url.searchParams.set('league', league);
          url.searchParams.set('is_player_prop', 'true');
          url.searchParams.set('is_live', 'false');
          url.searchParams.set('limit', '200');
          if (cursor) url.searchParams.set('cursor', cursor);
          this.requests++;
          const response = await this.fetchFn(url, { headers: { 'X-API-Key': this.apiKey }, signal: AbortSignal.timeout(30_000) });
          if (response.status === 404 || response.status === 400) break; // league not offered
          if (!response.ok) throw new Error(`SHARPAPI_HTTP_${response.status}`);
          const body = await response.json() as { data?: unknown[]; pagination?: { has_more?: boolean; next_cursor?: string } };
          rows.push(...(body.data ?? []));
          if (!body.pagination?.has_more || !body.pagination.next_cursor) break;
          cursor = body.pagination.next_cursor;
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'SHARPAPI_FAILED';
      return this.status();
    }
    const prices = fairPrices(rows);
    if (!prices.length) { this.lastError = 'NO_PRICES'; return this.status(); }
    this.prices = prices; this.fetchedAt = this.clock().toISOString(); this.lastError = null;
    if (this.file) {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify({ fetchedAt: this.fetchedAt, prices }));
      await rename(`${this.file}.tmp`, this.file);
    }
    return this.status();
  }

  start(intervalMinutes: number): void {
    if (this.timer || !this.apiKey || intervalMinutes <= 0) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, intervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
