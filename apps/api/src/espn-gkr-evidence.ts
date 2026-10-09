import { createHash } from 'node:crypto';
import type { HistoryArchive } from './history-archive.js';
import type { Evidence, PropLine } from '@crowniq/contracts';
import { evidenceSchema } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from '@crowniq/engine';
import { matchGame, normalizedPlayer, sharedName } from './box-score-results.js';
import type { Game } from './box-score-results.js';
import { historyEvidence } from './stat-api-gkr-evidence.js';
import { fantasyValue } from './fantasy-history.js';
import type { FantasyApp } from './fantasy-history.js';
import type { HistorySpec } from './stat-api-gkr-evidence.js';

// GKR history for the sports the Stat API doesn't cover (owner approved 2026-10-04: "GKR should score everything"):
// NHL, soccer and college football, from ESPN's public game logs. The player is found on the two teams' ESPN rosters,
// which also say whether he is active and uninjured; that availability is the hard status gate these models need.

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const COMMON = 'https://site.api.espn.com/apis/common/v3/sports';
const paths: Readonly<Record<string, string>> = { NHL: 'hockey/nhl', NCAAFB: 'football/college-football', SOCCER: 'soccer/all',
  WNBA: 'basketball/wnba',
  // Fantasy score lines only (History Read and Edge): these sports have no ESPN spec, so GKR never reads them here.
  NFL: 'football/nfl', NBA: 'basketball/nba', MLB: 'baseball/mlb' };

type Row = { occurredAt: string | null; opponent?: string | null; metrics: Readonly<Record<string, number>> };
const n = (row: Row, key: string) => Number.isFinite(row.metrics[key]) ? row.metrics[key] : null;
const ratio = (a: number | null, b: number | null) => a !== null && b !== null && b !== 0 ? a / b : null;
const sum = (...values: (number | null)[]) => values.every((value) => value !== null)
  ? values.reduce((total, value) => total + (value ?? 0), 0) : null;
const spec = (value: (r: Row) => number | null, unit: string, factors: HistorySpec['factors']): HistorySpec =>
  ({ value, unit, factors });

const shots = (r: Row) => n(r, 'shotsTotal'), points = (r: Row) => n(r, 'points');
const nhlSkater = (value: (r: Row) => number | null, unit: string, extra: HistorySpec['factors'] = {}) => spec(value, unit,
  { shot_volume: shots, ice_time: (r) => n(r, 'timeOnIcePerGame'), power_play_role: (r) => sum(n(r, 'powerPlayGoals'),
    n(r, 'powerPlayAssists')), recent_involvement: points, ...extra });
const soccerSpec = (value: (r: Row) => number | null, unit: string) => spec(value, unit, {
  shot_volume: (r) => n(r, 'totalShots'), on_target_rate: (r) => ratio(n(r, 'shotsOnTarget'), n(r, 'totalShots')),
  goal_involvement: (r) => sum(n(r, 'totalGoals'), n(r, 'goalAssists')), historical_volume: value });
const cfbPass = (value: (r: Row) => number | null, unit: string) => spec(value, unit, {
  expected_attempts: (r) => n(r, 'passingAttempts'), efficiency: (r) => ratio(n(r, 'passingYards'), n(r, 'passingAttempts')),
  historical_volume: value });
const cfbRush = (value: (r: Row) => number | null, unit: string) => spec(value, unit, {
  expected_carries: (r) => n(r, 'rushingAttempts'), yards_per_carry: (r) => ratio(n(r, 'rushingYards'), n(r, 'rushingAttempts')),
  historical_volume: value });
const cfbReceive = (value: (r: Row) => number | null, unit: string) => spec(value, unit, {
  target_share: (r) => n(r, 'receivingTargets') ?? n(r, 'receptions'),
  receiving_efficiency: (r) => ratio(n(r, 'receivingYards'), n(r, 'receptions')), historical_volume: value });

/** College touchdowns (rushing + receiving) and scrimmage yards, with the touches behind them. */
const touchesOf = (r: Row) => sum(n(r, 'rushingAttempts') ?? 0, n(r, 'receptions') ?? 0);
const cfbTouchdowns = spec((r) => sum(n(r, 'rushingTouchdowns') ?? 0, n(r, 'receivingTouchdowns') ?? 0), 'touchdowns', {
  expected_touches: touchesOf, historical_volume: (r) => sum(n(r, 'rushingTouchdowns') ?? 0, n(r, 'receivingTouchdowns') ?? 0) });
const cfbScrimmage = spec((r) => sum(n(r, 'rushingYards') ?? 0, n(r, 'receivingYards') ?? 0), 'yards', {
  expected_touches: touchesOf, historical_volume: (r) => sum(n(r, 'rushingYards') ?? 0, n(r, 'receivingYards') ?? 0) });

/** WNBA box-score stats under every key the apps' labels become (PrizePicks, Underdog and Pick6 name them differently). */
function wnbaSpecs(): Record<string, HistorySpec> {
  const minutes = (r: Row) => n(r, 'minutes');
  const hoops = (value: (r: Row) => number | null, unit: string) => spec(value, unit, { minutes, historical_volume: value });
  const pts = (r: Row) => n(r, 'points'), reb = (r: Row) => n(r, 'totalRebounds'), ast = (r: Row) => n(r, 'assists');
  const stl = (r: Row) => n(r, 'steals'), blk = (r: Row) => n(r, 'blocks');
  const made = (name: string) => (r: Row) => n(r, `${name}Made`), tried = (name: string) => (r: Row) => n(r, `${name}Attempted`);
  const twos = (r: Row) => { const all = n(r, 'fieldGoalsMade'), threes = n(r, 'threePointFieldGoalsMade');
    return all !== null && threes !== null ? all - threes : null; };
  const table: [readonly string[], (r: Row) => number | null, string][] = [
    [['player_points', 'points'], pts, 'points'], [['player_rebounds', 'rebounds'], reb, 'rebounds'],
    [['player_assists', 'assists'], ast, 'assists'],
    [['player_points_rebounds_assists', 'pts_plus_rebs_plus_asts', 'pra', 'player_points_plus_rebounds_plus_assists',
      'points_plus_rebounds_plus_assists'], (r) => sum(pts(r), reb(r), ast(r)), 'points+rebounds+assists'],
    [['player_points_rebounds', 'pts_plus_rebs', 'player_points_plus_rebounds', 'points_plus_rebounds'], (r) => sum(pts(r), reb(r)), 'points+rebounds'],
    [['player_points_assists', 'pts_plus_asts', 'player_points_plus_assists', 'points_plus_assists'], (r) => sum(pts(r), ast(r)), 'points+assists'],
    [['player_rebounds_assists', 'rebs_plus_asts', 'player_rebounds_plus_assists', 'rebounds_plus_assists', 'assists_plus_rebounds'],
      (r) => sum(reb(r), ast(r)), 'rebounds+assists'],
    [['player_threes', '3_pointers_made', '3_pt_made', 'threes', '3ptm', 'player_made_threes'], made('threePointFieldGoals'), 'threes'],
    [['3_pt_attempted', '3_pointers_attempted', 'player_threes_attempted'], tried('threePointFieldGoals'), 'three attempts'],
    [['steals', 'player_steals'], stl, 'steals'], [['blocked_shots', 'blocks', 'player_blocks'], blk, 'blocks'],
    [['blks_plus_stls', 'blocks_plus_steals', 'player_blocks_steals', 'stocks'], (r) => sum(blk(r), stl(r)), 'blocks+steals'],
    [['turnovers', 'player_turnovers'], (r) => n(r, 'turnovers'), 'turnovers'],
    [['fg_made', 'field_goals_made'], made('fieldGoals'), 'field goals'], [['fg_attempted', 'field_goals_attempted'], tried('fieldGoals'), 'shots'],
    [['free_throws_made', 'ft_made'], made('freeThrows'), 'free throws'], [['free_throws_attempted', 'ft_attempted'], tried('freeThrows'), 'free throw attempts'],
    [['two_pointers_made'], twos, 'two-pointers'], [['personal_fouls', 'fouls'], (r) => n(r, 'fouls'), 'fouls'],
  ];
  return Object.fromEntries(table.flatMap(([keys, value, unit]) => keys.map((key) => [key, hoops(value, unit)])));
}

/**
 * Stats the player page shows that no GKR model reads from ESPN (touchdowns): kept apart from espnSpecs so GKR's
 * evidence never changes. Each is a plain value from the game-log row.
 */
export const displaySpecs: Readonly<Record<string, Readonly<Record<string, (r: Row) => number | null>>>> = {
  NCAAFB: { player_rush_rec_yds: (r) => sum(n(r, 'rushingYards') ?? 0, n(r, 'receivingYards') ?? 0) },
};

/** ESPN game-log columns behind each market. Stats ESPN's logs don't carry (hits, faceoffs, tackles) aren't listed. */
export const espnSpecs: Readonly<Record<string, Readonly<Record<string, HistorySpec>>>> = {
  NHL: {
    shots_on_goal: nhlSkater(shots, 'shots on goal'), sog: nhlSkater(shots, 'shots on goal'),
    goals: nhlSkater((r) => n(r, 'goals'), 'goals', { shooting_rate: (r) => ratio(n(r, 'goals'), shots(r)) }),
    assists: nhlSkater((r) => n(r, 'assists'), 'assists'), player_assists: nhlSkater((r) => n(r, 'assists'), 'assists'),
    points: nhlSkater(points, 'points'), plus_minus: nhlSkater((r) => n(r, 'plusMinus'), 'plus/minus'),
    saves: spec((r) => n(r, 'saves'), 'saves', { expected_shots_against: (r) => n(r, 'shotsAgainst'),
      save_rate: (r) => ratio(n(r, 'saves'), n(r, 'shotsAgainst')), historical_volume: (r) => n(r, 'saves') }),
  },
  SOCCER: {
    shots: soccerSpec((r) => n(r, 'totalShots'), 'shots'), sot: soccerSpec((r) => n(r, 'shotsOnTarget'), 'shots on target'),
    goals: soccerSpec((r) => n(r, 'totalGoals'), 'goals'), assists: soccerSpec((r) => n(r, 'goalAssists'), 'assists'),
    goal_plus_assist: soccerSpec((r) => sum(n(r, 'totalGoals'), n(r, 'goalAssists')), 'goals+assists'),
    fouls: spec((r) => n(r, 'foulsCommitted'), 'fouls', { historical_volume: (r) => n(r, 'foulsCommitted'),
      fouls_drawn: (r) => n(r, 'foulsSuffered') }),
    goalie_saves: spec((r) => n(r, 'saves'), 'saves', { historical_volume: (r) => n(r, 'saves'),
      expected_shots_against: (r) => n(r, 'shotsFaced') }),
  },
  // WNBA: History Read and Edge, and GKR's stat-history set 4 models (owner approved 2026-10-07).
  WNBA: wnbaSpecs(),
  NCAAFB: {
    passing_yards: cfbPass((r) => n(r, 'passingYards'), 'yards'),
    player_pass_attempts: cfbPass((r) => n(r, 'passingAttempts'), 'attempts'),
    player_pass_completions: cfbPass((r) => n(r, 'completions'), 'completions'),
    player_pass_tds: cfbPass((r) => n(r, 'passingTouchdowns'), 'touchdowns'),
    player_rush_yds: cfbRush((r) => n(r, 'rushingYards'), 'yards'),
    player_rush_attempts: cfbRush((r) => n(r, 'rushingAttempts'), 'attempts'),
    player_reception_yds: cfbReceive((r) => n(r, 'receivingYards'), 'yards'),
    player_receptions: cfbReceive((r) => n(r, 'receptions'), 'receptions'),
    // Stat-history set 4 (owner approved 2026-10-07: "expand GKR history to other sports").
    recs: cfbReceive((r) => n(r, 'receptions'), 'receptions'),
    anytime_tds: cfbTouchdowns, rush_plus_rec_td_scorer: cfbTouchdowns,
    rec_tds: cfbReceive((r) => n(r, 'receivingTouchdowns'), 'touchdowns'),
    rush_tds: cfbRush((r) => n(r, 'rushingTouchdowns'), 'touchdowns'),
    pass_tds: cfbPass((r) => n(r, 'passingTouchdowns'), 'touchdowns'),
    int: cfbPass((r) => n(r, 'interceptions'), 'interceptions'),
    player_pass_interceptions: cfbPass((r) => n(r, 'interceptions'), 'interceptions'),
    rush_plus_rec_yds: cfbScrimmage, player_rush_reception_yds: cfbScrimmage,
    longest_rec: cfbReceive((r) => n(r, 'longReception'), 'yards'),
    longest_rush: cfbRush((r) => n(r, 'longRushing'), 'yards'),
  },
};

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
/** ESPN cells as numbers; "15:51" (minutes:seconds) becomes 15.85 minutes. */
function cell(raw: unknown): number | null {
  const value = str(raw).trim();
  const clock = /^(\d+):(\d{2})$/.exec(value);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  const number = Number(value.replace(/^\+/, ''));
  return value !== '' && Number.isFinite(number) ? number : null;
}

/** A player's ESPN game log as rows: one per game (preseason left out), dated from the log's event list. */
export function gameLogRows(log: unknown): Row[] {
  const root = obj(log), names = arr(root?.names).map(str), events = obj(root?.events) ?? {};
  const rows = new Map<string, Row>();
  for (const type of arr(root?.seasonTypes)) {
    if (/preseason/i.test(str(obj(type)?.displayName))) continue;
    for (const category of arr(obj(type)?.categories)) for (const value of arr(obj(category)?.events)) {
      const entry = obj(value), id = str(entry?.eventId), stats = arr(entry?.stats);
      if (!id || rows.has(id)) continue;
      const metrics: Record<string, number> = {};
      names.forEach((name, index) => {
        // Basketball pairs made and attempted in one column: "fieldGoalsMade-fieldGoalsAttempted" = "2-5".
        const pair = /^(\w+)-(\w+)$/.exec(name), cells = /^(\d+)-(\d+)$/.exec(str(stats[index]).trim());
        if (pair && cells) { metrics[pair[1]!] = Number(cells[1]); metrics[pair[2]!] = Number(cells[2]); return; }
        // A pitcher's decision: "W(2-1)", "L(0-1)" or "-".
        if (name === 'wins-losses') { metrics.win = /^W/.test(str(stats[index]).trim()) ? 1 : 0; return; }
        const number = cell(stats[index]); if (name && number !== null) metrics[name] = number;
      });
      const date = str(obj(events[id])?.gameDate);
      const opponent = obj(obj(events[id])?.opponent), atVs = str(obj(events[id])?.atVs);
      const against = str(opponent?.abbreviation) || str(opponent?.displayName);
      rows.set(id, { occurredAt: date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null, metrics,
        opponent: against ? `${atVs === '@' ? '@ ' : 'vs '}${against}` : null });
    }
  }
  return [...rows.values()];
}

type Athlete = { id: string; name: string; team: readonly string[]; available: boolean; starter: boolean | null };
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

export interface EspnGkrEvidenceOptions {
  readonly clock?: () => Date;
  readonly allowedKeys?: readonly string[];
  readonly maxPlayers?: number;
  readonly minSamples?: number;
  readonly recentSamples?: number;
  /** Every game log fetched goes to CrownIQ's own archive (display and verification only). */
  readonly archive?: HistoryArchive | null;
}

export class EspnGkrEvidence implements ResearchAdapter {
  readonly id = 'espn-history-v1';
  private readonly clock: () => Date;
  private readonly allowedKeys: ReadonlySet<string> | null;
  private readonly cache = new Map<string, { until: number; value: Promise<unknown> }>();
  private health: ResearchHealth = { status: 'OK', targets: 0, searches: 0, cacheHits: 0, skipped: 0, failures: 0,
    lastRunAt: null };
  constructor(private readonly fetchFn: typeof fetch = fetch, private readonly options: EspnGkrEvidenceOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.allowedKeys = options.allowedKeys ? new Set(options.allowedKeys) : null;
  }
  getHealth(): ResearchHealth { return this.health; }

  supports(target: ResearchTarget): boolean {
    return !!espnSpecs[target.sport]?.[target.market] && Date.parse(target.eventStartTime) > this.clock().getTime() &&
      (!this.allowedKeys || this.allowedKeys.has(`${target.sport}:${target.market}`));
  }

  private json(url: string, ttlMs: number, counters: { searches: number; cacheHits: number }): Promise<unknown> {
    const now = this.clock().getTime(), cached = this.cache.get(url);
    if (cached && cached.until > now) { counters.cacheHits++; return cached.value; }
    counters.searches++;
    const value = (async () => {
      const response = await this.fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`ESPN_HTTP_${response.status}`);
      return response.json() as Promise<unknown>;
    })();
    this.cache.set(url, { until: now + ttlMs, value });
    value.catch(() => this.cache.delete(url));
    return value;
  }

  /** The ESPN game for this event and the two teams' rosters (for soccer, the league comes from the game). */
  /** The board game's ESPN event (by date and teams), or null. */
  private async boardGame(first: ResearchTarget, counters: { searches: number; cacheHits: number }) {
    const path = paths[first.sport], start = Date.parse(first.eventStartTime);
    const days = [...new Set([new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(start)),
      new Date(start).toISOString().slice(0, 10)])];
    const games: (Game & { teams: string[] })[] = [];
    for (const day of days) {
      const params = new URLSearchParams({ dates: day.replaceAll('-', ''), limit: '1000' });
      if (first.sport === 'NCAAFB') params.set('groups', '80');
      const body = obj(await this.json(`${SITE}/${path}/scoreboard?${params}`, 30 * 60_000, counters));
      for (const value of arr(body?.events)) {
        const event = obj(value), competition = obj(arr(event?.competitions)[0]), eventStart = Date.parse(str(event?.date));
        const competitors = arr(competition?.competitors).map((item) => obj(obj(item)?.team));
        if (!event || !Number.isFinite(eventStart) || competitors.length !== 2) continue;
        games.push({ id: str(event.id), start: eventStart, final: false, teams: competitors.map((team) => str(team?.id)),
          sides: competitors.map((team) => ['displayName', 'shortDisplayName', 'name', 'location', 'abbreviation']
            .map((key) => str(team?.[key])).filter(Boolean)) });
      }
    }
    const game = matchGame(first as unknown as PropLine, [...new Map(games.map((item) => [item.id, item])).values()]) as
      (Game & { teams: string[] }) | null;
    return game;
  }

  private async rosters(first: ResearchTarget, counters: { searches: number; cacheHits: number }) {
    const path = paths[first.sport];
    const game = await this.boardGame(first, counters);
    if (!game) return null;
    let rosterPath = path;
    const starters = new Map<string, boolean>();
    if (first.sport === 'SOCCER') {
      // The game summary names the league; its rosters hold the lineups once they are posted (about an hour before).
      const summary = obj(await this.json(`${SITE}/soccer/all/summary?event=${game.id}`, 10 * 60_000, counters));
      const league = str(obj(obj(summary?.header)?.league)?.slug);
      if (!league) return null;
      rosterPath = `soccer/${league}`;
      for (const side of arr(summary?.rosters)) for (const entry of arr(obj(side)?.roster)) {
        const id = str(obj(obj(entry)?.athlete)?.id);
        if (id && typeof obj(entry)?.starter === 'boolean') starters.set(id, obj(entry)!.starter as boolean);
      }
    }
    const athletes: Athlete[] = [];
    for (const [index, teamId] of game.teams.entries()) {
      const roster = obj(await this.json(`${SITE}/${rosterPath}/teams/${teamId}/roster`, 30 * 60_000, counters));
      // Hockey and soccer rosters are flat; football groups them ({items:[...]}).
      for (const entry of arr(roster?.athletes).flatMap((item) => Array.isArray(obj(item)?.items) ? arr(obj(item)!.items) : [item])) {
        const athlete = obj(entry), id = str(athlete?.id), name = str(athlete?.fullName) || str(athlete?.displayName);
        if (!id || !name) continue;
        const status = str(obj(athlete?.status)?.type).toLowerCase();
        athletes.push({ id, name, team: game.sides[index] ?? [], available: (status === '' || status === 'active') && arr(athlete?.injuries).length === 0,
          starter: starters.size ? starters.get(id) ?? false : null });
      }
    }
    return { athletes, url: `${SITE}/${rosterPath}/teams/${game.teams.join(',')}/roster` };
  }

  private async gameLog(sport: string, athleteId: string, counters: { searches: number; cacheHits: number }) {
    const base = `${COMMON}/${paths[sport]}/athletes/${athleteId}/gamelog`;
    const current = await this.json(base, 3 * 3600_000, counters);
    let rows = gameLogRows(current);
    // Early in a season, add last season so there are enough games to read.
    if (rows.length < 10) {
      const seasons = arr(obj(arr(obj(current)?.filters).find((item) => str(obj(item)?.name) === 'season'))?.options)
        .map((item) => str(obj(item)?.value)).filter(Boolean);
      const previous = seasons[1];
      if (previous) rows = [...rows, ...gameLogRows(await this.json(`${base}?season=${previous}`, 12 * 3600_000, counters))];
    }
    return { rows, sourceUrl: base, retrievedAt: this.clock().toISOString() };
  }

  /** A player's last 15 values for this line's stat before its game, from the ESPN game log (History Read uses it). */
  async recentValues(target: ResearchTarget): Promise<number[] | null> {
    const spec = espnSpecs[target.sport]?.[target.market];
    if (!spec) return null;
    const counters = { searches: 0, cacheHits: 0 };
    const rosters = await this.rosters(target, counters);
    if (!rosters) return null;
    const matches = sharedName(rosters.athletes.filter((athlete) => normalizedPlayer(athlete.name) === normalizedPlayer(target.playerName)),
      target.team, (athlete) => athlete.team);
    if (matches.length !== 1) return null;
    const log = await this.gameLog(target.sport, matches[0].id, counters);
    const before = Date.parse(target.eventStartTime);
    return log.rows.filter((row) => !row.occurredAt || Date.parse(row.occurredAt) < before)
      .sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''))
      .map((row) => spec.value(row)).filter((value): value is number => value !== null && Number.isFinite(value)).slice(0, 15);
  }

  /**
   * Both teams' last finished fixtures before a soccer line's game (ESPN team schedules), newest first: the matches to
   * look up for players' full stats.
   */
  async soccerFixtures(target: ResearchTarget, perTeam = 6): Promise<{ date: string; home: string; away: string }[]> {
    if (target.sport !== 'SOCCER') return [];
    const counters = { searches: 0, cacheHits: 0 };
    const game = await this.boardGame(target, counters);
    if (!game) return [];
    const summary = obj(await this.json(`${SITE}/soccer/all/summary?event=${game.id}`, 6 * 3600_000, counters));
    const league = str(obj(obj(summary?.header)?.league)?.slug);
    if (!league) return [];
    const before = Date.parse(target.eventStartTime), out = new Map<string, { date: string; home: string; away: string }>();
    for (const teamId of game.teams) {
      const schedule = obj(await this.json(`${SITE}/soccer/${league}/teams/${teamId}/schedule`, 12 * 3600_000, counters).catch(() => null));
      const finished = arr(schedule?.events).flatMap((value) => {
        const event = obj(value), competition = obj(arr(event?.competitions)[0]), date = str(event?.date);
        if (obj(obj(competition?.status)?.type)?.completed !== true || !(Date.parse(date) < before)) return [];
        const sides = arr(competition?.competitors).map((item) => obj(item));
        const home = sides.find((side) => side?.homeAway === 'home'), away = sides.find((side) => side?.homeAway === 'away');
        const name = (side: Json | null | undefined) => str(obj(side?.team)?.displayName);
        return home && away && name(home) && name(away) ? [{ date, home: name(home), away: name(away) }] : [];
      }).sort((a, b) => b.date.localeCompare(a.date)).slice(0, perTeam);
      for (const fixture of finished) out.set(`${fixture.date}|${fixture.home}`, fixture);
    }
    return [...out.values()].sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * The player page's game log: a player's last 15 games for a stat (date, opponent, value), from the same ESPN logs
   * History Read uses. Display only; GKR's evidence is unchanged.
   */
  async recentGames(target: ResearchTarget): Promise<{ date: string; opponent: string | null; value: number }[] | null> {
    const spec = espnSpecs[target.sport]?.[target.market]?.value ?? displaySpecs[target.sport]?.[target.market];
    if (!spec || !paths[target.sport]) return null;
    const counters = { searches: 0, cacheHits: 0 };
    const rosters = await this.rosters(target, counters);
    if (!rosters) return null;
    const matches = sharedName(rosters.athletes.filter((athlete) => normalizedPlayer(athlete.name) === normalizedPlayer(target.playerName)),
      target.team, (athlete) => athlete.team);
    if (matches.length !== 1) return null;
    const log = await this.gameLog(target.sport, matches[0].id, counters);
    const before = Date.parse(target.eventStartTime);
    return log.rows.filter((row) => row.occurredAt && Date.parse(row.occurredAt) < before)
      .sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''))
      .flatMap((row) => { const value = spec(row); return value !== null && Number.isFinite(value)
        ? [{ date: row.occurredAt!.slice(0, 10), opponent: row.opponent ?? null, value }] : []; }).slice(0, 15);
  }

  /** A player's last 15 fantasy scores before this game, scored by one app's chart (History Read and Edge). */
  async recentFantasy(target: ResearchTarget, app: FantasyApp): Promise<number[] | null> {
    if (!paths[target.sport]) return null;
    const counters = { searches: 0, cacheHits: 0 };
    const rosters = await this.rosters(target, counters);
    if (!rosters) return null;
    const matches = sharedName(rosters.athletes.filter((athlete) => normalizedPlayer(athlete.name) === normalizedPlayer(target.playerName)),
      target.team, (athlete) => athlete.team);
    if (matches.length !== 1) return null;
    const log = await this.gameLog(target.sport, matches[0].id, counters);
    const before = Date.parse(target.eventStartTime);
    return log.rows.filter((row) => !row.occurredAt || Date.parse(row.occurredAt) < before)
      .sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''))
      .map((row) => fantasyValue(app, target.sport, target.market, row))
      .filter((value): value is number => value !== null && Number.isFinite(value)).slice(0, 15);
  }

  async research(targets: readonly ResearchTarget[]): Promise<readonly Evidence[]> {
    const now = this.clock(), eligible = targets.filter((target) => this.supports(target));
    const counters = { searches: 0, cacheHits: 0 };
    let failures = 0, skipped = targets.length - eligible.length, noSources = 0;
    const byGame = new Map<string, ResearchTarget[]>();
    // Soonest games first, so the player cap never leaves tonight's games unresearched while next week's are done.
    const soonest = [...eligible].sort((a, b) => a.eventStartTime.localeCompare(b.eventStartTime));
    for (const target of soonest) byGame.set(target.eventId, [...byGame.get(target.eventId) ?? [], target]);
    const evidence: Evidence[] = [];
    let players = 0;
    for (const group of byGame.values()) {
      let rosters;
      try { rosters = await this.rosters(group[0], counters); } catch { failures++; continue; }
      if (!rosters) { noSources += group.length; continue; }
      const byPlayer = new Map<string, ResearchTarget[]>();
      for (const target of group) byPlayer.set(target.playerId, [...byPlayer.get(target.playerId) ?? [], target]);
      for (const playerTargets of byPlayer.values()) {
        if (players >= (this.options.maxPlayers ?? 1500)) { skipped += playerTargets.length; continue; }
        const first = playerTargets[0], wanted = normalizedPlayer(first.playerName);
        const matches = sharedName(rosters.athletes.filter((athlete) => normalizedPlayer(athlete.name) === wanted), first.team,
          (athlete) => athlete.team);
        if (matches.length !== 1) { noSources += playerTargets.length; continue; }
        players++;
        const athlete = matches[0];
        const expiresAt = new Date(Math.min(Date.parse(first.eventStartTime), now.getTime() + 2 * 3600_000)).toISOString();
        evidence.push(evidenceSchema.parse({ id: 'espn-status:' + hash(JSON.stringify([first.eventId, first.playerId,
          athlete.available, Math.floor(now.getTime() / 900_000)])), entityType: 'PLAYER', entityId: first.playerId,
        eventId: first.eventId, market: null, kind: 'status:player_available',
        finding: athlete.available ? 'ESPN team roster lists this player active with no injury.'
          : 'ESPN team roster does not list this player as active and uninjured.',
        sourceName: 'ESPN team rosters', sourceUrl: rosters.url, sourceType: 'PUBLIC', retrievedAt: now.toISOString(),
        expiresAt, quality: 'MEDIUM', confidence: 0.85, numeric: { value: athlete.available ? 1 : 0 } }));
        if (athlete.starter !== null) evidence.push(evidenceSchema.parse({ id: 'espn-lineup:' + hash(JSON.stringify([first.eventId,
          first.playerId, athlete.starter])), entityType: 'PLAYER', entityId: first.playerId, eventId: first.eventId, market: null,
        kind: 'status:starting_lineup', finding: athlete.starter ? 'ESPN posted lineup has this player starting.'
          : 'ESPN posted lineup does not have this player starting.', sourceName: 'ESPN game lineups',
        sourceUrl: `${SITE}/soccer/all/summary?event=${first.eventId}`, sourceType: 'PUBLIC', retrievedAt: now.toISOString(),
        expiresAt: first.eventStartTime, quality: 'HIGH', confidence: 0.95, numeric: { value: athlete.starter ? 1 : 0 } }));
        try {
          const log = await this.gameLog(first.sport, athlete.id, counters);
          void this.options.archive?.append('games', log.rows.filter((row) => row.occurredAt).map((row) => ({
            key: `espn:${first.sport}:${athlete.id}:${row.occurredAt}`,
            record: { source: 'ESPN game logs', sourceUrl: log.sourceUrl, sport: first.sport, league: first.league,
              athleteId: athlete.id, playerName: athlete.name, occurredAt: row.occurredAt, metrics: row.metrics } })));
          for (const target of playerTargets) evidence.push(...historyEvidence(target, espnSpecs[target.sport][target.market],
            log, now, { minSamples: this.options.minSamples ?? 5, recentSamples: this.options.recentSamples ?? 10,
              sourceName: 'ESPN game logs', sourceLabel: 'ESPN', sourceType: 'PUBLIC', idPrefix: 'espn:' }));
        } catch { failures++; }
      }
    }
    this.health = { status: failures ? evidence.length ? 'PARTIAL' : 'FAILED' : 'OK', targets: targets.length,
      searches: counters.searches, cacheHits: counters.cacheHits, skipped, failures, noSources, lastRunAt: now.toISOString() };
    return evidence;
  }
}
