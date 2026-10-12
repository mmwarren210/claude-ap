import type { PropLine } from '@crowniq/contracts';
import { normalizedName } from './context/match.js';
import { playerTeam, sameTeam } from './gkr2.js';
import { gameValue, proplineStat } from './propline-history.js';
import type { Game, PropLineHistory } from './propline-history.js';
import type { PropLineClient } from './scrapers/propline.js';

// MLB game context (owner, 2026-10-11: "for MLB it matters"): PropLine's probable pitchers, park and first-pitch weather for
// each game on the board, read once an hour per game. Two reads come from it, used by GKR 2 and Edge:
// - the opposing starter: his hit, strikeout, walk and earned-run rates per batter faced over his last 10 starts (PropLine
//   box scores), against the league's, shrunk toward average so a few starts say little;
// - the weather: warm air carries the ball (home runs most, runs and total bases some), at open-air parks only (domes and
//   retractable roofs, which close in bad weather, are left alone).
// Batter handedness isn't in PropLine's data, so there is no platoon read; wind needs each park's orientation, so it waits.

export interface MlbContext {
  readonly eventId: string; readonly home: string; readonly away: string;
  readonly homePitcher: string | null; readonly awayPitcher: string | null;
  readonly homeHand: string | null; readonly awayHand: string | null;
  readonly venue: string | null; readonly outdoor: boolean;
  readonly temperatureF: number | null; readonly rainChance: number | null; readonly windMph: number | null;
}

/** A starter's rates per batter faced, shrunk toward the league's. */
export interface PitcherRates { readonly name: string; readonly starts: number; readonly hits: number; readonly strikeouts: number;
  readonly walks: number; readonly earnedRuns: number }

export interface Adjustment { readonly factor: number; readonly reasons: string[] }

const PROPLINE_ID = /propline:(\d+)/;
export const proplineEventId = (eventId: string) => PROPLINE_ID.exec(eventId)?.[1] ?? null;

// PropLine records a pitching stat only when a prop was offered on it, so a missing stat is unknown, not zero: batters
// faced needs outs and hits (walks estimated when missing), and each rate counts only the starts that carry its stat.
const has = (stats: Readonly<Record<string, number>>, key: string) => Number.isFinite(stats[key]);
// Batters faced when walks weren't recorded: outs plus hits, grossed up by the usual walk share (about 8%).
const battersFaced = (stats: Readonly<Record<string, number>>) => !has(stats, 'outs') || !has(stats, 'hits_allowed') ? null
  : has(stats, 'walks_allowed') ? stats.outs! + stats.hits_allowed! + stats.walks_allowed! : (stats.outs! + stats.hits_allowed!) / (1 - .083);
const starts = (games: readonly Game[], before = Infinity) => games
  .filter((game) => game.stats.pitcher_started === 1 && Date.parse(game.at) < before && (battersFaced(game.stats) ?? 0) > 0)
  .sort((a, b) => b.at.localeCompare(a.at));
const RATE_STATS = { hits: 'hits_allowed', strikeouts: 'strikeouts', walks: 'walks_allowed', earnedRuns: 'earned_runs' } as const;
type Totals = Record<keyof typeof RATE_STATS, { count: number; bf: number }>;
const emptyTotals = (): Totals => ({ hits: { count: 0, bf: 0 }, strikeouts: { count: 0, bf: 0 }, walks: { count: 0, bf: 0 }, earnedRuns: { count: 0, bf: 0 } });
const addStart = (totals: Totals, stats: Readonly<Record<string, number>>) => {
  const bf = battersFaced(stats)!;
  for (const [rate, key] of Object.entries(RATE_STATS) as [keyof Totals, string][])
    if (has(stats, key)) { totals[rate].count += stats[key]!; totals[rate].bf += bf; }
};

/** The usual MLB rates per batter faced, used when the saved starts are too few to measure the league. */
export const MLB_TYPICAL = { hits: .215, strikeouts: .222, walks: .083, earnedRuns: .11 } as const;

/** League rates per batter faced from every cached start (the usual rates when there are too few). */
export function leagueRates(players: readonly (readonly Game[])[]): Omit<PitcherRates, 'name' | 'starts'> {
  const totals = emptyTotals();
  for (const games of players) for (const game of starts(games)) addStart(totals, game.stats);
  // Too few saved starts (late in the season only the playoff teams' players are saved): the usual MLB rates per batter
  // faced (about 22% strikeouts, 8% walks, 21.5% hits, 11% earned runs) stand in.
  if (Object.values(totals).some((item) => item.bf < 500)) return MLB_TYPICAL;
  return { hits: totals.hits.count / totals.hits.bf, strikeouts: totals.strikeouts.count / totals.strikeouts.bf,
    walks: totals.walks.count / totals.walks.bf, earnedRuns: totals.earnedRuns.count / totals.earnedRuns.bf };
}

/** A starter's last 10 starts before a time, as rates per batter faced shrunk toward the league (worth 60 batters). */
export function pitcherRates(name: string, games: readonly Game[], league: Omit<PitcherRates, 'name' | 'starts'>, before: number): PitcherRates | null {
  const recent = starts(games, before).slice(0, 10);
  if (recent.length < 3) return null;
  const totals = emptyTotals();
  for (const game of recent) addStart(totals, game.stats);
  const shrunk = (rate: keyof Totals) => (totals[rate].count + league[rate] * 60) / (totals[rate].bf + 60);
  return { name, starts: recent.length, hits: shrunk('hits'), strikeouts: shrunk('strikeouts'), walks: shrunk('walks'), earnedRuns: shrunk('earnedRuns') };
}

type Rate = 'hits' | 'strikeouts' | 'walks' | 'earnedRuns';
/** Which of the starter's rates a batter stat follows, or null for stats he doesn't touch (stolen bases). */
export function batterRate(market: string): Rate | null {
  const m = market.toLowerCase();
  if (/stolen|\bsb\b|^sb$/.test(m)) return null;
  if (/strikeout|hitter_ks|_ks$/.test(m)) return 'strikeouts';
  if (/walk/.test(m)) return 'walks';
  if (/home_run|rbi|runs|extra_base/.test(m)) return 'earnedRuns';
  if (/hit|single|double|triple|total_bases|bases|fantasy|plate/.test(m)) return 'hits';
  return null;
}
const rateWords: Readonly<Record<Rate, string>> = { hits: 'hits', strikeouts: 'strikeouts', walks: 'walks', earnedRuns: 'earned runs' };

const PITCHER_MARKET = /pitcher|pitching|hits_allowed|walks_allowed|earned_runs|batters_faced|pitches/;
export const isPitcherMarket = (market: string) => PITCHER_MARKET.test(market.toLowerCase());

/**
 * The opposing starter's read for a batter's line: his rate for the stat over the league's (1.15 = allows 15% more than
 * average). Null for a pitcher's own line, an unknown starter or a stat he doesn't touch.
 */
export function pitcherMatchup(line: Pick<PropLine, 'market'>, team: string | null, game: MlbContext,
  rates: ReadonlyMap<string, PitcherRates>, league: Omit<PitcherRates, 'name' | 'starts'> | null):
  { pitcher: string; hand: string | null; rate: Rate; ratio: number; starts: number } | null {
  if (isPitcherMarket(line.market) || !team || !league) return null;
  const rate = batterRate(line.market);
  if (!rate) return null;
  const home = sameTeam(team, game.home) && !sameTeam(team, game.away), away = sameTeam(team, game.away) && !sameTeam(team, game.home);
  if (!home && !away) return null;
  const pitcher = home ? game.awayPitcher : game.homePitcher, hand = home ? game.awayHand : game.homeHand;
  const found = pitcher ? rates.get(normalizedName(pitcher)) : undefined;
  if (!pitcher || !found || !(league[rate] > 0)) return null;
  return { pitcher, hand, rate, ratio: found[rate] / league[rate], starts: found.starts };
}

/** How much the stat moves per °F from 70 at an open-air park, and its limit. */
function heat(market: string): { perDegree: number; limit: number } | null {
  const m = market.toLowerCase();
  if (/strikeout|_ks$|walk|stolen|\bsb\b|^sb$|outs|pitches|batters_faced/.test(m)) return null;
  if (/home_run/.test(m)) return { perDegree: .008, limit: .12 };
  if (/rbi|runs|total_bases|bases|extra_base|earned_runs|hits_runs/.test(m)) return { perDegree: .002, limit: .05 };
  if (/hit|single|double|triple/.test(m)) return { perDegree: .001, limit: .03 };
  return null;
}

/** The weather's multiplier for a line at an open-air park, or null indoors, without a temperature, or under 1%. */
export function weatherFactor(line: Pick<PropLine, 'market'>, game: MlbContext): Adjustment | null {
  if (!game.outdoor || game.temperatureF === null) return null;
  const effect = heat(line.market);
  if (!effect) return null;
  const change = Math.max(-effect.limit, Math.min(effect.limit, (game.temperatureF - 70) * effect.perDegree));
  if (Math.abs(change) < .01) return null;
  return { factor: 1 + change, reasons: [`${Math.round(game.temperatureF)}°F at first pitch${game.venue ? ` at ${game.venue}` : ''}: ` +
    `${change > 0 ? 'warm air carries the ball' : 'cold air keeps the ball in'}, so the projection is ×${(1 + change).toFixed(2)}.`] };
}

/** Edge's MLB adjustment: half the starter's effect (within ±10%) times the weather's; reasons for both and for rain. */
export function mlbAdjustment(line: PropLine, team: string | null, game: MlbContext, rates: ReadonlyMap<string, PitcherRates>,
  league: Omit<PitcherRates, 'name' | 'starts'> | null): Adjustment | null {
  const reasons: string[] = [];
  let factor = 1;
  const matchup = pitcherMatchup(line, team, game, rates, league);
  if (matchup) {
    const move = Math.max(.9, Math.min(1.1, 1 + (matchup.ratio - 1) / 2));
    if (Math.abs(move - 1) >= .01) {
      factor *= move;
      reasons.push(`Facing ${matchup.pitcher}${matchup.hand ? ` (${matchup.hand}HP)` : ''}, who has allowed ${Math.round(matchup.ratio * 100)}% of the league's ` +
        `${rateWords[matchup.rate]} per batter over his last ${matchup.starts} starts, so the projection is ×${move.toFixed(2)}.`);
    }
  }
  const weather = weatherFactor(line, game);
  if (weather) { factor *= weather.factor; reasons.push(...weather.reasons); }
  if (game.outdoor && (game.rainChance ?? 0) >= 60) reasons.push(`${Math.round(game.rainChance!)}% chance of rain: a delay or shortened game is possible.`);
  return reasons.length ? { factor, reasons } : null;
}

/** Head-to-head from game logs: the player's value for a stat in matching games, against his value in all games. */
export interface HeadToHead { readonly kind: 'starter' | 'team'; readonly against: string; readonly games: number;
  readonly average: number; readonly overall: number; readonly factor: number }

const sameGame = (a: Game, b: Game) => Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= 6 * 3600_000 &&
  !!a.home && !!a.away && sameTeam(a.home, b.home) && sameTeam(a.away, b.away);
const average = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Head-to-head (owner, 2026-10-11: "use h2h history", playoffs repeat matchups): PropLine's box scores are per game, so
 * "against this starter" is the batter's games the starter started against his team (matched by date and teams), and
 * "against this team" is the player's games against tonight's opponent. Few games say little: the head-to-head average
 * over the player's own counts for n/(n+k) of the way (k = 6 starter games, 10 team games), within ±8%. Null under 2 games.
 */
export function headToHead(value: (stats: Readonly<Record<string, number>>) => number | null, playerGames: readonly Game[],
  before: number, options: { starter?: { name: string; games: readonly Game[] } | null; opponent?: string | null }): HeadToHead | null {
  const played = playerGames.filter((game) => Date.parse(game.at) < before);
  const valued = (games: readonly Game[]) => games.flatMap((game) => { const v = value(game.stats); return v === null || !Number.isFinite(v) ? [] : [v]; });
  const all = valued(played);
  if (all.length < 8) return null;
  const overall = average(all);
  if (overall <= 0) return null;
  const read = (kind: HeadToHead['kind'], against: string, games: readonly Game[], k: number): HeadToHead | null => {
    const values = valued(games);
    if (values.length < 2) return null;
    const mean = average(values), weight = values.length / (values.length + k);
    const factor = Math.max(.92, Math.min(1.08, 1 + weight * (mean / overall - 1)));
    return { kind, against, games: values.length, average: mean, overall, factor };
  };
  const starter = options.starter;
  if (starter) {
    const starts = starter.games.filter((game) => game.stats.pitcher_started === 1);
    const found = read('starter', starter.name, played.filter((game) => starts.some((start) => sameGame(game, start))), 6);
    if (found) return found;
  }
  const team = playerTeam(playerGames), opponent = options.opponent;
  if (!team || !opponent) return null;
  return read('team', opponent, played.filter((game) => {
    const other = game.home && game.away ? sameTeam(game.home, team) ? game.away : sameTeam(game.away, team) ? game.home : null : null;
    return !!other && sameTeam(other, opponent);
  }), 10);
}

export const h2hReason = (h2h: HeadToHead, label: string) => `Head-to-head: ${h2h.average.toFixed(1)} ${label} a game in ${h2h.games} games against ` +
  `${h2h.against}${h2h.kind === 'starter' ? ' starting' : ''} (vs ${h2h.overall.toFixed(1)} overall), so the projection is ×${h2h.factor.toFixed(2)}.`;

type Raw = { home_team?: string; away_team?: string; venue?: string | null; roof_type?: string | null; is_indoor?: boolean;
  home_probable_pitcher?: string | null; away_probable_pitcher?: string | null; home_probable_pitcher_hand?: string | null;
  away_probable_pitcher_hand?: string | null; weather?: { temperature_f?: number | null; precip_probability_pct?: number | null;
    wind_speed_mph?: number | null } | null };

/** PropLine's context for one game in CrownIQ's shape. Only an open-air park (not a dome or retractable roof) counts as outdoor. */
export function parseContext(eventId: string, raw: Raw): MlbContext | null {
  if (!raw.home_team || !raw.away_team) return null;
  const roof = (raw.roof_type ?? '').toLowerCase();
  return { eventId, home: raw.home_team, away: raw.away_team, homePitcher: raw.home_probable_pitcher ?? null,
    awayPitcher: raw.away_probable_pitcher ?? null, homeHand: raw.home_probable_pitcher_hand ?? null, awayHand: raw.away_probable_pitcher_hand ?? null,
    venue: raw.venue ?? null, outdoor: raw.is_indoor === false && !/dome|retract|closed/.test(roof),
    temperatureF: raw.weather?.temperature_f ?? null, rainChance: raw.weather?.precip_probability_pct ?? null, windMph: raw.weather?.wind_speed_mph ?? null };
}

/** Each MLB game's context, fetched at most hourly per game (games starting within 36 hours), and the starters' rates. */
export class MlbGames {
  private readonly games = new Map<string, { at: number; context: MlbContext | null }>();
  private rates = new Map<string, PitcherRates>();
  private league: Omit<PitcherRates, 'name' | 'starts'> | null = null;
  /** Each board batter's team in his game (game id|player), worked out at refresh for synchronous reads. */
  private teams = new Map<string, string>();
  /** The board players' and starters' cached games, by name, for head-to-head. */
  private playerGames = new Map<string, readonly Game[]>();
  constructor(private readonly client: Pick<PropLineClient, 'get'>, private readonly history: PropLineHistory | null,
    private readonly clock: () => Date = () => new Date()) {}

  /** Refreshes the board's MLB games (a few requests an hour) and the starters' rates from cached games. */
  async refresh(lines: readonly Pick<PropLine, 'sport' | 'eventId' | 'eventStartTime' | 'playerName' | 'team'>[]): Promise<number> {
    const now = this.clock().getTime(), wanted = new Set<string>();
    for (const line of lines) {
      const start = Date.parse(line.eventStartTime), id = line.sport === 'MLB' ? proplineEventId(line.eventId) : null;
      if (id && start > now && start - now < 36 * 3600_000) wanted.add(id);
    }
    let fetched = 0;
    for (const id of wanted) {
      const cached = this.games.get(id);
      if (cached && now - cached.at < 3600_000) continue;
      const context = await this.client.get<Raw>(`/v1/sports/baseball_mlb/events/${id}/context`)
        .then((raw) => parseContext(id, raw)).catch(() => cached?.context ?? null);
      this.games.set(id, { at: now, context }); fetched++;
    }
    for (const [id, entry] of this.games) if (now - entry.at > 48 * 3600_000) this.games.delete(id);
    if (this.history) {
      await this.history.ready();
      this.league = leagueRates(this.history.cachedGames('baseball_mlb'));
      const rates = new Map<string, PitcherRates>();
      const playerGames = new Map<string, readonly Game[]>();
      for (const { context } of this.games.values()) for (const name of [context?.homePitcher, context?.awayPitcher]) {
        if (!name || !this.league) continue;
        const games = await this.history.cachedFor({ sport: 'MLB', eventId: '', playerName: name });
        if (games) playerGames.set(normalizedName(name), games);
        const found = games ? pitcherRates(name, games, this.league, now) : null;
        if (found) rates.set(normalizedName(name), found);
      }
      for (const line of lines) {
        const key = normalizedName(line.playerName);
        if (line.sport !== 'MLB' || playerGames.has(key)) continue;
        const games = await this.history.cachedFor({ sport: 'MLB', eventId: '', playerName: line.playerName });
        if (games) playerGames.set(key, games);
      }
      this.playerGames = playerGames;
      this.rates = rates;
      const teams = new Map<string, string>();
      for (const line of lines) {
        const id = line.sport === 'MLB' ? proplineEventId(line.eventId) : null, game = id ? this.games.get(id)?.context : null;
        const key = `${id}|${normalizedName(line.playerName)}`;
        if (!id || !game || teams.has(key)) continue;
        const cached = this.playerGames.get(normalizedName(line.playerName));
        const team = line.team ?? (cached ? this.teamIn(cached, game) : null);
        if (team) teams.set(key, team);
      }
      this.teams = teams;
    }
    return fetched;
  }

  context(eventId: string): MlbContext | null {
    const id = proplineEventId(eventId);
    return id ? this.games.get(id)?.context ?? null : null;
  }

  private teamIn(games: readonly Game[], game: MlbContext): string | null {
    const team = playerTeam(games);
    return team && (sameTeam(team, game.home) || sameTeam(team, game.away)) ? team : null;
  }

  /**
   * Head-to-head for a line: a batter against tonight's starter (else his team), a pitcher against tonight's lineup's team.
   * Synchronous, from the games kept at refresh.
   */
  h2h(line: PropLine): HeadToHead | null {
    const game = line.sport === 'MLB' ? this.context(line.eventId) : null, read = proplineStat('MLB', line.market);
    const games = this.playerGames.get(normalizedName(line.playerName)), team = game ? this.teamOf(line) : null;
    if (!game || !read || !games || !team) return null;
    const home = sameTeam(team, game.home) && !sameTeam(team, game.away);
    const opponent = home ? game.away : game.home, pitcher = isPitcherMarket(line.market);
    const starterName = pitcher ? null : home ? game.awayPitcher : game.homePitcher;
    const starterGames = starterName ? this.playerGames.get(normalizedName(starterName)) : undefined;
    const games_ = pitcher ? games.filter((item) => item.stats.pitcher_started === 1) : games;
    return headToHead((stats) => gameValue(stats, read), games_, Date.parse(line.eventStartTime),
      { starter: starterName && starterGames ? { name: starterName, games: starterGames } : null, opponent });
  }

  private teamOf(line: Pick<PropLine, 'eventId' | 'playerName' | 'team'>): string | null {
    return line.team ?? this.teams.get(`${proplineEventId(line.eventId)}|${normalizedName(line.playerName)}`) ?? null;
  }

  /** The opposing starter's read for a line (GKR 2). */
  matchup(line: PropLine) {
    const game = line.sport === 'MLB' ? this.context(line.eventId) : null;
    return game ? pitcherMatchup(line, this.teamOf(line), game, this.rates, this.league) : null;
  }

  /** The weather's multiplier for a line (GKR 2). */
  weather(line: PropLine) {
    const game = line.sport === 'MLB' ? this.context(line.eventId) : null;
    return game ? weatherFactor(line, game) : null;
  }

  /** Edge's MLB adjustment for a line (starter, weather, rain). */
  adjustment(line: PropLine): Adjustment | null {
    const game = line.sport === 'MLB' ? this.context(line.eventId) : null;
    if (!game) return null;
    const base = mlbAdjustment(line, this.teamOf(line), game, this.rates, this.league), h2h = this.h2h(line);
    if (!h2h || Math.abs(h2h.factor - 1) < .01) return base;
    return { factor: (base?.factor ?? 1) * h2h.factor, reasons: [...base?.reasons ?? [], h2hReason(h2h, line.market.replace(/_/g, ' '))] };
  }

  status() {
    const cached = this.history?.cachedGames('baseball_mlb') ?? [];
    const pitchers = cached.filter((games) => games.some((game) => game.stats.pitcher_started === 1));
    return { cachedPlayers: cached.length, cachedPitchers: pitchers.length, usableStarts: cached.reduce((sum, games) => sum + starts(games).length, 0),
      allStarts: cached.reduce((sum, games) => sum + games.filter((game) => game.stats.pitcher_started === 1).length, 0), games: this.games.size, withContext: [...this.games.values()].filter((entry) => entry.context).length,
    starters: this.rates.size, league: this.league };
  }
}
