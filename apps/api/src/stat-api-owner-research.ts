/** Personal, owner-only stat-api research. This module never creates GKR evidence or result facts. */
export type StatApiSport = 'NFL' | 'NBA' | 'MLB' | 'PGA';
export type StatApiPlayer = { id: number; name: string; teamId: number | null };
export type StatApiAvailability = {
  player: StatApiPlayer;
  rosterStatus: string | null;
  injuryStatus: string | null;
  status: string | null;
  preGameStatus: number | null;
  preGameInjuryStatus: string | null;
  preGameStarter: boolean | null;
  sourceUrl: string;
  retrievedAt: string;
};

type JsonRow = Record<string, unknown>;
type ApiPage = { rows: JsonRow[]; nextFromId: number | null; url: string; retrievedAt: string };
type CacheEntry = { until: number; page: ApiPage };

export class StatApiOwnerError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

const BASE = 'https://api.stat-api.com/api/v1';
const SEARCH_TTL = 6 * 60 * 60_000;
const STATS_TTL = 15 * 60_000;
const FIELD_KEYS: Record<StatApiSport, Record<string, string[]>> = {
  NFL: { game_player_stats: ['passing_yds', 'pass_attempts', 'completions',
    'receiving_yds', 'receptions', 'targets', 'rushing_yds', 'rushing_attempts',
    'offensive_snaps', 'fantasy_pts', 'passing_tds', 'interceptions_thrown', 'rushing_tds', 'receiving_tds',
    'solo_tackles', 'assisted_tackles', 'defensive_sacks', 'quarterback_hits', 'defensive_interceptions',
    'passes_defended', 'field_goals_made', 'field_goals_attempted', 'extra_pts_made', 'receiving_long',
    'rushing_long', 'passing_long', 'passing_air_yds', 'punts', 'sacks_allowed'] },
  NBA: { game_player_stats: ['pts', 'rebounds', 'assists', 'potential_assists',
    'minutes', 'field_goals_attempted', 'three_pointers_attempted', 'turnovers'] },
  MLB: { game_player_batter_stats: ['plate_appearances', 'at_bats', 'hits', 'doubles',
    'triples', 'home_runs', 'runs', 'runs_batted_in', 'walks', 'stolen_bases', 'singles', 'total_bases',
    'strikeouts', 'caught_stealing'],
    game_player_pitching_stats: ['innings_pitched', 'pitches_thrown', 'batters_faced',
      'strikeouts_pitched', 'walks_allowed', 'earned_runs', 'hits_allowed', 'outs'] },
  PGA: { player_rounds: ['round_number','score','par','birdies','eagles','bogeys',
    'sg_total','sg_off_tee','sg_approach','sg_putting'],
    player_season_stats: ['events','cuts_made','wins','top_ten',
      'sg_total','driving_distance','gir_pct'] },
};

function object(value: unknown): JsonRow {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StatApiOwnerError('STAT_API_INVALID_RESPONSE', 502);
  return value as JsonRow;
}
function player(row: JsonRow): StatApiPlayer | null {
  const id = Number(row.id), name = row.full_name;
  if (!Number.isSafeInteger(id) || id < 1 || typeof name !== 'string' || !name.trim()) return null;
  const teamId = Number(row.team_id);
  return { id, name: name.trim(), teamId: Number.isSafeInteger(teamId) && teamId > 0 ? teamId : null };
}
const canonicalPlayerName=(value:string,stripSuffix:boolean)=>{
  let normalized=value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  if(stripSuffix)normalized=normalized.replace(/\s+(jr|sr|ii|iii|iv)$/,'');
  const tokens=normalized.split(' ').filter(Boolean);
  let initialCount=0;
  while(initialCount<tokens.length&&tokens[initialCount].length===1)initialCount++;
  return initialCount>=2
    ? [tokens.slice(0,initialCount).join(''),...tokens.slice(initialCount)].join(' ')
    : normalized;
};
const normalizePlayerName=(value:string)=>canonicalPlayerName(value,true);

function occurredAt(row: JsonRow): string | null {
  for (const key of ['game_date','game_time','date','start_time','start_date','game_datetime','start_datetime']) {
    const value = row[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return null;
}

export class StatApiOwnerResearch {
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, Promise<ApiPage>>();
  private usageDay = '';
  private quotaMonth = '';
  private todayRows = 0;
  private reservedRows = 0;
  private quotaUsed: number | null = null;
  private quotaRemaining: number | null = null;

  constructor(private readonly key: string, private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
    private readonly dailyLimit = 100_000) {
    if (!key.trim() || !Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 500_000)
      throw new Error('INVALID_STAT_API_CONFIGURATION');
  }

  status() {
    this.resetDay();
    return { configured: true, todayRows: this.todayRows, dailyLimit: this.dailyLimit,
      quotaUsed: this.quotaUsed, quotaRemaining: this.quotaRemaining,
      supportedSports: ['NFL', 'NBA', 'MLB', 'PGA'] as const, publicBoardImpact: 'NONE' as const };
  }

  private resetDay() {
    const day = this.clock().toISOString().slice(0, 10);
    if (day !== this.usageDay) { this.usageDay = day; this.todayRows = 0; }
    if (day.slice(0, 7) !== this.quotaMonth) {
      this.quotaMonth = day.slice(0, 7);
      this.quotaUsed = null;
      this.quotaRemaining = null;
    }
  }

  private async page(sport: StatApiSport, table: string, params: Record<string, string>,
    ttl: number, maxRows: number): Promise<ApiPage> {
    const url = new URL(`${BASE}/${sport.toLowerCase()}/${table}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const address = url.toString(), now = this.clock().getTime();
    const cached = this.cache.get(address);
    if (cached && cached.until > now) return cached.page;
    const inFlight = this.pending.get(address);
    if (inFlight) return inFlight;
    const task = (async () => {
      this.resetDay();
      if (this.todayRows + this.reservedRows + maxRows > this.dailyLimit ||
        this.quotaRemaining !== null && this.quotaRemaining < maxRows)
        throw new StatApiOwnerError('STAT_API_BUDGET_EXHAUSTED', 429);
      this.reservedRows += maxRows;
      try {
      let response: Response;
      try { response = await this.fetchFn(address, { headers: { authorization: `Bearer ${this.key}`,
        accept: 'application/json' }, signal: AbortSignal.timeout(9000) }); }
      catch { throw new StatApiOwnerError('STAT_API_UNREACHABLE', 502); }
      if (response.status === 429) {
        this.quotaRemaining = 0;
        throw new StatApiOwnerError('STAT_API_QUOTA_EXHAUSTED', 429);
      }
      if (response.status === 401 || response.status === 403)
        throw new StatApiOwnerError('STAT_API_KEY_REJECTED', 502);
      if (response.status === 404) throw new StatApiOwnerError('STAT_API_PLAYER_NOT_FOUND', 404);
      if (!response.ok) throw new StatApiOwnerError('STAT_API_UNAVAILABLE', 502);
      if (Number(response.headers.get('content-length') ?? 0) > 5_000_000)
        throw new StatApiOwnerError('STAT_API_RESPONSE_TOO_LARGE', 502);
      const body = await response.text();
      if (body.length > 5_000_000) throw new StatApiOwnerError('STAT_API_RESPONSE_TOO_LARGE', 502);
      let data: JsonRow | JsonRow[];
      try {
        const parsed: unknown = JSON.parse(body);
        data = table === 'players/search' && Array.isArray(parsed)
          ? parsed.map(object) : object(parsed);
      }
      catch { throw new StatApiOwnerError('STAT_API_INVALID_RESPONSE', 502); }
      const rows = Array.isArray(data) ? data : /^players\/\d+$/.test(table) ? [data] :
        table === 'players/search' ? data.players : data[table];
      if (!Array.isArray(rows) || rows.length > maxRows)
        throw new StatApiOwnerError('STAT_API_INVALID_RESPONSE', 502);
      const id = Array.isArray(data) ? null : data.next_from_id;
      const nextFromId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
      const page: ApiPage = { rows: rows.map(object), nextFromId, url: address,
        retrievedAt: this.clock().toISOString() };
      this.todayRows += rows.length;
      for (const [header, set] of [
        ['x-quota-used', (n: number) => { this.quotaUsed = n; }],
        ['x-quota-remaining', (n: number) => { this.quotaRemaining = n; }],
      ] as const) {
        const value = response.headers.get(header);
        if (value !== null && /^\d+$/.test(value)) set(Number(value));
      }
      this.cache.set(address, { page, until: this.clock().getTime() + ttl });
      return page;
      } finally { this.reservedRows -= maxRows; }
    })();
    this.pending.set(address, task);
    try { return await task; }
    finally { this.pending.delete(address); }
  }

  private async recentGameTimes(sport: StatApiSport): Promise<Map<number,string>> {
    const seasons = await this.page(sport, 'seasons', { limit: '200' }, SEARCH_TTL, 200);
    const currentYear=this.clock().getUTCFullYear();
    const recent=seasons.rows.map((row)=>({startYear:Number(row.start_year)}))
      .filter((row)=>Number.isSafeInteger(row.startYear)&&row.startYear<=currentYear)
      .sort((a,b)=>b.startYear-a.startYear).slice(0,3);
    const result=new Map<number,string>();
    const gameLimit=sport==='NFL'?500:sport==='NBA'?1500:3000;
    for(const season of recent){
      const page=await this.page(sport,'games',{season_id:String(season.startYear),
        limit:String(gameLimit)},SEARCH_TTL,gameLimit);
      for(const row of page.rows){
        const id=Number(row.id),time=occurredAt(row);
        if(Number.isSafeInteger(id)&&id>0&&time)result.set(id,time);
      }
    }
    return result;
  }

  async search(sport: StatApiSport, query: string) {
    const q = query.trim().toLocaleLowerCase();
    if (q.length < 2 || q.length > 80) throw new StatApiOwnerError('INVALID_PLAYER_QUERY', 400);
    if (sport === 'NBA') {
      const page = await this.page(sport, 'players/search', { q: query.trim(), limit: '20' },
        SEARCH_TTL, 20);
      return { players: page.rows.map(player).filter((p): p is StatApiPlayer => p !== null),
        partial: false, sourceUrl: page.url, retrievedAt: page.retrievedAt };
    }
    // NFL/MLB have no documented name-search endpoint; PGA has no roster-status
    // filter. Scan a bounded player page and expose incomplete coverage if capped.
    // Roster statuses lag: playoff regulars can still read injured_reserve or inactive. Those players are included;
    // whether they actually play is decided by the official lineup and status checks, not by this list.
    // They are read only when the active list has no match, so an ordinary search stays one request.
    const wanted=normalizePlayerName(query);
    const scan = (status: string | null) => this.page(sport, 'players',
      status ? { roster_status: status, limit: '2500' } : { limit: '2500' }, SEARCH_TTL, 2500);
    const matching = (list: readonly ApiPage[]) => [...new Map(list.flatMap((page) => page.rows).map(player)
      .filter((p): p is StatApiPlayer => p !== null && normalizePlayerName(p.name).includes(wanted))
      .map((p) => [p.id, p])).values()].slice(0, 20);
    const pages = [await scan(sport === 'PGA' ? null : 'active')];
    if (sport !== 'PGA' && !matching(pages).length)
      pages.push(...await Promise.all(['injured_reserve', 'inactive'].map(scan)));
    const players = matching(pages);
    return { players, partial: pages.some((page) => page.nextFromId !== null), sourceUrl: pages[0].url,
      retrievedAt: pages[0].retrievedAt };
  }

  /**
   * Players of any roster status whose name contains `query`, paging the full player table (up to `maxPages` pages
   * of 2,500). For players the active-roster scan misses. Cached like a search; it uses rows from the daily budget.
   */
  async searchAnyStatus(sport: Exclude<StatApiSport, 'NBA'>, query: string, maxPages = 8) {
    const wanted = normalizePlayerName(query);
    if (wanted.length < 2 || wanted.length > 80) throw new StatApiOwnerError('INVALID_PLAYER_QUERY', 400);
    const found: (StatApiPlayer & { rosterStatus: string | null })[] = [];
    let fromId: number | null = 0, pages = 0;
    while (fromId !== null && pages < maxPages) {
      const page: ApiPage = await this.page(sport, 'players', { limit: '2500', from_id: String(fromId) }, SEARCH_TTL, 2500);
      pages++;
      for (const row of page.rows) {
        const match = player(row);
        if (match && normalizePlayerName(match.name).includes(wanted))
          found.push({ ...match, rosterStatus: typeof row.roster_status === 'string' ? row.roster_status : null });
      }
      fromId = page.nextFromId;
    }
    return { players: found, pages, partial: fromId !== null };
  }

  async currentAvailability(sport: 'NBA', query: string): Promise<StatApiAvailability | null> {
    const q=query.trim();
    if(q.length<2||q.length>80)throw new StatApiOwnerError('INVALID_PLAYER_QUERY',400);
    const search=await this.page('NBA','players/search',{q,limit:'20'},5*60_000,20);
    const strictWanted=canonicalPlayerName(q,false),relaxedWanted=canonicalPlayerName(q,true);
    let matches=search.rows.filter((row)=>typeof row.full_name==='string' &&
      canonicalPlayerName(row.full_name,false)===strictWanted);
    if(!matches.length)matches=search.rows.filter((row)=>typeof row.full_name==='string' &&
      canonicalPlayerName(row.full_name,true)===relaxedWanted);
    if(matches.length!==1)return null;
    const match=player(matches[0]);
    if(!match)return null;
    const detail=await this.page('NBA',`players/${match.id}`,{},5*60_000,1);
    const row=detail.rows[0];
    const exact=row?player(row):null;
    if(!row||!exact||canonicalPlayerName(exact.name,false)!==canonicalPlayerName(match.name,false))return null;
    const text=(key:string)=>typeof row[key]==='string'&&row[key].trim()?row[key].trim():null;
    const rawPreGameStatus=Number(row.pre_game_status);
    const preGameStatus=Number.isSafeInteger(rawPreGameStatus)?rawPreGameStatus:null;
    const rawStarter=row.pre_game_starter;
    const preGameStarter=typeof rawStarter==='boolean'?rawStarter:
      rawStarter===1||rawStarter==='1'?true:rawStarter===0||rawStarter==='0'?false:null;
    return {player:exact,rosterStatus:text('roster_status'),injuryStatus:text('injury_status'),
      status:text('status'),preGameStatus,preGameInjuryStatus:text('pre_game_injury_status'),
      preGameStarter,sourceUrl:detail.url,retrievedAt:detail.retrievedAt};
  }

  /** Every column one game-log row carries (names and sample values), to map new stats to their fields. */
  async columns(sport: StatApiSport, table: string, playerId: number) {
    if (!/^[a-z_]+$/.test(table) || !Number.isSafeInteger(playerId) || playerId < 1)
      throw new StatApiOwnerError('INVALID_QUERY', 400);
    const page = await this.page(sport, table, { player_id: String(playerId), limit: '3' }, STATS_TTL, 3);
    return { table, rows: page.rows.length, columns: page.rows[0] ?? null };
  }

  async inspect(sport: StatApiSport, playerId: number, table: string) {
    if (!Number.isSafeInteger(playerId) || playerId < 1)
      throw new StatApiOwnerError('INVALID_PLAYER_ID', 400);
    const fields = FIELD_KEYS[sport][table];
    if (!fields) throw new StatApiOwnerError('UNSUPPORTED_RESEARCH_TABLE', 400);
    const info = await this.page(sport, `players/${playerId}`, {}, STATS_TTL, 1);
    // Confirm the selected stat-api player ID before showing rows under a name.
    const person = info.rows.map(player).find((item) => item?.id === playerId);
    if (!person) throw new StatApiOwnerError('STAT_API_PLAYER_NOT_FOUND', 404);
    // NFL skill-position models need a recent dated window. stat-api game logs are cursor-paged,
    // so request the complete practical NFL career window from a stable from_id=0 page instead of
    // relying on the default first 40 rows, which can leave recent game ids unavailable for dating.
    const historyLimit=sport==='NFL'&&table==='game_player_stats'?500:
      sport==='NBA'&&table==='game_player_stats'?250:
      sport==='MLB'&&table.startsWith('game_player_')?500:40;
    const historyParams:Record<string,string>={player_id:String(playerId),limit:String(historyLimit)};
    if(table.startsWith('game_player_'))historyParams.from_id='0';
    const page = await this.page(sport, table, historyParams, STATS_TTL, historyLimit);
    const needsGameJoin=table.startsWith('game_player_') && page.rows.some((row)=>
      Number.isSafeInteger(Number(row.game_id)) && !occurredAt(row));
    const gameTimes=needsGameJoin ? await this.recentGameTimes(sport) : new Map<number,string>();
    return { sport, player: person, table, sourceUrl: page.url, retrievedAt: page.retrievedAt,
      nextFromId: page.nextFromId, sampleOnly: true as const, officialStatusConfirmed: false as const,
      rows: page.rows.map((row) => {
        const metrics = Object.fromEntries(fields.filter((field) =>
          typeof row[field] === 'number' && Number.isFinite(row[field]) ||
          typeof row[field] === 'string' && /^-?\d+(\.\d+)?$/.test(row[field] as string))
          .map((field) => [field, Number(row[field])]));
        const gameId = Number(row.game_id), tournamentId = Number(row.tournament_id);
        const validGameId=Number.isSafeInteger(gameId) && gameId > 0 ? gameId : null;
        return { gameId: validGameId,
          tournamentId: Number.isSafeInteger(tournamentId) && tournamentId > 0
            ? tournamentId : null,
          occurredAt: occurredAt(row) ?? (validGameId ? gameTimes.get(validGameId)??null : null),
          metrics };
      }) };
  }
}
