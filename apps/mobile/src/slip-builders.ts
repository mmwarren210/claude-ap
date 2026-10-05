// Slip builders for the sportsbook and prediction-market tabs. Pure, so tests can load them.

export type BookSlipPick = { id: string; eventStartTime: string; playerName: string; market: string; line: number;
  side: 'MORE' | 'LESS'; gkr: { score: number } | null; score?: number; american: number | null; pricey: boolean };
export type MarketSlipPick = { id: string; game: string; startTime: string; edge: number; side: string; price: number };

/** Decimal odds for an American price. */
export const decimalOdds = (american: number) => american > 0 ? 1 + american / 100 : 1 + 100 / -american;

/**
 * A sportsbook slip: GKR's strongest picks, fairly priced ones before pricey ones, one per player, games not yet
 * started. `offset` rotates for "build another".
 */
export function buildBookSlip<T extends BookSlipPick>(picks: readonly T[], size: number, nowMs: number, offset = 0): T[] {
  const ordered = picks.filter((pick) => Date.parse(pick.eventStartTime) > nowMs + 10 * 60_000 && pick.american !== null)
    .sort((a, b) => Number(a.pricey) - Number(b.pricey) || Number(!!b.gkr) - Number(!!a.gkr) ||
      (b.gkr?.score ?? b.score ?? 0) - (a.gkr?.score ?? a.score ?? 0));
  const rotated = [...ordered.slice(offset), ...ordered.slice(0, offset)];
  const chosen: T[] = [], players = new Set<string>();
  for (const pick of rotated) {
    if (chosen.length >= size) break;
    if (players.has(pick.playerName)) continue;
    players.add(pick.playerName); chosen.push(pick);
  }
  return chosen;
}

/** The parlay price of a sportsbook slip, in American odds (null under two legs). */
export function parlayAmerican(picks: readonly { american: number | null }[]): number | null {
  if (picks.length < 2 || picks.some((pick) => pick.american === null)) return null;
  const decimal = picks.reduce((product, pick) => product * decimalOdds(pick.american!), 1);
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

/** A prediction-market slip: the biggest edges, one per game. */
export function buildMarketSlip<T extends MarketSlipPick>(picks: readonly T[], size: number, nowMs: number): T[] {
  const chosen: T[] = [], games = new Set<string>();
  for (const pick of [...picks].sort((a, b) => b.edge - a.edge)) {
    if (chosen.length >= size) break;
    if (Date.parse(pick.startTime) <= nowMs || games.has(pick.game)) continue;
    games.add(pick.game); chosen.push(pick);
  }
  return chosen;
}
