import type { InjuryNote } from './feeds.js';

// Injury reports from ESPN's free public feed (owner, 2026-10-09: replaces the Apify injury scraper, which hit its plan
// limit). One request per league, kept 30 minutes; a league that fails keeps its last report. Display and Edge's
// injury check only, never a GKR score. ESPN's college football list is stale, so it isn't read.

const LEAGUES: readonly [string, string][] = [['NFL', 'football/nfl'], ['NBA', 'basketball/nba'], ['WNBA', 'basketball/wnba'],
  ['NHL', 'hockey/nhl'], ['MLB', 'baseball/mlb']];
type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value && typeof value === 'object' ? value as Json : {};
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

/** One league's ESPN injuries body as injury notes (rows without a player, team or status are skipped). */
export function espnInjuryNotes(body: unknown, league: string): InjuryNote[] {
  const out: InjuryNote[] = [];
  for (const team of Array.isArray(obj(body).injuries) ? obj(body).injuries as unknown[] : []) {
    const teamName = text(obj(team).displayName);
    for (const item of Array.isArray(obj(team).injuries) ? obj(team).injuries as unknown[] : []) {
      const row = obj(item), athlete = obj(row.athlete), details = obj(row.details);
      const player = text(athlete.displayName), status = text(row.status);
      const playerTeam = obj(athlete.team), name = teamName ?? text(playerTeam.displayName);
      if (!player || !status || !name) continue;
      out.push({ league, team: name, teamAbbreviation: text(playerTeam.abbreviation), player,
        position: text(obj(athlete.position).abbreviation), status, injury: text(details.type),
        returnDate: text(details.returnDate), note: text(row.shortComment), reportedAt: text(row.date),
        sourceUrl: Array.isArray(athlete.links) ? text(obj(athlete.links[0]).href) : null });
    }
  }
  return out;
}

export function espnInjuries(fetchFn: typeof fetch = (...args) => fetch(...args), ttlMs = 30 * 60_000, clock: () => number = Date.now) {
  const byLeague = new Map<string, InjuryNote[]>();
  let at: number | null = null, loading: Promise<InjuryNote[]> | null = null, fetchedAt: string | null = null;
  const items = async (): Promise<InjuryNote[]> => {
    if (at !== null && clock() - at < ttlMs) return [...byLeague.values()].flat();
    loading ??= (async () => {
      await Promise.all(LEAGUES.map(async ([league, path]) => {
        try {
          const response = await fetchFn(`https://site.api.espn.com/apis/site/v2/sports/${path}/injuries`, { signal: AbortSignal.timeout(20_000) });
          if (!response.ok) return;
          byLeague.set(league, espnInjuryNotes(await response.json(), league));
        } catch { /* keep this league's last report */ }
      }));
      at = clock(); fetchedAt = new Date(at).toISOString();
      return [...byLeague.values()].flat();
    })().finally(() => { loading = null; });
    return loading;
  };
  return { items, fetchedAt: () => fetchedAt };
}
