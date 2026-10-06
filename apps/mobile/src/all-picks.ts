// "Every app" on Top Picks (owner, 2026-10-05): the best picks from every board in one ranking. Pure, so tests load it.
// Order: GKR first (by score), then Scout's plays, then History plays, then price edges (+EV, Value, market edges).

export type PickSource = 'prizepicks' | 'underdog' | 'pick6' | 'draftkings' | 'hardrock';
export type PickBy = 'GKR' | 'SCOUT' | 'HISTORY' | 'VALUE' | 'EDGE';
export interface AnyPick {
  readonly key: string; readonly source: PickSource; readonly by: PickBy;
  /** The player, or the game for a market pick. */
  readonly title: string;
  /** The stat, side and number (or the market side) in plain words. */
  readonly detail: string;
  /** GKR's score, Scout's score, History's chance, or for edges the fair chance (0-100). */
  readonly strength: number;
  /** For edges: how far the fair chance beats the price or break-even (0-1). */
  readonly edge: number | null;
  readonly startTime: string;
  /** A PrizePicks board line id, when the pick opens the player screen. */
  readonly lineId: string | null;
  readonly note: string | null;
}

const tier: Readonly<Record<PickBy, number>> = { GKR: 4, SCOUT: 3, HISTORY: 2, VALUE: 1, EDGE: 1 };

/** Ranks picks across boards: GKR, Scout, History, then edges (bigger edge first); one per player and stat per source. */
export function rankAll(picks: readonly AnyPick[], nowMs: number): AnyPick[] {
  const seen = new Set<string>();
  return [...picks].filter((pick) => Date.parse(pick.startTime) > nowMs)
    .sort((a, b) => tier[b.by] - tier[a.by] || (a.edge !== null && b.edge !== null ? b.edge - a.edge : b.strength - a.strength))
    .filter((pick) => { const key = `${pick.source}|${pick.key}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

export const sourceLabels: Readonly<Record<PickSource, string>> = { prizepicks: 'PrizePicks', underdog: 'Underdog',
  pick6: 'DK Pick’em', draftkings: 'DraftKings', hardrock: 'Hard Rock' };
export const byLabels: Readonly<Record<PickBy, string>> = { GKR: 'GKR', SCOUT: 'Scout', HISTORY: 'History', VALUE: 'Value',
  EDGE: 'Edge' };
