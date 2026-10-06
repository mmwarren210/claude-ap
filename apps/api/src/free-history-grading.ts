// Grading tennis and esports from the free public history sources CrownIQ already reads (ESPN tennis results, OpenDota,
// Leaguepedia, Sleeper), for Edge's ledger and for saved picks and Crowns alike. Box scores don't cover these sports.

/** The free history sources' answer for one player and stat (PlayerHistory.values). */
export type FreeHistoryValues = (sport: string, playerName: string, market: string) =>
  Promise<{ values: readonly { date: string; value: number }[]; perMap: boolean; source: string; url?: string } | null>;

/** Sports graded from free public history. */
export const freeGradedSports = new Set(['TENNIS', 'LOL', 'DOTA', 'CS2', 'VALORANT']);

/** How many maps an esports market covers: "maps 1–3" is 3, "maps 1+2" is 2, anything else 1. */
export const mapsCovered = (market: string) => /1_3|1_plus_2_plus_3|maps_1_3/.test(market) ? 3
  : /1_2|1_plus_2|maps_1|games_1/.test(market) ? 2 : 1;

/**
 * A pick's result from free public history: the player's row(s) dated within the game's window (12h before the start to 36h
 * after). A whole-match stat needs exactly one match there. Esports rows are single maps: a "maps 1+2" line sums the first two
 * maps of that day's series (three for "maps 1–3"), and only when the series had at least that many maps and exactly one
 * series that day. Anything ambiguous stays pending rather than being guessed.
 */
export function freeHistoryActual(pick: { eventStartTime: string; market: string },
  found: { values: readonly { date: string; value: number }[]; perMap: boolean }): number | null {
  const start = Date.parse(pick.eventStartTime);
  const inWindow = found.values.filter((row) => { const at = Date.parse(row.date); return at >= start - 12 * 3600_000 && at <= start + 36 * 3600_000; })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!inWindow.length) return null;
  if (!found.perMap) return inWindow.length === 1 ? inWindow[0]!.value : null;
  const maps = mapsCovered(pick.market);
  // One series that day: its maps all fall within six hours of the first.
  if (Date.parse(inWindow[inWindow.length - 1]!.date) - Date.parse(inWindow[0]!.date) > 6 * 3600_000) return null;
  if (inWindow.length < maps || (maps === 1 && inWindow.length !== 1)) return null;
  return inWindow.slice(0, maps).reduce((sum, row) => sum + row.value, 0);
}

/**
 * Esports per-map rows as series totals for a multi-map market: maps within six hours of each other are one series, and a
 * series counts only when it had at least that many maps. Used so "maps 1+2 kills" has a history to project from.
 */
export function seriesTotals(rows: readonly { date: string; opponent: string | null; value: number }[], maps: number) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const series: { date: string; opponent: string | null; value: number }[][] = [];
  for (const row of sorted) {
    const current = series[series.length - 1];
    if (current && Date.parse(row.date) - Date.parse(current[0]!.date) <= 6 * 3600_000) current.push(row); else series.push([row]);
  }
  return series.filter((games) => games.length >= maps)
    .map((games) => ({ date: games[0]!.date, opponent: games[0]!.opponent, value: games.slice(0, maps).reduce((sum, game) => sum + game.value, 0) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}
