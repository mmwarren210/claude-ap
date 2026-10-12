import { normalizedName } from './context/match.js';
import type { PlayerProfile, PlayerStore, SeasonSummary } from './player-store.js';
import type { Game } from './propline-history.js';
import { seasonOf } from './player-store.js';

// Permanent player profiles (owner, 2026-10-12): the facts that rarely change, from ESPN's public team rosters (team,
// position, bats/throws, status, jersey), refreshed once a night and written only when something changed, plus a summary
// of the player's seasons from his PropLine games. Display only: no model scores a profile.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
/** The leagues whose rosters are read (college rosters are too many to read nightly). */
export const PROFILE_LEAGUES: Readonly<Record<string, string>> = { MLB: 'baseball/mlb', NFL: 'football/nfl', NBA: 'basketball/nba',
  WNBA: 'basketball/wnba', NHL: 'hockey/nhl' };

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : null;

/** The athletes on one ESPN roster response (grouped by position for some sports, flat for others). */
export function rosterAthletes(body: unknown): Json[] {
  const athletes = list(object(body)?.athletes);
  return athletes.flatMap((entry): Json[] => {
    const group = object(entry);
    if (!group) return [];
    return Array.isArray(group.items) ? group.items.flatMap((athlete): Json[] => { const item = object(athlete); return item ? [item] : []; }) : [group];
  });
}

/** One ESPN athlete as a profile (null without a name). */
export function profileOf(sport: string, team: string, athlete: Json, now: Date): PlayerProfile | null {
  const name = text(athlete.fullName) ?? text(athlete.displayName);
  if (!name) return null;
  return { sport, name, team, position: text(object(athlete.position)?.abbreviation), bats: text(object(athlete.bats)?.abbreviation),
    throws: text(object(athlete.throws)?.abbreviation), status: text(object(athlete.status)?.name), jersey: text(athlete.jersey),
    espnId: text(athlete.id), updatedAt: now.toISOString() };
}

export class PlayerProfiles {
  constructor(private readonly store: PlayerStore, private readonly fetcher: typeof fetch = fetch, private readonly clock: () => Date = () => new Date()) {}

  /** Reads every team's roster in the profile leagues; returns how many profiles changed. A team that fails is skipped. */
  async refresh(): Promise<{ teams: number; changed: number; failed: number }> {
    let teams = 0, changed = 0, failed = 0;
    for (const [sport, path] of Object.entries(PROFILE_LEAGUES)) {
      const root = await this.json(`${BASE}/${path}/teams?limit=1000`).catch(() => null);
      const entries = list(object(list(object(list(object(root)?.sports)[0])?.leagues)[0])?.teams);
      for (const entry of entries) {
        const team = object(object(entry)?.team), id = text(team?.id), name = text(team?.displayName);
        if (!id || !name) continue;
        const roster = await this.json(`${BASE}/${path}/teams/${id}/roster`).catch(() => null);
        if (!roster) { failed++; continue; }
        teams++;
        for (const athlete of rosterAthletes(roster)) {
          const profile = profileOf(sport, name, athlete, this.clock());
          if (profile && this.store.putProfile(normalizedName(profile.name), profile)) changed++;
        }
      }
    }
    return { teams, changed, failed };
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`ESPN ${response.status}`);
    return response.json();
  }

  profile(sport: string, name: string): PlayerProfile | null { return this.store.profile(sport, normalizedName(name)); }
}

/**
 * A player's season-by-season summary: the seasons still held as games (averaged here, with home and away) and the older
 * seasons the store folded into summaries.
 */
export function seasonSummaries(sportKey: string, games: readonly Game[], folded: readonly SeasonSummary[], team: string | null):
  { season: string; games: number; averages: Record<string, number>; home?: Record<string, number>; away?: Record<string, number> }[] {
  const bySeason = new Map<string, Game[]>();
  for (const game of games) { const season = seasonOf(sportKey, game.at); bySeason.set(season, [...bySeason.get(season) ?? [], game]); }
  const averageOf = (rows: readonly Game[]) => {
    const sums = new Map<string, { total: number; count: number }>();
    for (const game of rows) for (const [key, value] of Object.entries(game.stats)) {
      const item = sums.get(key) ?? { total: 0, count: 0 }; item.total += value; item.count++; sums.set(key, item);
    }
    return Object.fromEntries([...sums].map(([key, item]) => [key, Math.round(item.total / item.count * 100) / 100]));
  };
  const home = (game: Game) => !!team && !!game.home && normalizedName(game.home) === normalizedName(team);
  const away = (game: Game) => !!team && !!game.away && normalizedName(game.away) === normalizedName(team);
  const held = [...bySeason].map(([season, rows]) => {
    const homeRows = rows.filter(home), awayRows = rows.filter(away);
    return { season, games: rows.length, averages: averageOf(rows), ...(homeRows.length ? { home: averageOf(homeRows) } : {}),
      ...(awayRows.length ? { away: averageOf(awayRows) } : {}) };
  });
  const seen = new Set(held.map((item) => item.season));
  return [...held, ...folded.filter((item) => !seen.has(item.season)).map((item) => ({ season: item.season, games: item.games, averages: { ...item.averages } }))]
    .sort((a, b) => b.season.localeCompare(a.season));
}
