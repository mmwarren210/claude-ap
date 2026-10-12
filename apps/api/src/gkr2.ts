import { createHash } from 'node:crypto';
import { evidenceSchema } from '@crowniq/contracts';
import type { Analysis, Evidence, PropLine } from '@crowniq/contracts';
import { createMarketModule, evaluateLine, lessAwareVersion, marketDefinitions, ModelRegistry } from '@crowniq/engine';
import type { MarketDefinition } from '@crowniq/engine';
import type { GameLine } from './context/feeds.js';
import { normalizedName } from './context/match.js';
import { gameValue, proplineStat } from './propline-history.js';
import type { Game, PropLineHistory } from './propline-history.js';
import { gameScriptFor } from './shadow-record.js';
import type { MlbGames } from './mlb-context.js';

// GKR 2 (owner, 2026-10-11: "Do all"; runs in shadow first, switched on only when its graded record beats GKR's).
// The same models as GKR with four changes:
// 1. Every named factor is filled from the player's PropLine box scores (plate appearances, batters faced, attempts,
//    carries, targets, minutes, shots, and the rates built on them), where GKR mostly read only the stat itself.
// 2. Factors keep GKR's reading (not flipped for LESS): GKR's graded LESS picks on players trending up hit 64.6%, the same
//    as its MORE picks (962 graded, 2026-10-11), so flipping them would throw winners away.
// 3. Two new reads: how this opponent has treated the stat (every cached player's games against them, against each
//    player's own average) and the game's expected script from the game lines (team total and spread).
// 4. The projection weights recent games more (half-life 8 games) and moves a little with the opponent and script.
// Nothing here touches a GKR score: GKR 2's picks go to their own shadow record.

type Stats = Readonly<Record<string, number>>;
type StatPick = (stats: Stats) => number | null;

const n = (stats: Stats, key: string) => Number.isFinite(stats[key]) ? stats[key]! : null;
const add = (...values: (number | null)[]) => values.some((value) => value === null) ? null : values.reduce<number>((a, b) => a + b!, 0);
const div = (a: number | null, b: number | null) => a === null || b === null || b <= 0 ? null : a / b;
const k = (key: string): StatPick => (stats) => n(stats, key);

// Box-score building blocks by sport.
const pa: StatPick = (s) => add(n(s, 'at_bats'), n(s, 'walks'));
const bf: StatPick = (s) => add(n(s, 'outs'), n(s, 'hits_allowed'), n(s, 'walks_allowed'));
const per = (key: string, base: StatPick): StatPick => (s) => div(n(s, key), base(s));
const xbh: StatPick = (s) => add(n(s, 'doubles'), n(s, 'triples'), n(s, 'home_runs'));
const touches: StatPick = (s) => add(n(s, 'rushing_attempts') ?? 0, n(s, 'receiving_targets') ?? 0);
const scrimmage: StatPick = (s) => add(n(s, 'rushing_yards') ?? 0, n(s, 'receiving_yards') ?? 0);
const tds: StatPick = (s) => add(n(s, 'rushing_tds') ?? 0, n(s, 'receiving_tds') ?? 0);

/** Factor key → how to read it from one game, per sport. A factor not listed here stays unfilled. */
const FACTORS: Readonly<Record<string, Readonly<Record<string, StatPick>>>> = {
  MLB: {
    expected_pa: pa, contact_ability: per('hits', k('at_bats')), hit_rate: per('hits', pa), power_rate: per('total_bases', pa),
    single_rate: per('singles', pa), double_rate: per('doubles', pa), triple_rate: per('triples', pa), rbi_rate: per('rbis', pa),
    run_rate: per('runs', pa), on_base_rate: (s) => div(add(n(s, 'hits'), n(s, 'walks')), pa(s)),
    contact_obp_skill: (s) => div(add(n(s, 'hits'), n(s, 'walks')), pa(s)), hitter_k_rate: per('batter_strikeouts', pa),
    hitter_walk_rate: per('walks', pa), hr_frequency: per('home_runs', pa), home_run_rate: per('home_runs', pa),
    extra_base_rate: (s) => div(xbh(s), pa(s)), extra_base_power_rate: (s) => div(xbh(s), pa(s)),
    run_creation_rate: (s) => div(add(n(s, 'hits'), n(s, 'runs'), n(s, 'rbis')), pa(s)),
    speed: per('stolen_bases', pa), steal_attempt_rate: per('stolen_bases', pa),
    expected_batters_faced: bf, pitch_count_innings: (s) => div(n(s, 'outs'), 3), pitcher_k_rate: per('strikeouts', bf),
    hits_per_batter: per('hits_allowed', bf), walk_rate: per('walks_allowed', bf), runs_per_batter: per('earned_runs', bf),
    pitch_efficiency: per('outs', bf),
  },
  NFL: {
    expected_attempts: k('passing_attempts'), attempts: k('passing_attempts'),
    efficiency_environment: per('passing_yards', k('passing_attempts')), efficiency: per('passing_yards', k('passing_attempts')),
    completion_rate: per('passing_completions', k('passing_attempts')), passing_style: per('passing_yards', k('passing_attempts')),
    interception_rate: per('interceptions', k('passing_attempts')),
    expected_carries: k('rushing_attempts'), carry_volume: k('rushing_attempts'), rushing_role: k('rushing_attempts'),
    rb_efficiency_skill: per('rushing_yards', k('rushing_attempts')), yards_per_carry: per('rushing_yards', k('rushing_attempts')),
    expected_touches: touches, yards_per_touch: (s) => div(scrimmage(s), touches(s)),
    target_floor: k('receiving_targets'), target_volume: k('receiving_targets'), target_share: k('receiving_targets'),
    target_opportunity_rate: k('receiving_targets'), catch_rate: per('receptions', k('receiving_targets')),
    receiving_efficiency: per('receiving_yards', k('receiving_targets')), yards_per_reception: per('receiving_yards', k('receptions')),
    td_rate: (s) => div(tds(s), touches(s)),
  },
  BASKETBALL: { minutes: k('minutes'), expected_minutes: k('minutes'),
    scoring_rate: per('points', k('minutes')), rebound_rate: per('rebounds', k('minutes')),
    points_opportunity: k('points'), scoring_opportunity: k('points'), rebounding_opportunity: k('rebounds'), assist_opportunity: k('assists'),
    overall_usage: (s) => add(n(s, 'points'), n(s, 'assists'), n(s, 'turnovers')) },
  NHL: { shot_volume: k('shots_on_goal'), recent_involvement: k('points_nhl'), power_play_role: k('power_play_points'),
    shooting_rate: per('goals', k('shots_on_goal')) },
  SOCCER: { shot_volume: k('shots'), on_target_rate: per('shots_on_target', k('shots')),
    goal_involvement: (s) => add(n(s, 'goals') ?? 0, n(s, 'assists') ?? 0) },
};
const familyOf = (sport: string) => ['NBA', 'WNBA', 'NCAAB'].includes(sport) ? 'BASKETBALL' : sport === 'NCAAFB' ? 'NFL' : sport;
/** The stat itself, under each name the models give it ("historical_…", "historical_volume"). */
const isOwnStat = (factor: string) => factor.startsWith('historical_');

/** Factors about the opponent or matchup, which GKR 2 fills with its opponent read. */
export const isOpponentFactor = (factor: string) => /opponent|matchup|coverage/.test(factor);

/**
 * A GKR model's GKR 2 version, with the opponent read. A model that already weighs the opponent
 * or matchup has those factors filled by it; one that doesn't gets an opponent factor at a tenth of the weight.
 */
export function gkr2Definition(definition: MarketDefinition): MarketDefinition {
  const base = { ...definition, version: `${definition.version}-G2`, lessAware: false, partialCoverageNormalization: true };
  if (definition.factors.some(([key]) => isOpponentFactor(key))) return base;
  const total = definition.factors.reduce((sum, [, weight]) => sum + weight, 0);
  const scaled = definition.factors.map(([key, weight]) => [key, Math.round(weight * 90 / total)] as [string, number]);
  const drift = 90 - scaled.reduce((sum, [, weight]) => sum + weight, 0);
  const largest = scaled.reduce((best, item, index) => item[1] > scaled[best]![1] ? index : best, 0);
  scaled[largest] = [scaled[largest]![0], scaled[largest]![1] + drift];
  return { ...base, factors: [...scaled, ['opponent_allowed', 10]] };
}

/** GKR 2 models for every GKR model the live board has approved (by version, LESS-aware variants included). */
export function createGkr2Registry(liveVersions: Readonly<Record<string, string>>, approved: (key: string) => boolean): ModelRegistry {
  const registry = new ModelRegistry();
  for (const [key, version] of Object.entries(liveVersions)) {
    if (!approved(key)) continue;
    const definition = marketDefinitions.find((item) => item.version === version || lessAwareVersion(item.version) === version);
    if (definition) registry.register(createMarketModule(gkr2Definition(definition), true));
  }
  return registry;
}

const words = (value: string) => normalizedName(value).split(' ');
const nickname = (team: string) => words(team).at(-1) ?? '';
export const sameTeam = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b &&
  (normalizedName(a) === normalizedName(b) || nickname(a) === nickname(b));

/** The team a player's games share (the side present in the most games), or null with too few teamed games. */
export function playerTeam(games: readonly Game[]): string | null {
  const counts = new Map<string, { name: string; count: number }>();
  for (const game of games) for (const name of [game.home, game.away]) {
    if (!name) continue;
    const key = normalizedName(name), item = counts.get(key) ?? { name, count: 0 };
    item.count++; counts.set(key, item);
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count);
  return best[0] && best[0].count >= 2 && best[0].count > (best[1]?.count ?? 0) ? best[0].name : null;
}
const opponentIn = (game: Game, team: string) => game.home && game.away
  ? sameTeam(game.home, team) ? game.away : sameTeam(game.away, team) ? game.home : null : null;

const PITCHING = new Set(['strikeouts', 'outs', 'earned_runs', 'hits_allowed', 'walks_allowed']);
/** Games before a time, newest first; pitching stats read starts only (when there are any). */
export function gamesBefore(games: readonly Game[], read: ReturnType<typeof proplineStat>, before: number): Game[] {
  const played = games.filter((game) => Date.parse(game.at) < before).sort((a, b) => b.at.localeCompare(a.at));
  const starts = typeof read === 'string' && PITCHING.has(read) ? played.filter((game) => game.stats.pitcher_started === 1) : [];
  return starts.length ? starts : played;
}

/**
 * How each opponent has treated a stat: across every cached player's games, the stat against that opponent over the
 * same players' own averages, shrunk toward 1 so a thin sample says little. 1.10 = players do 10% better than usual.
 */
export function opponentIndex(players: readonly (readonly Game[])[], read: NonNullable<ReturnType<typeof proplineStat>>): Map<string, number> {
  const totals = new Map<string, { name: string; actual: number; expected: number }>();
  let averages = 0, counted = 0;
  for (const games of players) {
    const team = playerTeam(games);
    if (!team) continue;
    const rows = gamesBefore(games, read, Infinity).flatMap((game) => {
      const value = gameValue(game.stats, read), opponent = opponentIn(game, team);
      return value === null || !opponent ? [] : [{ value, opponent }];
    });
    if (rows.length < 5) continue;
    const average = rows.reduce((sum, row) => sum + row.value, 0) / rows.length;
    if (average <= 0) continue;
    averages += average; counted++;
    for (const row of rows) {
      const key = nickname(row.opponent), item = totals.get(key) ?? { name: row.opponent, actual: 0, expected: 0 };
      item.actual += row.value; item.expected += average; totals.set(key, item);
    }
  }
  // Shrinkage worth about 25 average player-games.
  const prior = counted ? 25 * averages / counted : 0;
  return new Map([...totals].map(([key, item]) => [key, (item.actual + prior) / (item.expected + prior)]));
}

const weightedMean = (values: readonly number[], halfLife: number) => {
  let total = 0, weights = 0;
  values.forEach((value, index) => { const weight = 0.5 ** (index / halfLife); total += value * weight; weights += weight; });
  return weights ? total / weights : NaN;
};
const weightedSd = (values: readonly number[], halfLife: number, mean: number) => {
  let total = 0, weights = 0;
  values.forEach((value, index) => { const weight = 0.5 ** (index / halfLife); total += weight * (value - mean) ** 2; weights += weight; });
  return weights && values.length > 1 ? Math.sqrt(total / weights * values.length / (values.length - 1)) : 0;
};
const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const sd = (values: readonly number[]) => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
};
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

/** Sports whose spread and total describe the script (baseball and hockey run and puck lines don't). */
const SCRIPT_SPORTS = new Set(['NFL', 'NCAAFB', 'NBA', 'WNBA', 'NCAAB']);
/** Stats a team total moves (volume and scoring); game script stays out of the rest. */
const SCRIPTED = /yds|yards|attempts|completions|receptions|recs|rush|points|rebounds|assists|threes|targets|touch|tds|pra|pts/;

export interface Gkr2Context {
  /** The opponent index for this line's stat, by team nickname. */
  readonly opponents: ReadonlyMap<string, number> | null;
  /** Today's game lines (spread, total) for game script. */
  readonly games: readonly GameLine[];
  /** The average implied team total in this line's league today, the script's reference. */
  readonly leagueTeamTotal: number | null;
  /** MLB: the opposing starter's rate for this stat over the league's (a batter's line). */
  readonly pitcher?: { readonly pitcher: string; readonly ratio: number; readonly starts: number } | null;
  /** MLB: head-to-head against tonight's starter or team (its shrunk multiplier). */
  readonly h2h?: { readonly factor: number; readonly games: number; readonly against: string } | null;
  /** MLB: the first-pitch weather's multiplier at an open-air park. */
  readonly weather?: { readonly factor: number; readonly reasons: readonly string[] } | null;
}

/** GKR 2's evidence for one line from the player's PropLine games. The PrizePicks line is never read here. */
export function gkr2Evidence(line: PropLine, games: readonly Game[], context: Gkr2Context, now: Date, definition: MarketDefinition): Evidence[] {
  const read = proplineStat(line.sport, line.market);
  if (!read) return [];
  const start = Date.parse(line.eventStartTime);
  const before = gamesBefore(games, read, start).slice(0, 40);
  const valued = before.flatMap((game) => { const value = gameValue(game.stats, read); return value === null ? [] : [{ game, value }]; });
  if (valued.length < 5) return [];
  const values = valued.map((item) => item.value);
  let midpoint = weightedMean(values, 8);
  const spread = weightedSd(values, 8, midpoint);
  if (!Number.isFinite(midpoint) || !(spread > 0)) return [];
  const expiresAt = new Date(Math.min(start, now.getTime() + 6 * 3600_000)).toISOString();
  if (Date.parse(expiresAt) <= now.getTime()) return [];
  const retrievedAt = now.toISOString(), result: Evidence[] = [];
  const push = (kind: string, finding: string, value: number, baseline?: number, unit?: string) => {
    if (!Number.isFinite(value) || (baseline !== undefined && !Number.isFinite(baseline))) return;
    result.push(evidenceSchema.parse({ id: 'gkr2:' + hash(JSON.stringify([line.eventId, line.playerId, line.market, kind, retrievedAt])),
      entityType: 'PLAYER', entityId: line.playerId, eventId: line.eventId, market: line.market, kind, finding,
      sourceName: 'PropLine box scores', sourceUrl: 'https://prop-line.com', sourceType: 'PUBLIC', retrievedAt, expiresAt,
      quality: values.length >= 10 ? 'HIGH' : 'MEDIUM', confidence: Math.min(.95, .6 + values.length * .025),
      numeric: { value, ...(baseline === undefined ? {} : { baseline }), ...(unit ? { unit } : {}) } }));
  };

  // Opponent: how this opponent has treated the stat. The player's team comes from the line, else from their games.
  const team = line.team ?? playerTeam(games);
  const opponent = opponentOf(line, team);
  const opponentRead = opponent ? context.opponents?.get(nickname(opponent)) ?? null : null;
  // MLB: the opposing starter fills the pitcher factors (the team read fills the rest), and the weather fills the park's.
  const pitcher = context.pitcher ?? null;
  if (pitcher) for (const [factor] of definition.factors) if (/pitcher/.test(factor))
    push('metric:' + factor, `${pitcher.pitcher} has allowed ${Math.round(pitcher.ratio * 100)}% of the league's rate for this stat over his last ${pitcher.starts} starts.`, pitcher.ratio, 1);
  if (context.weather) for (const [factor] of definition.factors) if (factor === 'park' || factor === 'weather')
    push('metric:' + factor, context.weather.reasons.join(' '), context.weather.factor, 1);
  if (opponentRead !== null) for (const [factor] of definition.factors) if ((isOpponentFactor(factor) || factor === 'opponent_allowed') && !(pitcher && /pitcher/.test(factor)))
    push('metric:' + factor, `Players have produced ${Math.round(opponentRead * 100)}% of their usual ${line.market.replace(/_/g, ' ')} against ${opponent}.`, opponentRead, 1);

  // Game script: the team's implied total (and spread for rushing) against today's league average.
  const script = SCRIPT_SPORTS.has(line.sport) && SCRIPTED.test(line.market) ? gameScriptFor(line, context.games) : null;
  let scriptRatio: number | null = null;
  if (script?.total != null && script.teamMargin != null && context.leagueTeamTotal) {
    const teamTotal = script.total / 2 + script.teamMargin / 2;
    const rushing = /rush/.test(line.market) && !/rec/.test(line.market);
    const value = rushing ? context.leagueTeamTotal + script.teamMargin : teamTotal;
    scriptRatio = value / context.leagueTeamTotal;
    if (definition.factors.some(([key]) => key === 'game_script'))
      push('metric:game_script', `Implied team total ${teamTotal.toFixed(1)} (spread ${script.teamMargin > 0 ? '+' : ''}${script.teamMargin}) against a league average of ${context.leagueTeamTotal.toFixed(1)}.`, value, context.leagueTeamTotal);
  }

  // The projection leans recent and moves a little with the matchup: half the opponent effect (at most 8%) and a third
  // of the script's (at most 5%).
  const opponentShift = opponentRead === null ? 1 : clamp(1 + (opponentRead - 1) / 2, .92, 1.08);
  const scriptShift = scriptRatio === null ? 1 : clamp(1 + (scriptRatio - 1) / 3, .95, 1.05);
  // MLB: half the starter's effect (at most 10%, in place of the team read) and the weather's.
  const pitcherShift = pitcher ? clamp(1 + (pitcher.ratio - 1) / 2, .9, 1.1) : 1;
  midpoint *= (pitcher ? 1 : opponentShift) * scriptShift * pitcherShift * (context.weather?.factor ?? 1) * (context.h2h?.factor ?? 1);
  push('projection:' + line.market, `GKR 2 projection from ${values.length} PropLine games, recent games weighted more, adjusted for opponent and game script.`,
    midpoint, spread, line.market.replace(/_/g, ' '));

  // Named factors: the last 5 games against the last 20 (recency-weighted).
  const table = FACTORS[familyOf(line.sport)] ?? {};
  const recent = valued.slice(0, 5).map((item) => item.game), baseline = valued.slice(0, 20).map((item) => item.game);
  for (const [factor] of definition.factors) {
    const pick: StatPick | undefined = isOwnStat(factor) ? (stats) => gameValue(stats, read) : table[factor];
    if (!pick) continue;
    const recentValues = recent.flatMap((game) => { const v = pick(game.stats); return v === null || !Number.isFinite(v) ? [] : [v]; });
    const baseValues = baseline.flatMap((game) => { const v = pick(game.stats); return v === null || !Number.isFinite(v) ? [] : [v]; });
    if (recentValues.length < 3 || baseValues.length < 5) continue;
    push('metric:' + factor, `Last ${recentValues.length} PropLine games against the last ${baseValues.length} for ${factor.replace(/_/g, ' ')}.`,
      weightedMean(recentValues, 3), mean(baseValues));
  }
  const recentTarget = values.slice(0, 5), baseTarget = values.slice(0, 20);
  if (recentTarget.length >= 3 && baseTarget.length >= 5)
    push('metric:stability', 'Inverse coefficient-of-variation stability from PropLine games.',
      1 / (1 + sd(recentTarget) / Math.max(Math.abs(mean(recentTarget)), 1)), 1 / (1 + sd(baseTarget) / Math.max(Math.abs(mean(baseTarget)), 1)));
  return result;
}

/** Average implied team total per league from today's game lines (total/2 ± spread/2 averages to total/2). */
export function leagueTeamTotals(games: readonly GameLine[]): Map<string, number> {
  const byLeague = new Map<string, number[]>();
  for (const game of games) if (game.market === 'total' && game.line != null && game.line > 0)
    byLeague.set(game.league, [...byLeague.get(game.league) ?? [], game.line / 2]);
  return new Map([...byLeague].filter(([, list]) => list.length >= 2).map(([league, list]) => [league, mean(list)]));
}

/** The line's opponent: the board's, else the other side of the game from the player's team. */
export function opponentOf(line: Pick<PropLine, 'team' | 'opponent' | 'homeTeam' | 'awayTeam'>, team: string | null = line.team): string | null {
  return line.opponent ?? (team && line.homeTeam && line.awayTeam
    ? sameTeam(team, line.homeTeam) ? line.awayTeam : sameTeam(team, line.awayTeam) ? line.homeTeam : null : null);
}

/**
 * How tonight's opponent has treated a line's stat (1.10 = players do 10% better than usual against them), from the
 * PropLine games the nightly pull cached. Shared by GKR 2 and Edge; each index is rebuilt at most hourly. No requests.
 */
export class OpponentReads {
  private cache = new Map<string, { at: number; index: Map<string, number> }>();
  constructor(private readonly history: PropLineHistory, private readonly clock: () => Date = () => new Date()) {}

  index(sportKey: string, read: NonNullable<ReturnType<typeof proplineStat>>): Map<string, number> {
    const key = `${sportKey}|${JSON.stringify(read)}`, now = this.clock().getTime(), cached = this.cache.get(key);
    if (cached && now - cached.at < 3600_000) return cached.index;
    const index = opponentIndex(this.history.cachedGames(sportKey), read);
    // An empty index (saved games not loaded yet) isn't kept, so the next read tries again.
    if (index.size) this.cache.set(key, { at: now, index });
    return index;
  }

  /** The opponent's index for a line, or null without a known opponent, a box-score stat or enough games. */
  read(line: PropLine, team: string | null = line.team): { opponent: string; index: number } | null {
    const read = proplineStat(line.sport, line.market), sportKey = this.history.sportKey(line), opponent = opponentOf(line, team);
    if (!read || !sportKey || !opponent) return null;
    const index = this.index(sportKey, read).get(nickname(opponent));
    return index === undefined ? null : { opponent, index };
  }
}

/**
 * GKR 2 across a board: each line GKR has a model for, scored with GKR's evidence plus GKR 2's. Only players whose
 * PropLine games are already cached are read (no requests), so a pass costs nothing.
 */
export class Gkr2 {
  private readonly opponents: OpponentReads;
  constructor(private readonly history: PropLineHistory, private readonly registry: () => ModelRegistry,
    private readonly gameLines: (() => Promise<readonly GameLine[]>) | null, private readonly clock: () => Date = () => new Date(),
    opponents?: OpponentReads, private readonly mlb: MlbGames | null = null) {
    this.opponents = opponents ?? new OpponentReads(history, clock);
  }

  async analyses(lines: readonly PropLine[], evidence: readonly Evidence[]): Promise<Analysis[]> {
    const registry = this.registry(), now = this.clock();
    await this.history.ready();
    const games = this.gameLines ? await this.gameLines().catch(() => [] as GameLine[]) : [];
    const totals = leagueTeamTotals(games);
    // GKR's evidence for a line: the player's own plus the event's and teams' (indexed once, not filtered per line).
    const byPlayer = new Map<string, Evidence[]>(), shared = new Map<string, Evidence[]>();
    for (const item of evidence) {
      const map = item.entityType === 'PLAYER' ? byPlayer : shared, key = item.entityType === 'PLAYER' ? `${item.eventId}|${item.entityId}` : item.eventId;
      const list = map.get(key); if (list) list.push(item); else map.set(key, [item]);
    }
    const out: Analysis[] = [];
    let index = 0;
    for (const line of lines) {
      // A long board yields now and then so the server keeps answering.
      if (++index % 500 === 0) await new Promise((done) => setImmediate(done));
      const module = registry.resolve(line);
      if (!module || Date.parse(line.eventStartTime) <= now.getTime()) continue;
      const definition = marketDefinitions.find((item) => `${item.version}-G2` === module.version ||
        `${lessAwareVersion(item.version)}-G2` === module.version);
      const read = proplineStat(line.sport, line.market), sportKey = this.history.sportKey(line);
      if (!definition || !read || !sportKey) continue;
      const playerGames = await this.history.cachedFor(line);
      if (!playerGames) continue;
      const own = gkr2Evidence(line, playerGames, { opponents: this.opponents.index(sportKey, read), games,
        leagueTeamTotal: totals.get(line.league) ?? null, pitcher: this.mlb?.matchup(line) ?? null, weather: this.mlb?.weather(line) ?? null,
        h2h: this.mlb?.h2h(line) ?? null },
        now, gkr2Definition(definition));
      if (!own.length) continue;
      out.push(evaluateLine(line, [...byPlayer.get(`${line.eventId}|${line.playerId}`) ?? [], ...shared.get(line.eventId) ?? [], ...own], registry, now));
    }
    return out;
  }
}
