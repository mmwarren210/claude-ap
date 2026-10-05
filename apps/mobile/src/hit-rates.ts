// CrownIQ's own track record, by source ("history", "trend", "scout", "gkr", "books"), sport and stat. Pure.

export type HitRates = Record<string, { graded: number; wins: number; hitRate: number }>;
const names: Readonly<Record<string, string>> = { history: 'History', trend: 'Trends', scout: 'Scout', gkr: 'GKR', books: 'Books' };
/** Graded picks needed before a record shows. */
export const RECORD_MIN = 10;

/** The most specific record with enough graded picks: this sport and stat, else this sport. */
export function recordText(rates: HitRates, source: string, sport: string, market: string): string | null {
  const stat = market.replace(/^(player|batter|pitcher)_/, '').replace(/_/g, ' ');
  for (const [key, scope] of [[`${source}|${sport}|${market}`, `${sport} ${stat}`], [`${source}|${sport}`, sport]] as const) {
    const row = rates[key];
    if (row && row.graded >= RECORD_MIN)
      return `${names[source] ?? source} in ${scope}: ${Math.round(row.hitRate * 100)}% of ${row.graded} graded`;
  }
  return null;
}
