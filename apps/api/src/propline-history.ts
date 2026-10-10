import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PropLine } from '@crowniq/contracts';
import { normalizedName } from './context/match.js';
import { canonicalMarket } from './edge/market-map.js';
import type { PropLineClient } from './scrapers/propline.js';

// Player history from PropLine's box-score archive (owner, 2026-10-09: PropLine is the source of truth). One request per
// player returns their recent games with every stat, so every market for that player reads from it. The archive starts
// April 2026 and has gaps for some players, so a read is "the last games PropLine holds", never "the last games played".

type Stats = Readonly<Record<string, number>>;
interface Game { readonly at: string; readonly opponent: string | null; readonly stats: Stats }
interface Entry { readonly at: number; readonly games: readonly Game[] | null }

/** CrownIQ's sport → PropLine's sport key, for sports with one key (soccer needs the league, from the game itself). */
const SPORT_KEYS: Readonly<Record<string, string>> = { NFL: 'football_nfl', NCAAFB: 'football_ncaaf', NBA: 'basketball_nba',
  WNBA: 'basketball_wnba', NCAAB: 'basketball_ncaab', MLB: 'baseball_mlb', NHL: 'hockey_nhl', TENNIS: 'tennis', CS2: 'esports', UFC: 'mma_ufc' };
/** Soccer leagues PropLine carries, by the board's league label; a line with no league label tries them in this order. */
const SOCCER_KEYS: Readonly<Record<string, string>> = { EPL: 'soccer_epl', 'LA LIGA': 'soccer_la_liga', BUNDESLIGA: 'soccer_bundesliga',
  'SERIE A': 'soccer_serie_a', 'LIGUE 1': 'soccer_ligue_1', MLS: 'soccer_mls', 'LIGA MX': 'soccer_liga_mx', CHAMPIONSHIP: 'soccer_championship' };
/** UFC lines are filed under OTHER with a UFC or MMA league label. */
const sportOf = (line: { sport: string; league?: string | null }) => /^(UFC|MMA)/i.test(line.league ?? '') ? 'UFC' : line.sport;

type Read = string | readonly string[];
const basketball: Readonly<Record<string, Read>> = { player_points: 'points', points: 'points', player_rebounds: 'rebounds',
  rebounds: 'rebounds', player_assists: 'assists', assists: 'assists', player_threes: 'threes', threes: 'threes',
  player_steals: 'steals', steals: 'steals', player_blocks: 'blocks', blocks: 'blocks', player_turnovers: 'turnovers',
  turnovers: 'turnovers', player_points_rebounds: 'points_rebounds', player_points_assists: 'points_assists',
  player_rebounds_assists: 'rebounds_assists', player_points_rebounds_assists: 'points_rebounds_assists',
  player_blocks_steals: ['blocks', 'steals'], blocks_steals: ['blocks', 'steals'] };
const football: Readonly<Record<string, Read>> = { passing_yards: 'passing_yards', player_pass_yds: 'passing_yards',
  player_pass_tds: 'passing_tds', player_pass_attempts: 'passing_attempts', player_pass_completions: 'passing_completions',
  player_pass_interceptions: 'interceptions', player_pass_longest_completion: 'longest_completion', player_rush_yds: 'rushing_yards',
  player_rush_attempts: 'rushing_attempts', player_rush_tds: 'rushing_tds', rush_tds: 'rushing_tds', player_rush_longest: 'longest_rush',
  longest_rush: 'longest_rush', player_reception_yds: 'receiving_yards', player_receptions: 'receptions',
  player_reception_tds: 'receiving_tds', rec_tds: 'receiving_tds', receiving_tds: 'receiving_tds',
  player_reception_longest: 'longest_reception', longest_rec: 'longest_reception', player_pass_rush_yds: 'pass_rush_yds',
  player_rush_reception_yds: 'rush_reception_yds', anytime_tds: 'total_tds', player_solo_tackles: 'solo_tackles',
  player_tackles_assists: 'tackles_assists', player_sacks: 'sacks', player_field_goals: 'field_goals_made', fg_made: 'field_goals_made',
  player_pats: 'extra_points_made', player_kicking_points: 'kicking_points' };
const READS: Readonly<Record<string, Readonly<Record<string, Read>>>> = {
  NBA: basketball, WNBA: basketball, NCAAB: basketball, NFL: football, NCAAFB: football,
  MLB: { batter_hits: 'hits', hits: 'hits', batter_total_bases: 'total_bases', total_bases: 'total_bases', batter_singles: 'singles',
    singles: 'singles', batter_doubles: 'doubles', doubles: 'doubles', batter_triples: 'triples', triples: 'triples',
    batter_home_runs: 'home_runs', home_runs: 'home_runs', runs: 'runs', batter_runs_scored: 'runs', rbis: 'rbis', batter_rbis: 'rbis',
    batter_walks: 'walks', sb: 'stolen_bases', stolen_bases: 'stolen_bases', hitter_ks: 'batter_strikeouts',
    batter_strikeouts: 'batter_strikeouts', batter_hits_runs_rbis: 'hits_runs_rbis', pitcher_strikeouts: 'strikeouts',
    pitcher_outs: 'outs', pitching_outs: 'outs', pitcher_earned_runs: 'earned_runs', hits_allowed: 'hits_allowed',
    walks_allowed: 'walks_allowed' },
  NHL: { goals: 'goals', assists: 'assists', points: 'points_nhl', shots_on_goal: 'shots_on_goal', blocked_shots: 'blocked_shots',
    power_play_points: 'power_play_points', player_power_play_points: 'power_play_points', saves: 'saves' },
  SOCCER: { goals: 'goals', assists: 'assists', shots: 'shots', shots_on_target: 'shots_on_target', sot: 'shots_on_target',
    fouls: 'fouls_committed', goals_plus_assists: ['goals', 'assists'], goal_plus_assist: ['goals', 'assists'], saves: 'saves' },
  TENNIS: { total_games: 'total_games', first_set_total_games: 'set_1_games', aces: 'aces', double_faults: 'dblfaults' },
};

// A stat missing from a game the player played in means zero only when the box score carries others of the same kind
// (a receiver with receptions but no receiving TD row scored none); otherwise the game says nothing about it.
const FAMILIES: readonly (readonly string[])[] = [
  ['passing_yards', 'passing_tds', 'passing_attempts', 'passing_completions', 'interceptions', 'longest_completion'],
  ['rushing_yards', 'rushing_tds', 'rushing_attempts', 'longest_rush'],
  ['receiving_yards', 'receiving_tds', 'receptions', 'longest_reception'],
];
const PITCHING = new Set(['strikeouts', 'outs', 'earned_runs', 'hits_allowed', 'walks_allowed']);

/** The PropLine stat (or stats, summed) a market reads, or null when PropLine's box score doesn't carry it. */
export function proplineStat(sport: string, market: string): Read | null {
  // CS2 (owner, 2026-10-09): kills and headshots per map scope, from PropLine's esports box scores. A line with no map
  // scope isn't read (the box score has no whole-match total).
  // UFC (owner, 2026-10-09): significant strikes and takedowns from PropLine's fight box scores.
  if (sport === 'UFC') {
    const m = market.toLowerCase();
    return /fantasy|time|round/.test(m) ? null : /sig|strike/.test(m) ? 'significant_strikes' : /takedown/.test(m) ? 'takedowns' : null;
  }
  if (sport === 'CS2') {
    const m = market.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const kind = /headshot/.test(m) ? 'headshots' : /kill/.test(m) ? 'kills' : null;
    const scope = /1_2_3|1_3\b|maps_1_3/.test(m) ? 'maps_1_2_3' : /1_2|1_plus_2/.test(m) ? 'maps_1_2' : /map_?1/.test(m) ? 'map_1' : null;
    return kind && scope ? `${kind}_${scope}` : null;
  }
  const table = READS[sport];
  if (!table) return null;
  return table[market] ?? table[canonicalMarket(sport, market)] ?? null;
}

/** One game's value for a stat; null when the game says nothing about it. */
export function gameValue(stats: Stats, read: Read): number | null {
  const one = (key: string) => {
    // CS2 map stats count only where PropLine marks that map scope gradeable (an ungraded scope comes through as 0).
    const scope = /_(map_1|maps_1_2|maps_1_2_3)$/.exec(key)?.[1];
    if (scope && `${scope}_gradeable` in stats && stats[`${scope}_gradeable`] !== 1) return null;
    if (Number.isFinite(stats[key])) return stats[key]!;
    const family = FAMILIES.find((list) => list.includes(key));
    return family && family.some((other) => Number.isFinite(stats[other])) ? 0 : null;
  };
  if (typeof read === 'string') return one(read);
  const parts = read.map(one);
  return parts.some((part) => part === null) ? null : parts.reduce<number>((sum, part) => sum + part!, 0);
}

/** A player's values for one stat before a time, newest first. Pitching stats count starts only when there are any. */
export function valuesFrom(games: readonly Game[], read: Read, before: number): number[] {
  const played = games.filter((game) => Date.parse(game.at) < before).sort((a, b) => b.at.localeCompare(a.at));
  const pitching = typeof read === 'string' && PITCHING.has(read);
  const starts = pitching ? played.filter((game) => game.stats.pitcher_started === 1) : [];
  return (starts.length ? starts : played).flatMap((game) => { const value = gameValue(game.stats, read); return value === null ? [] : [value]; });
}

export class PropLineHistory {
  private readonly cache = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<readonly Game[] | null>>();
  private loaded = false;
  private dirty = false;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private day = '';
  readonly stats = { requests: 0, found: 0, empty: 0, failed: 0, skippedBudget: 0 };

  constructor(private readonly client: PropLineClient, private readonly file: string | null,
    /** PropLine's own sport key for a game it listed (soccer needs it: one key per league). */
    private readonly sportKeyForEvent: (eventId: string) => string | null = () => null,
    private readonly options: { dailyRequests?: number; concurrency?: number; ttlMs?: number } = {},
    private readonly clock: () => number = Date.now) {}

  sportKey(line: Pick<PropLine, 'sport' | 'eventId'> & { league?: string | null }): string | null {
    return this.sportKeyForEvent(line.eventId) ?? SOCCER_KEYS[(line.league ?? '').toUpperCase()] ?? SPORT_KEYS[sportOf(line)] ?? null;
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as [string, Entry][];
      const cutoff = this.clock() - (this.options.ttlMs ?? 6 * 3600_000);
      for (const [key, entry] of saved) if (entry.at > cutoff) this.cache.set(key, entry);
    } catch { /* first run */ }
  }

  async save(): Promise<void> {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    const cutoff = this.clock() - 2 * (this.options.ttlMs ?? 6 * 3600_000);
    for (const [key, entry] of this.cache) if (entry.at < cutoff) this.cache.delete(key);
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.cache]));
    await rename(temporary, this.file);
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= (this.options.concurrency ?? 3)) await new Promise<void>((done) => this.waiting.push(done));
    this.active++;
    try { return await work(); } finally { this.active--; this.waiting.shift()?.(); }
  }

  /** A player's recent games (cached 6 hours, a player PropLine doesn't know too); undefined when it couldn't be asked. */
  private async games(sportKey: string, playerName: string): Promise<readonly Game[] | null | undefined> {
    await this.load();
    const key = `${sportKey}|${normalizedName(playerName)}`, now = this.clock();
    const cached = this.cache.get(key);
    if (cached && now - cached.at < (this.options.ttlMs ?? 6 * 3600_000)) return cached.games;
    const pending = this.loading.get(key);
    if (pending) return pending;
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.stats.requests = 0; }
    if (this.stats.requests >= (this.options.dailyRequests ?? 40_000)) { this.stats.skippedBudget++; return undefined; }
    this.stats.requests++;
    const request = this.slot(async () => {
      const body = await this.client.get<{ games?: { commence_time?: string; status?: string; opponent?: string | null;
        stats?: Record<string, unknown> }[] }>(`/v1/sports/${sportKey}/players/${encodeURIComponent(playerName)}/games?limit=30`);
      return (body.games ?? []).flatMap((game): Game[] => {
        if (game.status !== 'final' || !game.commence_time || Number.isNaN(Date.parse(game.commence_time))) return [];
        // NFL preseason (July and August) is not the player's real workload.
        if (sportKey === 'football_nfl' && /^\d{4}-0[78]-/.test(game.commence_time)) return [];
        const stats = Object.fromEntries(Object.entries(game.stats ?? {}).filter((entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1])));
        return [{ at: new Date(game.commence_time).toISOString(), opponent: game.opponent ?? null, stats }];
      });
    }).then((games) => {
      const found = games.length ? games : null;
      if (found) this.stats.found++; else this.stats.empty++;
      this.cache.set(key, { at: this.clock(), games: found });
      this.dirty = true;
      return found;
    }).finally(() => this.loading.delete(key));
    this.loading.set(key, request);
    try { return await request; } catch { this.stats.failed++; return undefined; }
  }

  /**
   * The player's values for the line's stat from games before it (newest first), or null when PropLine has none.
   * 'PENDING' when the player's games haven't arrived within `waitMs`: the request keeps going and the next call reads it,
   * so a caller never waits on PropLine.
   */
  async values(line: Pick<PropLine, 'sport' | 'eventId' | 'eventStartTime' | 'playerName' | 'market'> & { league?: string | null },
    waitMs = Infinity): Promise<{ values: number[]; source: string } | null | 'PENDING'> {
    const read = proplineStat(sportOf(line), line.market), sportKey = this.sportKey(line);
    // A soccer line with no league to go on tries PropLine's soccer leagues in turn (each answer is kept 6 hours).
    const keys = sportKey ? [sportKey] : line.sport === 'SOCCER' ? Object.values(SOCCER_KEYS) : [];
    if (!read || !keys.length) return null;
    const request = (async () => {
      for (const key of keys) { const games = await this.games(key, line.playerName); if (games !== null) return games; }
      return null;
    })();
    const games = Number.isFinite(waitMs) ? await Promise.race([request, new Promise<'PENDING'>((done) => {
      setTimeout(() => done('PENDING'), waitMs); })]) : await request;
    if (games === 'PENDING') return 'PENDING';
    if (!games) return null;
    const values = valuesFrom(games, read, Date.parse(line.eventStartTime));
    return values.length ? { values, source: 'PropLine box scores' } : null;
  }

  status() { return { ...this.stats, players: this.cache.size }; }
}
