import { readFile, stat } from 'node:fs/promises';
import type { NflPassingResult, SavedSelection } from '@crowniq/contracts';
import { z } from 'zod';

const mappingSchema = z.object({
  format: z.literal('crowniq-nflverse-map-v1'),
  mappings: z.array(z.object({
    eventId: z.string().min(1), playerId: z.string().min(1),
    nflverseGameId: z.string().regex(/^20\d\d_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/),
    nflversePlayerId: z.string().min(1), team: z.string().regex(/^[A-Z]{2,3}$/),
    season: z.number().int().min(1999).max(2100), completedAt: z.iso.datetime({ offset: true }),
  }).strict()).max(5000),
}).strict();

type Mapping = z.infer<typeof mappingSchema>['mappings'][number];
type StatRow = Record<string,string> & { game_id:string; player_id:string; team:string;
  attempts:string; passing_yards:string };
type ScheduleRow = Record<string,string> & { game_id:string; season:string; gameday:string;
  gametime:string; away_team:string; away_score:string; home_team:string; home_score:string };

// The published nflreadr URL convention: stats_player/stats_player_week_YEAR.csv.
export function nflverseStatsUrl(season: number): string {
  if (!Number.isInteger(season) || season < 1999 || season > 2100) throw new Error('INVALID_SEASON');
  return `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
}
export const nflverseScheduleUrl='https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';

function csvRows(input: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [], field = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || field === '') quoted = !quoted;
      else throw new Error('INVALID_CSV_QUOTE');
    } else if (char === ',' && !quoted) { fields.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[i + 1] === '\n') i++;
      fields.push(field); field = '';
      if (fields.some((part) => part !== '')) rows.push(fields);
      fields = [];
    } else field += char;
  }
  if (quoted) throw new Error('UNCLOSED_CSV_QUOTE');
  if (field || fields.length) { fields.push(field); rows.push(fields); }
  return rows;
}

export function parseNflverseStats(csv: string): StatRow[] {
  const [columns, ...rows] = csvRows(csv.replace(/^\uFEFF/, ''));
  if (!columns) throw new Error('EMPTY_STATS_CSV');
  const required = ['game_id', 'player_id', 'team', 'attempts', 'passing_yards'] as const;
  const indexes = required.map((key) => columns.indexOf(key));
  if (indexes.some((index) => index < 0)) throw new Error('STATS_COLUMNS_MISSING');
  return rows.map((fields) => {
    if (fields.length !== columns.length) throw new Error('STATS_ROW_INVALID');
    return Object.fromEntries(columns.map((key,index)=>[key,fields[index]])) as StatRow;
  });
}

export function parseNflverseSchedule(csv:string):ScheduleRow[]{
  const [columns,...rows]=csvRows(csv.replace(/^\uFEFF/,''));
  if(!columns)throw new Error('EMPTY_SCHEDULE_CSV');
  const required=['game_id','season','gameday','gametime','away_team','away_score','home_team','home_score'] as const;
  if(required.some((key)=>!columns.includes(key)))throw new Error('SCHEDULE_COLUMNS_MISSING');
  return rows.map((fields)=>{
    if(fields.length!==columns.length)throw new Error('SCHEDULE_ROW_INVALID');
    return Object.fromEntries(columns.map((key,index)=>[key,fields[index]])) as ScheduleRow;
  });
}

export async function readNflverseMappings(path: string): Promise<Mapping[]> {
  if ((await stat(path)).size > 1_000_000) throw new Error('MAPPING_FILE_TOO_LARGE');
  const mappings = mappingSchema.parse(JSON.parse(await readFile(path, 'utf8'))).mappings;
  const identities = mappings.map((row) => JSON.stringify([row.eventId, row.playerId]));
  if (new Set(identities).size !== identities.length) throw new Error('DUPLICATE_PLAYER_EVENT_MAPPING');
  if (mappings.some((row) => !row.nflverseGameId.startsWith(`${row.season}_`))) {
    throw new Error('MAPPING_SEASON_MISMATCH');
  }
  if (mappings.some((row) => !row.nflverseGameId.split('_').slice(-2).includes(row.team))) {
    throw new Error('MAPPING_TEAM_NOT_IN_GAME');
  }
  return mappings;
}

const nflTeamCodes:Readonly<Record<string,string>>={
  'Arizona Cardinals':'ARI','Atlanta Falcons':'ATL','Baltimore Ravens':'BAL','Buffalo Bills':'BUF',
  'Carolina Panthers':'CAR','Chicago Bears':'CHI','Cincinnati Bengals':'CIN','Cleveland Browns':'CLE',
  'Dallas Cowboys':'DAL','Denver Broncos':'DEN','Detroit Lions':'DET','Green Bay Packers':'GB',
  'Houston Texans':'HOU','Indianapolis Colts':'IND','Jacksonville Jaguars':'JAX','Kansas City Chiefs':'KC',
  'Las Vegas Raiders':'LV','Los Angeles Chargers':'LAC','Los Angeles Rams':'LA','Miami Dolphins':'MIA',
  'Minnesota Vikings':'MIN','New England Patriots':'NE','New Orleans Saints':'NO','New York Giants':'NYG',
  'New York Jets':'NYJ','Philadelphia Eagles':'PHI','Pittsburgh Steelers':'PIT','San Francisco 49ers':'SF',
  'Seattle Seahawks':'SEA','Tampa Bay Buccaneers':'TB','Tennessee Titans':'TEN',
  'Washington Commanders':'WAS',
};
const normalizePlayerName=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()
  .replace(/\s+(jr|sr|ii|iii|iv)$/,'');
const statPlayerName=(row:StatRow)=>['player_display_name','player_name','player_name_short']
  .map((key)=>row[key]).find((value)=>value?.trim())??'';

function eventTeamCodes(eventName:string):{away:string;home:string}|null{
  const [awayName,homeName,...extra]=eventName.split(' @ ').map((value)=>value.trim());
  if(!awayName||!homeName||extra.length)return null;
  const away=nflTeamCodes[awayName],home=nflTeamCodes[homeName];
  return away&&home?{away,home}:null;
}
function easternKickoff(iso:string):{date:string;time:string}|null{
  const date=new Date(iso);if(!Number.isFinite(date.getTime()))return null;
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',
    month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .formatToParts(date);
  const get=(type:string)=>parts.find((part)=>part.type===type)?.value;
  const year=get('year'),month=get('month'),day=get('day'),hour=get('hour'),minute=get('minute');
  return year&&month&&day&&hour&&minute?{date:`${year}-${month}-${day}`,time:`${hour}:${minute}`}:null;
}
const finalScore=(value:string)=>/^\d+$/.test(value.trim());

export function autoResolveNflverseMapping(line:SavedSelection['line'],schedules:readonly ScheduleRow[],
  rows:readonly StatRow[],now:Date):Mapping|null{
  if(line.sport!=='NFL'||!nflverseTrackedMarkets.includes(line.market))return null;
  const start=Date.parse(line.eventStartTime);
  if(!Number.isFinite(start)||now.getTime()<start+6*60*60_000)return null;
  const teams=eventTeamCodes(line.eventName),kickoff=easternKickoff(line.eventStartTime);
  if(!teams||!kickoff)return null;
  const games=schedules.filter((game)=>game.gameday===kickoff.date&&game.gametime===kickoff.time&&
    game.away_team===teams.away&&game.home_team===teams.home&&
    finalScore(game.away_score)&&finalScore(game.home_score));
  if(games.length!==1)return null;
  const game=games[0],wanted=normalizePlayerName(line.playerName);
  const players=rows.filter((row)=>row.game_id===game.game_id&&
    normalizePlayerName(statPlayerName(row))===wanted&&
    (row.team===teams.away||row.team===teams.home));
  if(players.length!==1||!players[0].player_id?.trim())return null;
  const season=Number(game.season);
  if(!Number.isInteger(season)||season<1999||season>2100)return null;
  return {eventId:line.eventId,playerId:line.playerId,nflverseGameId:game.game_id,
    nflversePlayerId:players[0].player_id,team:players[0].team,season,completedAt:now.toISOString()};
}

const trackedMarketColumns:Readonly<Record<string,string>>={
  passing_yards:'passing_yards',
  player_pass_attempts:'attempts',
  player_pass_completions:'completions',
  player_rush_yds:'rushing_yards',
  player_rush_attempts:'carries',
  player_reception_yds:'receiving_yards',
  player_receptions:'receptions',
  player_receiving_targets:'targets',
};
export const nflverseTrackedMarkets=Object.freeze(Object.keys(trackedMarketColumns));

export function trackedResultFromNflverse(line:SavedSelection['line'],mapping:Mapping,
  rows:readonly StatRow[],now:Date):{
    eventId:string;playerId:string;market:string;status:'FINAL';observedValue:number;
    completedAt:string;retrievedAt:string;sourceName:string;sourceUrl:string;
  }|null{
  const column=trackedMarketColumns[line.market];
  if(line.eventId!==mapping.eventId||line.playerId!==mapping.playerId||line.sport!=='NFL'||!column)
    throw new Error('MAPPING_IDENTITY_MISMATCH');
  if(Date.parse(mapping.completedAt)<=Date.parse(line.eventStartTime))
    throw new Error('MAPPING_COMPLETION_INVALID');
  if(Date.parse(mapping.completedAt)>now.getTime())return null;
  const found=rows.filter((row)=>row.game_id===mapping.nflverseGameId&&
    row.player_id===mapping.nflversePlayerId&&row.team===mapping.team);
  if(found.length>1)throw new Error('AMBIGUOUS_NFLVERSE_RESULT');
  if(!found.length)return null;
  const raw=found[0][column];
  if(raw===undefined||raw.trim()===''||!/^\d+(?:\.\d+)?$/.test(raw))return null;
  const observedValue=Number(raw);
  if(!Number.isFinite(observedValue)||observedValue<0)return null;
  return {eventId:line.eventId,playerId:line.playerId,market:line.market,status:'FINAL',
    observedValue,completedAt:mapping.completedAt,retrievedAt:now.toISOString(),
    sourceName:'nflverse weekly player stats',sourceUrl:nflverseStatsUrl(mapping.season)};
}

export function resultFromNflverse(selection: SavedSelection, mapping: Mapping,
  rows: readonly StatRow[], now: Date): NflPassingResult | null {
  const line = selection.line;
  if (line.eventId !== mapping.eventId || line.playerId !== mapping.playerId ||
    line.sport !== 'NFL' || !['passing_yards', 'player_pass_attempts'].includes(line.market)) {
    throw new Error('MAPPING_IDENTITY_MISMATCH');
  }
  if (Date.parse(mapping.completedAt) <= Date.parse(line.eventStartTime)) {
    throw new Error('MAPPING_COMPLETION_INVALID');
  }
  if (Date.parse(mapping.completedAt) > now.getTime()) return null;
  const found = rows.filter((row) => row.game_id === mapping.nflverseGameId &&
    row.player_id === mapping.nflversePlayerId && row.team === mapping.team);
  if (found.length > 1) throw new Error('AMBIGUOUS_NFLVERSE_RESULT');
  if (!found.length) return null; // Missing row is never guessed to be DNP or zero.
  const raw = line.market === 'passing_yards' ? found[0].passing_yards : found[0].attempts;
  if (!/^\d+$/.test(raw)) return null;
  return { eventId: line.eventId, playerId: line.playerId,
    market: line.market === 'passing_yards' ? 'passing_yards' : 'player_pass_attempts',
    status: 'FINAL', observedValue: Number(raw), completedAt: mapping.completedAt,
    retrievedAt: now.toISOString(), sourceName: 'nflverse weekly player stats',
    sourceUrl: nflverseStatsUrl(mapping.season) };
}

export class NflverseResultsFeed {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async fetchSeason(season: number): Promise<StatRow[]> {
    const response = await this.fetchFn(nflverseStatsUrl(season), {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: 'text/csv' },
    });
    if (!response.ok) throw new Error('NFLVERSE_STATS_UNAVAILABLE');
    if (Number(response.headers.get('content-length') ?? 0) > 50_000_000) {
      throw new Error('NFLVERSE_STATS_TOO_LARGE');
    }
    const csv = await response.text();
    if (csv.length > 50_000_000) throw new Error('NFLVERSE_STATS_TOO_LARGE');
    return parseNflverseStats(csv);
  }

  async fetchSchedule():Promise<ScheduleRow[]>{
    const response=await this.fetchFn(nflverseScheduleUrl,{
      signal:AbortSignal.timeout(20_000),headers:{accept:'text/csv'},
    });
    if(!response.ok)throw new Error('NFLVERSE_SCHEDULE_UNAVAILABLE');
    if(Number(response.headers.get('content-length')??0)>10_000_000)
      throw new Error('NFLVERSE_SCHEDULE_TOO_LARGE');
    const csv=await response.text();
    if(csv.length>10_000_000)throw new Error('NFLVERSE_SCHEDULE_TOO_LARGE');
    return parseNflverseSchedule(csv);
  }
}
