import type { PropLine } from '@crowniq/contracts';
import type { HistoryArchive } from './history-archive.js';
import type { ResultFact } from './product-ledger.js';

// Final results for saved picks from public box scores: MLB's official Stats API for baseball, ESPN's public box
// scores for NFL, college football, NBA, WNBA, NHL and soccer. Grading only: nothing here feeds a GKR score.
// A pick is graded only when its game is final and the player matches exactly one box-score row; anything less
// stays pending. A DNP is recorded only when the box score itself says the player did not play.

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const MLB = 'https://statsapi.mlb.com/api/v1';
/** Box scores settle a little after the final whistle; earlier tries only waste requests. */
const SETTLE_MS = 3 * 3600_000;
const HOUR = 3600_000;

export interface GradeTarget { readonly eventId: string; readonly playerId: string; readonly lineSnapshot: PropLine }
export interface BoxScoreReport {
  facts: ResultFact[];
  /** Picks whose sport or stat cannot be read from a box score (quarter splits, esports, fantasy scores). */
  unsupported: number;
  /** Supported picks still waiting: game not final yet, or no exact game/player match. */
  waiting: number;
}

type Stats = Readonly<Record<string, number>>;
type Row = { name: string; team: string; stats: Stats; dnp: boolean };
type Read = (stats: Stats) => number | null;
type Json = Record<string, unknown>;

const obj = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown) => typeof value === 'string' ? value : '';
export const normalizedPlayer = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[.'’]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const stat = (key: string): Read => (stats) => stats[key] ?? null;
/** A total of stats where a missing part is zero (the player is in the box score, just not in that category). */
const total = (...keys: string[]): Read => (stats) => keys.reduce((sum, key) => sum + (stats[key] ?? 0), 0);
/** Like `stat`, but zero when the player is in the box score without that category (e.g. no carries). */
const orZero = (key: string): Read => (stats) => stats[key] ?? 0;

const football: Readonly<Record<string, Read>> = {
  passing_yards: stat('passing.passingYards'), pass_yards: stat('passing.passingYards'),
  player_pass_attempts: stat('passing.passingAttempts'), pass_attempts: stat('passing.passingAttempts'),
  player_pass_completions: stat('passing.completions'), pass_comp: stat('passing.completions'),
  player_pass_tds: stat('passing.passingTouchdowns'), pass_tds: stat('passing.passingTouchdowns'),
  player_pass_interceptions: stat('passing.interceptions'),
  player_rush_yds: orZero('rushing.rushingYards'), rush_yards: orZero('rushing.rushingYards'),
  player_rush_attempts: orZero('rushing.rushingAttempts'), rush_atts: orZero('rushing.rushingAttempts'),
  rush_tds: orZero('rushing.rushingTouchdowns'),
  player_rush_longest: orZero('rushing.longRushing'), longest_rush: orZero('rushing.longRushing'),
  player_reception_yds: orZero('receiving.receivingYards'), rec_yards: orZero('receiving.receivingYards'),
  player_receptions: orZero('receiving.receptions'), recs: orZero('receiving.receptions'),
  player_receiving_targets: stat('receiving.receivingTargets'),
  player_reception_longest: orZero('receiving.longReception'), longest_rec: orZero('receiving.longReception'),
  player_rush_reception_yds: total('rushing.rushingYards', 'receiving.receivingYards'),
  rush_plus_rec_yds: total('rushing.rushingYards', 'receiving.receivingYards'),
  player_pass_rush_yds: total('passing.passingYards', 'rushing.rushingYards'),
  pass_plus_rush_yds: total('passing.passingYards', 'rushing.rushingYards'),
  anytime_tds: total('rushing.rushingTouchdowns', 'receiving.receivingTouchdowns'),
  player_tackles_assists: orZero('defensive.totalTackles'),
  // A quarterback's "Sacks" are sacks taken (passing); everyone else's are sacks made (defensive).
  player_sacks: (s) => (s['passing.passingAttempts'] ?? 0) > 0 ? s['passing.sacks'] ?? 0 : s['defensive.sacks'] ?? 0,
  player_kicking_points: stat('kicking.totalKickingPoints'),
  player_field_goals: stat('kicking.fieldGoalsMade'), fg_made: stat('kicking.fieldGoalsMade'),
  player_punts: stat('punting.punts'), player_solo_tackles: orZero('defensive.soloTackles'),
  player_defensive_interceptions: orZero('interceptions.interceptions'), player_fumbles_lost: orZero('fumbles.fumblesLost'),
  player_extra_points: stat('kicking.extraPointsMade'),
};
const basketball: Readonly<Record<string, Read>> = {
  player_points: stat('points'), points: stat('points'), player_rebounds: stat('rebounds'),
  player_assists: stat('assists'), player_threes: stat('threePointFieldGoalsMade'),
  player_steals: stat('steals'), player_blocks: stat('blocks'), player_turnovers: stat('turnovers'),
  player_points_rebounds_assists: total('points', 'rebounds', 'assists'), pra: total('points', 'rebounds', 'assists'),
  player_points_rebounds: total('points', 'rebounds'), player_points_assists: total('points', 'assists'),
  player_rebounds_assists: total('rebounds', 'assists'), player_blocks_steals: total('blocks', 'steals'),
};
const hockey: Readonly<Record<string, Read>> = {
  // ESPN's "S" (shotsTotal) is shots on goal; missed shots are counted separately.
  shots_on_goal: stat('shotsTotal'), sog: stat('shotsTotal'), goals: stat('goals'),
  assists: stat('assists'), player_assists: stat('assists'), points: total('goals', 'assists'),
  plus_minus: stat('plusMinus'), hits: stat('hits'), blocked_shots: stat('blockedShots'),
  player_blocked_shots: stat('blockedShots'), faceoffs_won: stat('faceoffsWon'), player_faceoffs_won: stat('faceoffsWon'),
  saves: stat('saves'), goalie_saves: stat('saves'),
};
const soccer: Readonly<Record<string, Read>> = {
  shots: stat('totalShots'), sot: stat('shotsOnTarget'), goals: stat('totalGoals'), assists: stat('goalAssists'),
  goal_plus_assist: total('totalGoals', 'goalAssists'), fouls: stat('foulsCommitted'), goalie_saves: stat('saves'),
};
const singles: Read = (s) => s['batting.hits'] === undefined ? null
  : s['batting.hits'] - (s['batting.doubles'] ?? 0) - (s['batting.triples'] ?? 0) - (s['batting.homeRuns'] ?? 0);
const baseball: Readonly<Record<string, Read>> = {
  batter_hits: stat('batting.hits'), batter_hits_runs_rbis: total('batting.hits', 'batting.runs', 'batting.rbi'),
  batter_total_bases: stat('batting.totalBases'), hitter_ks: stat('batting.strikeOuts'), rbis: stat('batting.rbi'),
  runs: stat('batting.runs'), batter_runs_scored: stat('batting.runs'), doubles: stat('batting.doubles'),
  singles, batter_singles: singles,
  triples: stat('batting.triples'),
  extra_base_hits: (s) => s['batting.hits'] === undefined ? null
    : (s['batting.doubles'] ?? 0) + (s['batting.triples'] ?? 0) + (s['batting.homeRuns'] ?? 0),
  runs_rbis: (s) => s['batting.runs'] === undefined ? null : s['batting.runs'] + (s['batting.rbi'] ?? 0),
  pitching_outs: stat('pitching.outs'),
  batter_walks: stat('batting.baseOnBalls'), batter_home_runs: stat('batting.homeRuns'), sb: stat('batting.stolenBases'),
  plate_appearances: stat('batting.plateAppearances'),
  pitcher_strikeouts: stat('pitching.strikeOuts'), hits_allowed: stat('pitching.hits'),
  pitcher_hits_allowed: stat('pitching.hits'), walks_allowed: stat('pitching.baseOnBalls'),
  pitcher_earned_runs: stat('pitching.earnedRuns'), earned_runs_allowed: stat('pitching.earnedRuns'),
  pitches_thrown: stat('pitching.numberOfPitches'), batters_faced: stat('pitching.battersFaced'),
};

/** ESPN sport path per CrownIQ sport, for full-game player stats only. */
const espnPaths: Readonly<Partial<Record<string, string>>> = { NFL: 'football/nfl', NCAAFB: 'football/college-football',
  NBA: 'basketball/nba', WNBA: 'basketball/wnba', NHL: 'hockey/nhl', SOCCER: 'soccer/all' };
const readers: Readonly<Partial<Record<string, Readonly<Record<string, Read>>>>> = { NFL: football, NCAAFB: football,
  NBA: basketball, WNBA: basketball, NHL: hockey, SOCCER: soccer, MLB: baseball };
/** Full-game leagues only: a league like NFL1Q or NHL1P is a split that box scores do not break out. */
const fullGame = (line: PropLine) => line.league.toUpperCase() === line.sport ||
  (line.sport === 'NCAAFB' && ['NCAAF', 'CFB', 'NCAAFB'].includes(line.league.toUpperCase()));

export function boxScoreReader(line: PropLine): Read | null {
  return fullGame(line) ? readers[line.sport]?.[line.market] ?? null : null;
}

const nickname = (value: string) => normalizedPlayer(value).split(' ').at(-1) ?? '';
/** Same team across sources: exact name, or same nickname when both names have more than one word. */
function sameTeam(a: string | null | undefined, names: readonly string[]) {
  if (!a) return false;
  const x = normalizedPlayer(a);
  return names.some((name) => {
    const y = normalizedPlayer(name);
    return !!y && (x === y || (x.split(' ').length > 1 || y.split(' ').length > 1) && nickname(a) === nickname(name) &&
      nickname(a).length >= 3);
  });
}
const lineTeams = (line: PropLine) => [...new Set([line.homeTeam, line.awayTeam, line.team, line.opponent]
  .filter((value): value is string => !!value))];

export interface Game { id: string; start: number; final: boolean; sides: string[][] }
/** The one game holding both of the line's teams near its start (or one team, when it alone is unique at that time). */
export function matchGame(line: PropLine, games: readonly Game[]): Game | null {
  const start = Date.parse(line.eventStartTime), teams = lineTeams(line);
  const near = games.filter((game) => Math.abs(game.start - start) <= 6 * HOUR);
  const hits = (game: Game) => game.sides.filter((names) => teams.some((team) => sameTeam(team, names))).length;
  const both = near.filter((game) => hits(game) === 2);
  if (both.length === 1) return both[0];
  if (both.length > 1) {
    const close = both.filter((game) => Math.abs(game.start - start) <= 2 * HOUR);
    return close.length === 1 ? close[0] : null;
  }
  const one = near.filter((game) => hits(game) === 1 && Math.abs(game.start - start) <= HOUR);
  return one.length === 1 ? one[0] : null;
}

/** Splits ESPN's compound cells ("16/25" for completions/attempts, "1-2" for made-attempted) into their keys. */
function cells(prefix: string, keys: readonly unknown[], values: readonly unknown[], into: Record<string, number>) {
  keys.forEach((rawKey, index) => {
    const key = str(rawKey), raw = str(values[index]).trim();
    const separator = key.includes('/') ? '/' : key.includes('-') ? '-' : null;
    const parts = separator ? key.split(separator) : [key];
    const numbers = separator ? raw.split(separator) : [raw];
    if (parts.length !== numbers.length) return;
    parts.forEach((part, at) => {
      const value = Number(numbers[at].replace(/^\+/, ''));
      if (!part || !numbers[at] || !Number.isFinite(value)) return;
      if (prefix) into[`${prefix}.${part}`] ??= value;
      into[part] ??= value;
    });
  });
}

/** Player rows from an ESPN summary: boxscore.players for most sports, rosters for soccer. */
export function espnRows(summary: unknown): Row[] {
  const root = obj(summary), rows = new Map<string, Row>();
  const row = (team: string, name: string) => {
    const key = `${team}|${name}`;
    const found = rows.get(key) ?? { name, team, stats: {}, dnp: false };
    rows.set(key, found);
    return found;
  };
  for (const side of arr(obj(root?.boxscore)?.players)) {
    const team = str(obj(obj(side)?.team)?.displayName);
    for (const category of arr(obj(side)?.statistics)) {
      const group = obj(category), prefix = str(group?.name);
      for (const athlete of arr(group?.athletes)) {
        const entry = obj(athlete), name = str(obj(entry?.athlete)?.displayName);
        if (!name) continue;
        const target = row(team, name);
        if (entry?.didNotPlay === true) target.dnp = true;
        cells(prefix, arr(group?.keys), arr(entry?.stats), target.stats as Record<string, number>);
      }
    }
  }
  for (const side of arr(root?.rosters)) {
    const team = str(obj(obj(side)?.team)?.displayName);
    for (const athlete of arr(obj(side)?.roster)) {
      const entry = obj(athlete), name = str(obj(entry?.athlete)?.displayName);
      if (!name) continue;
      const target = row(team, name), stats = target.stats as Record<string, number>;
      for (const item of arr(entry?.stats)) {
        const value = obj(item), key = str(value?.name), number = Number(value?.value);
        if (key && Number.isFinite(number)) stats[key] ??= number;
      }
      // A listed player who neither started nor came on did not play.
      if (entry?.starter === false && entry?.subbedIn === false) target.dnp = true;
    }
  }
  return [...rows.values()];
}

/** Player rows from an MLB Stats API boxscore. An empty batting or pitching line means the player did not do that. */
export function mlbRows(boxscore: unknown): Row[] {
  const rows: Row[] = [];
  for (const side of ['away', 'home']) {
    const team = obj(obj(obj(boxscore)?.teams)?.[side]);
    const teamName = str(obj(team?.team)?.name);
    for (const value of Object.values(obj(team?.players) ?? {})) {
      const player = obj(value), name = str(obj(player?.person)?.fullName);
      if (!name) continue;
      const stats: Record<string, number> = {};
      for (const group of ['batting', 'pitching'] as const) {
        const line = obj(obj(player?.stats)?.[group]) ?? {};
        for (const [key, raw] of Object.entries(line)) {
          const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : NaN;
          if (Number.isFinite(number)) stats[`${group}.${key}`] = number;
        }
      }
      rows.push({ name, team: teamName, stats, dnp: false });
    }
  }
  return rows;
}

/** The one box-score row for this player; on MLB, a player with no line of the needed kind did not play. */
function factFor(target: GradeTarget, rows: readonly Row[], read: Read, source: { name: string; url: string },
  now: Date): ResultFact | null {
  const line = target.lineSnapshot, wanted = normalizedPlayer(line.playerName);
  const matches = rows.filter((row) => normalizedPlayer(row.name) === wanted);
  if (matches.length !== 1) return null;
  const row = matches[0];
  const base = { eventId: line.eventId, playerId: line.playerId, market: line.market, sourceName: source.name,
    sourceUrl: source.url, completedAt: now.toISOString() };
  if (line.sport === 'MLB') {
    const pitcher = /pitch|allowed|batters_faced|pitcher/.test(line.market) && line.market !== 'pitches_seen';
    if (!Object.keys(row.stats).some((key) => key.startsWith(pitcher ? 'pitching.' : 'batting.')))
      return { ...base, status: 'DNP', actual: null };
  }
  if (row.dnp) return { ...base, status: 'DNP', actual: null };
  const actual = read(row.stats);
  return actual === null ? null : { ...base, status: 'FINAL', actual };
}

const easternDate = (time: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
  .format(new Date(time));

export class BoxScoreResults {
  constructor(private readonly fetchFn: typeof fetch = fetch, private readonly clock: () => Date = () => new Date(),
    /** Every graded final result goes to CrownIQ's own archive. */
    private readonly archive: HistoryArchive | null = null) {}

  private async json(url: string): Promise<unknown> {
    const response = await this.fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`BOX_SCORE_HTTP_${response.status}`);
    return response.json();
  }

  async results(targets: readonly GradeTarget[]): Promise<BoxScoreReport> {
    const now = this.clock(), facts: ResultFact[] = [];
    let unsupported = 0, waiting = 0;
    const ready: { target: GradeTarget; read: Read }[] = [];
    for (const target of targets) {
      const read = boxScoreReader(target.lineSnapshot);
      if (!read) { unsupported++; continue; }
      if (Date.parse(target.lineSnapshot.eventStartTime) + SETTLE_MS > now.getTime()) { waiting++; continue; }
      ready.push({ target, read });
    }
    const schedules = new Map<string, Promise<Game[]>>(), summaries = new Map<string, Promise<Row[]>>();
    const once = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
      if (!cache.has(key)) cache.set(key, load());
      return cache.get(key)!;
    };
    for (const { target, read } of ready) {
      const line = target.lineSnapshot, start = Date.parse(line.eventStartTime);
      try {
        const days = [...new Set([easternDate(start), new Date(start).toISOString().slice(0, 10)])];
        const games = (await Promise.all(days.map((day) => once(schedules, `${line.sport}|${day}`,
          () => line.sport === 'MLB' ? this.mlbGames(day) : this.espnGames(espnPaths[line.sport]!, day))))).flat();
        const game = matchGame(line, [...new Map(games.map((item) => [item.id, item])).values()]);
        if (!game?.final) { waiting++; continue; }
        const source = line.sport === 'MLB'
          ? { name: 'MLB Stats API box score', url: `${MLB}/game/${game.id}/boxscore` }
          : { name: 'ESPN box score', url: `${ESPN}/${espnPaths[line.sport]}/summary?event=${game.id}` };
        const rows = await once(summaries, source.url, async () =>
          line.sport === 'MLB' ? mlbRows(await this.json(source.url)) : espnRows(await this.json(source.url)));
        const fact = factFor(target, rows, read, source, now);
        if (fact) facts.push(fact); else waiting++;
      } catch { waiting++; }
    }
    const unique = [...new Map(facts.map((fact) => [JSON.stringify([fact.eventId, fact.playerId, fact.market]), fact]))
      .values()];
    const snapshots = new Map(targets.map((target) => [JSON.stringify([target.eventId, target.playerId, target.lineSnapshot.market]),
      target.lineSnapshot]));
    void this.archive?.append('results', unique.map((fact) => {
      const line = snapshots.get(JSON.stringify([fact.eventId, fact.playerId, fact.market]));
      return { key: `${fact.eventId}:${fact.playerId}:${fact.market}`, record: { ...fact, sport: line?.sport ?? null,
        league: line?.league ?? null, playerName: line?.playerName ?? null, eventName: line?.eventName ?? null,
        eventStartTime: line?.eventStartTime ?? null } };
    }));
    return { facts: unique, unsupported, waiting };
  }

  private async espnGames(path: string, day: string): Promise<Game[]> {
    const params = new URLSearchParams({ dates: day.replaceAll('-', ''), limit: '1000' });
    if (path === 'football/college-football') params.set('groups', '80');
    const body = obj(await this.json(`${ESPN}/${path}/scoreboard?${params}`));
    return arr(body?.events).flatMap((value) => {
      const event = obj(value), competition = obj(arr(event?.competitions)[0]);
      const type = obj(obj(event?.status)?.type), start = Date.parse(str(event?.date));
      const sides = arr(competition?.competitors).map((item) => {
        const team = obj(obj(item)?.team);
        return ['displayName', 'shortDisplayName', 'name', 'location', 'abbreviation'].map((key) => str(team?.[key]))
          .filter(Boolean);
      });
      return event && Number.isFinite(start) && sides.length === 2
        ? [{ id: str(event.id), start, final: type?.completed === true && str(type?.state) === 'post', sides }] : [];
    });
  }

  private async mlbGames(day: string): Promise<Game[]> {
    const body = obj(await this.json(`${MLB}/schedule?sportId=1&startDate=${day}&endDate=${day}&hydrate=team`));
    return arr(body?.dates).flatMap((date) => arr(obj(date)?.games)).flatMap((value) => {
      const game = obj(value), teams = obj(game?.teams), start = Date.parse(str(game?.gameDate));
      const status = obj(game?.status);
      const sides = ['away', 'home'].map((side) => {
        const team = obj(obj(teams?.[side])?.team);
        return ['name', 'teamName', 'clubName', 'shortName', 'abbreviation'].map((key) => str(team?.[key])).filter(Boolean);
      });
      return game && Number.isFinite(start)
        ? [{ id: String(game.gamePk), start, sides,
          final: str(status?.abstractGameState) === 'Final' && !/postponed|suspended|cancel/i.test(str(status?.detailedState)) }]
        : [];
    });
  }
}
