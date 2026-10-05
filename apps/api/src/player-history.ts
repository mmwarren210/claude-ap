import type { PlayerGameLog, PropLine } from '@crowniq/contracts';
import { normalizedName } from './context/match.js';
import type { HistoryArchive } from './history-archive.js';

// Free public history for the sports GKR has no stat source for (owner, 2026-10-05): each player's last 15-20 matches
// from ESPN tennis scoreboards, OpenDota (Dota 2 pro matches) and Leaguepedia (League of Legends pro games). It feeds
// Scout's research as facts, fills the cards' L5/L10/average, and goes to CrownIQ's own archive. It changes no GKR score.

export interface HistoryGame { readonly date: string; readonly opponent: string | null; readonly stats: Readonly<Record<string, number>> }
export interface HistoryResult { readonly games: readonly HistoryGame[]; readonly source: string; readonly url: string;
  /** Rows are single maps or games of a series (esports), not whole matches. */
  readonly perMap: boolean }
export interface HistorySource {
  readonly name: string;
  readonly sports: readonly string[];
  /** Bulk sources load everything here (tennis); per-player sources do nothing. Returns how many players it holds. */
  refresh(): Promise<number>;
  games(playerName: string): Promise<HistoryResult | null>;
  /** Sources that already hold values per stat (Sleeper's recent performance) answer for a market directly. */
  valuesFor?(playerName: string, market: string): Promise<{ values: { date: string; opponent: string | null; value: number }[];
    source: string; url: string } | null>;
}

const KEEP = 20;
type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const num = (value: unknown) => { const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null; };
const ymd = (time: number) => new Date(time).toISOString().slice(0, 10).replaceAll('-', '');

/** The stat a market asks for, from a history row; null when the history doesn't carry it. */
export function statFor(sport: string, market: string, stats: Readonly<Record<string, number>>): number | null {
  const m = market.toLowerCase(), pick = (key: string) => Number.isFinite(stats[key]) ? stats[key] : null;
  if (sport === 'TENNIS') {
    if (/break|ace|double|fault|fantasy|tiebreak/.test(m)) return null;
    const first = /1st_set|first_set|set_1/.test(m);
    if (/games_won|^games$|_games_won/.test(m) || (/won/.test(m) && /game/.test(m))) return pick(first ? 'firstSetGamesWon' : 'gamesWon');
    if (/games_lost/.test(m)) return pick('gamesLost');
    if (/total_games|games_played|^total_games/.test(m) || (/game/.test(m) && /total/.test(m))) return pick(first ? 'firstSetGames' : 'totalGames');
    if (/sets_won/.test(m)) return pick('setsWon');
    if (/total_sets|sets_played/.test(m)) return pick('totalSets');
    return null;
  }
  if (/fantasy|headshot|first_blood|tower|dragon|baron|roshan/.test(m)) return null;
  if (/kill/.test(m)) return pick('kills');
  if (/assist/.test(m)) return pick('assists');
  if (/death/.test(m)) return pick('deaths');
  if (/creep|last_hit|cs$|_cs_/.test(m)) return pick('cs');
  return null;
}
/** Esports lines over two maps ("maps 1+2") cover two history rows. */
export const twoMaps = (market: string) => /1_2|1_plus_2|maps_1|games_1/.test(market.toLowerCase());

/** Tennis from ESPN's public ATP and WTA scoreboards: every finished singles match of the last seven months. */
export class EspnTennisHistory implements HistorySource {
  readonly name = 'ESPN tennis scoreboards';
  readonly sports = ['TENNIS'];
  private players = new Map<string, HistoryGame[]>();
  constructor(private readonly fetchFn: typeof fetch = fetch, private readonly clock: () => Date = () => new Date(),
    private readonly days = 210) {}

  async refresh(): Promise<number> {
    const end = this.clock().getTime(), next = new Map<string, HistoryGame[]>();
    for (const tour of ['atp', 'wta']) for (let from = end - this.days * 86_400_000; from < end; from += 30 * 86_400_000) {
      const to = Math.min(end, from + 29 * 86_400_000);
      const response = await this.fetchFn(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${ymd(from)}-${ymd(to)}&limit=1000`,
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (!response?.ok) continue;
      for (const match of tennisMatches(await response.json().catch(() => null))) {
        for (const [index, player] of match.players.entries()) {
          const key = normalizedName(player.name), rows = next.get(key) ?? [];
          if (!rows.some((row) => row.date === match.date && row.opponent === match.players[1 - index].name))
            rows.push({ date: match.date, opponent: match.players[1 - index].name, stats: player.stats });
          next.set(key, rows);
        }
      }
    }
    for (const rows of next.values()) rows.sort((a, b) => b.date.localeCompare(a.date)).splice(KEEP);
    if (next.size) this.players = next;
    return this.players.size;
  }

  async games(playerName: string): Promise<HistoryResult | null> {
    const games = this.players.get(normalizedName(playerName));
    return games?.length ? { games, source: this.name, url: 'https://www.espn.com/tennis/scoreboard', perMap: false } : null;
  }
}

/** Finished singles matches from an ESPN tennis scoreboard, with each player's games and sets. Retirements and walkovers
 * are left out (their totals are cut short). */
export function tennisMatches(body: unknown) {
  const out: { date: string; players: { name: string; stats: Record<string, number> }[] }[] = [];
  for (const event of arr(obj(body)?.events)) for (const group of arr(obj(event)?.groupings)) {
    if (!/singles/i.test(String(obj(obj(group)?.grouping)?.displayName ?? ''))) continue;
    for (const value of arr(obj(group)?.competitions)) {
      const match = obj(value), type = obj(obj(match?.status)?.type);
      if (type?.completed !== true || /ret|w\/o|walkover|default|abandon/i.test(`${type.detail ?? ''} ${type.shortDetail ?? ''} ${JSON.stringify(match?.notes ?? '')}`)) continue;
      const sides = arr(match?.competitors).map((item) => obj(item));
      if (sides.length !== 2) continue;
      const sets = sides.map((side) => arr(side?.linescores).map((score) => num(obj(score)?.value)));
      if (sets.some((list) => !list.length || list.some((games) => games === null)) || sets[0].length !== sets[1].length) continue;
      const names = sides.map((side) => String(obj(side?.athlete)?.displayName ?? ''));
      if (names.some((name) => !name)) continue;
      const date = String(match?.date ?? match?.startDate ?? '');
      if (!Number.isFinite(Date.parse(date))) continue;
      const players = [0, 1].map((index) => {
        const mine = sets[index] as number[], theirs = sets[1 - index] as number[];
        const won = mine.reduce((sum, games) => sum + games, 0), lost = theirs.reduce((sum, games) => sum + games, 0);
        return { name: names[index], stats: { gamesWon: won, gamesLost: lost, totalGames: won + lost,
          setsWon: mine.filter((games, set) => games > theirs[set]).length, totalSets: mine.length,
          firstSetGamesWon: mine[0], firstSetGames: mine[0] + theirs[0] } };
      });
      out.push({ date: new Date(date).toISOString(), players });
    }
  }
  return out;
}

/** Per-player sources keep each answer for six hours. */
abstract class CachedSource implements HistorySource {
  abstract readonly name: string;
  abstract readonly sports: readonly string[];
  private cache = new Map<string, { until: number; value: Promise<HistoryResult | null> }>();
  /** The last failure (a code, never a payload), for the server log. */
  lastError: string | null = null;
  constructor(protected readonly fetchFn: typeof fetch = fetch, protected readonly clock: () => Date = () => new Date()) {}
  async refresh() { return 0; }
  protected abstract load(playerName: string): Promise<HistoryResult | null>;
  games(playerName: string) {
    const key = normalizedName(playerName), now = this.clock().getTime(), cached = this.cache.get(key);
    if (cached && cached.until > now) return cached.value;
    const entry = { until: now + 6 * 3600_000, value: Promise.resolve<HistoryResult | null>(null) };
    entry.value = this.load(playerName).catch((error: unknown) => {
      // A failure (a rate limit, say) is retried after 15 minutes, not six hours.
      this.lastError = String(error instanceof Error ? error.message : error).slice(0, 160);
      entry.until = this.clock().getTime() + 15 * 60_000; return null; });
    this.cache.set(key, entry);
    const value = entry.value;
    if (this.cache.size > 5000) this.cache.clear();
    return value;
  }
  protected async json(url: string): Promise<unknown> {
    const response = await this.fetchFn(url, { headers: { accept: 'application/json',
      'user-agent': 'CrownIQ/1.0 (pick research; contact via crowniq.up.railway.app)' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HISTORY_HTTP_${response.status}`);
    return response.json();
  }
}

/**
 * Dota 2 from OpenDota's free API: the recent pro (league) matches, each match's players (league matches are public even
 * when a player hides their own history), kept as each player's last 20 maps. Loads up to 400 matches the first time,
 * then only new ones, one request a second (OpenDota's free limit is 60 a minute).
 */
export class OpenDotaHistory implements HistorySource {
  readonly name = 'OpenDota pro matches';
  readonly sports = ['DOTA'];
  lastError: string | null = null;
  private seen = new Set<number>();
  private players = new Map<string, HistoryGame[]>();
  private refreshing: Promise<number> | null = null;
  constructor(private readonly fetchFn: typeof fetch = fetch, private readonly pause = (ms: number) => new Promise<void>((done) => {
    const timer = setTimeout(done, ms); timer.unref?.(); }), private readonly maxMatches = 400) {}
  private async json(url: string): Promise<unknown> {
    // OpenDota's free tier allows 60 a minute; on "too many requests" wait and try twice more.
    for (const wait of [0, 15_000, 45_000]) {
      if (wait) await this.pause(wait);
      const response = await this.fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (response.status === 429) continue;
      if (!response.ok) throw new Error(`OPENDOTA_HTTP_${response.status}`);
      return response.json();
    }
    throw new Error('OPENDOTA_HTTP_429');
  }
  refresh(): Promise<number> {
    this.refreshing ??= this.load().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async load(): Promise<number> {
    try {
      const names = new Map<number, string>();
      for (const value of arr(await this.json('https://api.opendota.com/api/proPlayers'))) {
        const row = obj(value), id = num(row?.account_id), name = String(row?.name ?? '').trim();
        if (id && name) names.set(id, name);
      }
      // Newest pro matches first, until a page holds only matches already loaded (or the cap is reached).
      const fresh: { id: number; start: number; radiant: string | null; dire: string | null }[] = [];
      let before: number | null = null;
      for (let page = 0; page < Math.ceil(this.maxMatches / 100) && fresh.length < this.maxMatches; page++) {
        const rows = arr(await this.json(`https://api.opendota.com/api/proMatches${before ? `?less_than_match_id=${before}` : ''}`));
        if (!rows.length) break;
        let added = 0;
        for (const value of rows) {
          const row = obj(value), id = num(row?.match_id), start = num(row?.start_time);
          if (!id || !start) continue;
          before = before === null ? id : Math.min(before, id);
          if (this.seen.has(id)) continue;
          fresh.push({ id, start, radiant: typeof row?.radiant_name === 'string' ? row.radiant_name : null,
            dire: typeof row?.dire_name === 'string' ? row.dire_name : null }); added++;
        }
        if (!added) break;
        await this.pause(1000);
      }
      for (const match of fresh.slice(0, this.maxMatches)) {
        try {
          const detail = obj(await this.json(`https://api.opendota.com/api/matches/${match.id}`));
          for (const value of arr(detail?.players)) {
            const player = obj(value), id = num(player?.account_id), name = id ? names.get(id) : undefined;
            if (!name) continue;
            const radiant = player?.isRadiant === true || (num(player?.player_slot) ?? 128) < 128;
            const key = normalizedName(name), rows = this.players.get(key) ?? [];
            rows.push({ date: new Date(match.start * 1000).toISOString(), opponent: radiant ? match.dire : match.radiant,
              stats: { kills: num(player?.kills) ?? NaN, deaths: num(player?.deaths) ?? NaN, assists: num(player?.assists) ?? NaN,
                cs: num(player?.last_hits) ?? NaN } });
            this.players.set(key, rows.sort((x, y) => y.date.localeCompare(x.date)).slice(0, KEEP));
          }
          this.seen.add(match.id);
        } catch (error) { this.lastError = String(error instanceof Error ? error.message : error).slice(0, 120); }
        await this.pause(1500);
      }
    } catch (error) { this.lastError = String(error instanceof Error ? error.message : error).slice(0, 120); }
    return this.players.size;
  }
  async games(playerName: string): Promise<HistoryResult | null> {
    const games = this.players.get(normalizedName(playerName));
    if (!games?.length && !this.players.size && !this.lastError) this.lastError = 'NOT_LOADED_YET';
    return games?.length ? { games, source: this.name, url: 'https://www.opendota.com/matches/pro', perMap: true } : null;
  }
}

/** League of Legends from Leaguepedia's free data: a player's last 20 pro games (kills, deaths, assists, creep score). */
export class LeaguepediaHistory extends CachedSource {
  readonly name = 'Leaguepedia pro games';
  readonly sports = ['LOL'];
  protected async load(playerName: string): Promise<HistoryResult | null> {
    const name = playerName.replace(/["\\]/g, '');
    const params = new URLSearchParams({ action: 'cargoquery', format: 'json', tables: 'ScoreboardPlayers',
      fields: 'ScoreboardPlayers.Kills=Kills,ScoreboardPlayers.Deaths=Deaths,ScoreboardPlayers.Assists=Assists,' +
        'ScoreboardPlayers.CS=CS,ScoreboardPlayers.DateTime_UTC=Date,ScoreboardPlayers.Team=Team',
      where: `ScoreboardPlayers.Link="${name}" OR ScoreboardPlayers.Name="${name}"`,
      order_by: 'ScoreboardPlayers.DateTime_UTC DESC', limit: String(KEEP) });
    let body: Json | null = null;
    // Leaguepedia throttles shared cloud servers; two slower tries before giving up for now.
    for (const wait of [0, 4000, 12000]) {
      if (wait) await new Promise<void>((done) => { const timer = setTimeout(done, wait); timer.unref?.(); });
      body = obj(await this.json(`https://lol.fandom.com/api.php?${params}`));
      if (String(obj(body?.error)?.code ?? '') !== 'ratelimited') break;
    }
    if (body?.error) { this.lastError = `CARGO_${String(obj(body.error)?.code ?? 'ERROR').slice(0, 40)}`; throw new Error(this.lastError); }
    const games = arr(body?.cargoquery).flatMap((value) => {
      const row = obj(obj(value)?.title), date = String(row?.Date ?? '');
      if (!Number.isFinite(Date.parse(date.replace(' ', 'T') + 'Z'))) return [];
      return [{ date: new Date(date.replace(' ', 'T') + 'Z').toISOString(), opponent: null, stats: { kills: num(row?.Kills) ?? NaN,
        deaths: num(row?.Deaths) ?? NaN, assists: num(row?.Assists) ?? NaN, cs: num(row?.CS) ?? NaN } }];
    });
    return games.length ? { games, source: this.name, url: `https://lol.fandom.com/wiki/${encodeURIComponent(name)}`, perMap: true } : null;
  }
}

/** A stat's kind and scope, so "kills_maps_1_2", "maps_1_2_kills" and "Kills on Maps 1+2" match each other. */
export function statKind(stat: string) {
  const m = stat.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const kind = ['headshots', 'kills', 'deaths', 'assists', 'double_faults', 'aces', 'break_points', 'games_won', 'games_lost',
    'total_games', 'sets_won', 'total_sets', 'fantasy'].find((name) => m.includes(name)) ?? m;
  return `${kind}|${twoMaps(m) ? 'maps12' : /1st_set|first_set|set_1/.test(m) ? 'set1' : 'all'}`;
}

/** The Apify run that pulls Sleeper's lines, kept apart from the client so tests can stand in for it. */
export interface SleeperRunner { run(): Promise<unknown[] | null> }

/**
 * Sleeper's pick'em lines carry each player's recent results for that exact stat (the last 10 series for a CS2 "kills,
 * maps 1+2" line, the last matches for tennis aces). One small Apify run (about a cent) twice a day, under the shared
 * scraper cap; the answers are saved so a restart doesn't pay again.
 */
export class SleeperHistory implements HistorySource {
  readonly name = 'Sleeper recent performance';
  readonly sports = ['CS2', 'TENNIS'];
  lastError: string | null = null;
  private byPlayer = new Map<string, { date: string; opponent: string | null; value: number }[]>();
  private fetchedAt = 0;
  private loaded = false;
  constructor(private readonly runner: SleeperRunner | null, private readonly file: string | null,
    private readonly clock: () => Date = () => new Date(), private readonly everyHours = 12) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const { readFile } = await import('node:fs/promises');
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { fetchedAt: number; rows: [string, { date: string; opponent: string | null; value: number }[]][] };
      this.byPlayer = new Map(saved.rows); this.fetchedAt = saved.fetchedAt;
    } catch { /* first run */ }
  }
  /** Reads Sleeper's rows into player-and-stat histories. */
  ingest(rows: readonly unknown[]) {
    const next = new Map<string, { date: string; opponent: string | null; value: number }[]>();
    for (const value of rows) {
      const row = obj(value), player = String(row?.playerName ?? ''), stat = String(row?.stat ?? row?.wagerType ?? '');
      const recent = arr(row?.recentPerformance).flatMap((item) => { const game = obj(item), result = num(game?.value), date = String(game?.date ?? '');
        return result === null || !Number.isFinite(Date.parse(date)) ? [] : [{ date, opponent: typeof game?.opponent === 'string' ? game.opponent : null, value: result }]; });
      if (!player || !stat || !recent.length) continue;
      next.set(`${normalizedName(player)}|${statKind(stat)}`, recent.sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP));
    }
    return next;
  }
  async refresh(): Promise<number> {
    await this.load();
    if (!this.runner || this.clock().getTime() - this.fetchedAt < this.everyHours * 3600_000 - 600_000) return this.byPlayer.size;
    try {
      const rows = await this.runner.run();
      if (!rows) { this.lastError = 'BUDGET_OR_NOT_CONFIGURED'; return this.byPlayer.size; }
      const next = this.ingest(rows);
      if (next.size) {
        this.byPlayer = next; this.fetchedAt = this.clock().getTime();
        if (this.file) {
          const { mkdir, rename, writeFile } = await import('node:fs/promises');
          const { dirname } = await import('node:path');
          await mkdir(dirname(this.file), { recursive: true });
          await writeFile(`${this.file}.tmp`, JSON.stringify({ fetchedAt: this.fetchedAt, rows: [...this.byPlayer] }));
          await rename(`${this.file}.tmp`, this.file);
        }
      }
    } catch (error) { this.lastError = String(error instanceof Error ? error.message : error).slice(0, 120); }
    return this.byPlayer.size;
  }
  async games() { return null; }
  async valuesFor(playerName: string, market: string) {
    await this.load();
    const values = this.byPlayer.get(`${normalizedName(playerName)}|${statKind(market)}`);
    return values?.length ? { values, source: this.name, url: 'https://sleeper.com/picks' } : null;
  }
}

/** The sources together: refreshed on a timer, read by Scout and the game-log route, written to the archive. */
export class PlayerHistory {
  private timer: NodeJS.Timeout | null = null;
  private archived = new Set<string>();
  readonly lastRefresh: Record<string, { at: string; players: number } | { at: string; error: string }> = {};
  constructor(private readonly sources: readonly HistorySource[], private readonly archive: HistoryArchive | null = null,
    private readonly clock: () => Date = () => new Date()) {}

  private sourcesFor(sport: string) { return this.sources.filter((source) => source.sports.includes(sport)); }
  private sourceFor(sport: string) { return this.sourcesFor(sport)[0] ?? null; }
  supports(sport: string) { return this.sourcesFor(sport).length > 0; }


  async refresh() {
    for (const source of this.sources) {
      try { const players = await source.refresh(); if (players) this.lastRefresh[source.name] = { at: this.clock().toISOString(), players }; }
      catch (error) { this.lastRefresh[source.name] = { at: this.clock().toISOString(), error: String(error).slice(0, 200) }; }
    }
  }
  start(hours = 12) {
    if (this.timer) return;
    void this.refresh().then(async () => {
      // One known player per per-player source, so the server log shows each source answering.
      const probes = await Promise.all([['DOTA', 'Yatoro'], ['LOL', 'Faker']].filter(([sport]) => this.supports(sport))
        .map(async ([sport, name]) => [`${sport} ${name}`, `${(await this.values(sport, name, 'kills').catch(() => null))?.values.length ?? 0}` +
          `${(this.sourceFor(sport) as { lastError?: string | null } | null)?.lastError ? ` (${(this.sourceFor(sport) as { lastError?: string | null }).lastError})` : ''}`]));
      console.log(`[history] ${JSON.stringify({ ...this.lastRefresh, probes: Object.fromEntries(probes) })}`);
    }).catch(() => undefined);
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, hours * 3600_000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** A player's recent values for one market (newest first), from the first source that has them; null when none does. */
  async values(sport: string, playerName: string, market: string) {
    for (const source of this.sourcesFor(sport)) {
      if (source.valuesFor) {
        const direct = await source.valuesFor(playerName, market).catch(() => null);
        if (direct?.values.length) return { ...direct, perMap: false };
        continue;
      }
      const result = await source.games(playerName).catch(() => null);
      if (!result) continue;
      this.keep(sport, playerName, result);
      const values = result.games.flatMap((game) => { const value = statFor(sport, market, game.stats);
        return value === null ? [] : [{ date: game.date, opponent: game.opponent, value }]; });
      if (values.length) return { values, source: result.source, url: result.url, perMap: result.perMap };
    }
    return null;
  }

  private keep(sport: string, playerName: string, result: HistoryResult) {
    if (!this.archive) return;
    const fresh = result.games.filter((game) => !this.archived.has(`${sport}|${playerName}|${game.date}`));
    if (!fresh.length) return;
    for (const game of fresh) this.archived.add(`${sport}|${playerName}|${game.date}`);
    void this.archive.append('games', fresh.map((game) => ({ key: `free:${sport}:${normalizedName(playerName)}:${game.date}`,
      record: { source: result.source, sourceUrl: result.url, sport, playerName, occurredAt: game.date, opponent: game.opponent,
        perMap: result.perMap, metrics: game.stats } })));
  }

  /** The card's game log: whole matches only (a two-map esports line has no single-row value). */
  async gameLog(sport: string, playerId: string, playerName: string, market: string): Promise<PlayerGameLog | null> {
    const found = await this.values(sport, playerName, market);
    if (!found || (found.perMap && twoMaps(market))) return null;
    return { sport: sport as PlayerGameLog['sport'], playerId, playerName, market, source: 'FREE_PUBLIC_HISTORY',
      unit: null, games: found.values.slice(0, KEEP).map((game) => ({ date: game.date.slice(0, 10), opponent: game.opponent, value: game.value })) };
  }

  /** Plain facts for Scout: the last values, the average and how often they cleared this line. */
  async factsFor(line: Pick<PropLine, 'sport' | 'playerName' | 'market' | 'threshold'>): Promise<string[]> {
    const found = await this.values(line.sport, line.playerName, line.market).catch(() => null);
    if (!found) return [];
    const values = found.values.slice(0, KEEP), list = values.map((game) => game.value);
    const average = list.reduce((sum, value) => sum + value, 0) / list.length;
    const unit = found.perMap ? 'maps' : 'matches';
    const facts = [`Last ${list.length} ${unit} (${found.source}, newest first): ${list.join(', ')}. Average ${average.toFixed(1)}` +
      (found.perMap ? ' per map.' : '.')];
    if (found.perMap && twoMaps(line.market)) facts.push(`This line covers maps 1 and 2 together: about ${(average * 2).toFixed(1)} at that average.`);
    else { const over = list.filter((value) => value > line.threshold).length;
      facts.push(`Went over ${line.threshold} in ${over} of those ${list.length}.`); }
    return facts;
  }
}
