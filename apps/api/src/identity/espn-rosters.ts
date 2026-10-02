import type { ResearchTarget } from '@crowniq/engine';
import { JsonCache, matchTeam, normalizeName } from './types.js';
import type { IdentityMatch, PlayerIdentitySource } from './types.js';

type JsonObject = Record<string, unknown>;
type Team = { id: string; displayName: string; nickname: string | null; location: string | null;
  abbreviation: string | null };
type Athlete = { id: string; name: string; photoUrl: string | null };

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const TEAMS_TTL = 12 * 3600_000, ROSTER_TTL = 30 * 60_000;

/** ESPN league path for each team sport the app carries. */
const SPORT_PATHS: Readonly<Record<string, string>> = {
  NFL: 'football/nfl', NCAAFB: 'football/college-football', MLB: 'baseball/mlb',
  NBA: 'basketball/nba', WNBA: 'basketball/wnba', NHL: 'hockey/nhl',
};
/** Soccer is one sport with many leagues, so the provider's sport key picks the league. */
const SOCCER_PATHS: Readonly<Record<string, string>> = {
  soccer_epl: 'eng.1', soccer_efl_champ: 'eng.2', soccer_spain_la_liga: 'esp.1',
  soccer_germany_bundesliga: 'ger.1', soccer_italy_serie_a: 'ita.1', soccer_france_ligue_one: 'fra.1',
  soccer_usa_mls: 'usa.1', soccer_mexico_ligamx: 'mex.1', soccer_netherlands_eredivisie: 'ned.1',
  soccer_portugal_primeira_liga: 'por.1', soccer_brazil_campeonato: 'bra.1',
  soccer_uefa_champs_league: 'uefa.champions', soccer_uefa_europa_league: 'uefa.europa',
  soccer_fifa_world_cup: 'fifa.world',
};
/** ESPN headshot folders, used when a roster entry has no headshot link. */
const HEADSHOT_FOLDERS: Readonly<Record<string, string>> = {
  'football/nfl': 'nfl', 'football/college-football': 'college-football', 'baseball/mlb': 'mlb',
  'basketball/nba': 'nba', 'basketball/wnba': 'wnba', 'hockey/nhl': 'nhl',
};

const object = (value: unknown): JsonObject | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown) => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

export function espnPath(target: Pick<ResearchTarget, 'sport' | 'sourceSportKey'>): string | null {
  if (target.sport === 'SOCCER') {
    const league = target.sourceSportKey ? SOCCER_PATHS[target.sourceSportKey] : undefined;
    return league ? `soccer/${league}` : null;
  }
  return SPORT_PATHS[target.sport] ?? null;
}

/**
 * Team and headshot from ESPN's public team rosters, for every team sport ESPN covers.
 * Only the rosters of the two teams in the game are read.
 */
export class EspnRosterIdentitySource implements PlayerIdentitySource {
  readonly id = 'espn-rosters';
  constructor(private readonly cache: JsonCache) {}

  supports(target: ResearchTarget): boolean {
    return !!espnPath(target) && !!target.homeTeam && !!target.awayTeam;
  }

  private async teams(path: string): Promise<Team[]> {
    const root = object(await this.cache.get(`${BASE}/${path}/teams?limit=1000`, TEAMS_TTL));
    const leagues = array(object(array(root?.sports)[0])?.leagues);
    return array(object(leagues[0])?.teams).flatMap((entry) => {
      const team = object(object(entry)?.team);
      const id = text(team?.id), displayName = text(team?.displayName);
      return id && displayName ? [{ id, displayName, nickname: text(team?.name) || null,
        location: text(team?.location) || null, abbreviation: text(team?.abbreviation) || null }] : [];
    });
  }

  private async roster(path: string, team: Team): Promise<{ url: string; athletes: Athlete[] }> {
    const url = `${BASE}/${path}/teams/${encodeURIComponent(team.id)}/roster`;
    const root = object(await this.cache.get(url, ROSTER_TTL));
    // Basketball and hockey rosters are flat lists; football and baseball group them ({items:[...]}).
    const entries = array(root?.athletes).flatMap((entry) => {
      const items = object(entry)?.items; return Array.isArray(items) ? items : [entry];
    });
    const folder = HEADSHOT_FOLDERS[path] ?? (path.startsWith('soccer/') ? 'soccer' : undefined);
    const athletes = entries.flatMap((entry) => {
      const athlete = object(entry), id = text(athlete?.id);
      const name = text(athlete?.fullName) || text(athlete?.displayName);
      if (!id || !name) return [];
      const href = text(object(athlete?.headshot)?.href);
      const photoUrl = href.startsWith('https://') ? href
        : folder ? `https://a.espncdn.com/i/headshots/${folder}/players/full/${encodeURIComponent(id)}.png` : null;
      return [{ id, name, photoUrl }];
    });
    return { url, athletes };
  }

  async resolve(target: ResearchTarget): Promise<IdentityMatch | null> {
    const path = espnPath(target);
    if (!path || !target.homeTeam || !target.awayTeam) return null;
    const teams = await this.teams(path);
    const wanted = normalizeName(target.playerName);
    const found: { side: string; url: string; athlete: Athlete }[] = [];
    for (const side of [target.homeTeam, target.awayTeam]) {
      const team = matchTeam(side, teams);
      if (!team) continue;
      const roster = await this.roster(path, team);
      for (const athlete of roster.athletes)
        if (normalizeName(athlete.name) === wanted) found.push({ side, url: roster.url, athlete });
    }
    if (found.length !== 1) return null;
    const [match] = found;
    return { team: match.side, photoUrl: match.athlete.photoUrl, sourceName: 'ESPN public team rosters',
      sourceUrl: match.url, sourceType: 'PUBLIC', confidence: 0.8 };
  }
}
