// "Every app" on Top Picks (owner, 2026-10-05): the best picks from every board in one ranking. Pure, so tests load it.
// Order: GKR first (by score), then Scout's plays, then History plays, then price edges (+EV, Value, market edges).

export type PickSource = 'prizepicks' | 'underdog' | 'pick6' | 'dabble' | 'draftkings' | 'hardrock' | 'pinnacle' | 'kalshi';
export type PickBy = 'GKR' | 'SCOUT' | 'HISTORY' | 'VALUE' | 'EDGE';
export interface AnyPick {
  readonly key: string; readonly source: PickSource; readonly by: PickBy;
  /** The sport (the sport picker); PrizePicks picks take it from the board line. */
  readonly sport?: string;
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
  /** The app line's own player image (Underdog, Pick6), when it has one. */
  readonly photoUrl?: string | null;
  /** For other apps' and books' picks: the PrizePicks player id, to find the player's panel and photo. */
  readonly playerId?: string | null;
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
  pick6: 'Pick6', dabble: 'Dabble', draftkings: 'DraftKings', hardrock: 'Hard Rock', pinnacle: 'Pinnacle', kalshi: 'Kalshi' };
export const byLabels: Readonly<Record<PickBy, string>> = { GKR: 'GKR', SCOUT: 'Scout', HISTORY: 'History', VALUE: 'Value',
  EDGE: 'Edge' };

type PanelLine = { readonly id: string; readonly market: string; readonly playerId: string; readonly playerName: string; readonly eventStartTime: string };
const plainName = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Points another app's or a book's pick at the player's panel: a PrizePicks line for the same player (by id, which
 * Underdog and Pick6 share, else by name for the books), the same stat first. Picks with no such line stay as they are.
 */
export function linkPanels(picks: readonly AnyPick[], lines: readonly PanelLine[], nowMs: number): AnyPick[] {
  const byId = new Map<string, PanelLine[]>(), byName = new Map<string, string>();
  for (const line of lines) {
    if (Date.parse(line.eventStartTime) <= nowMs) continue;
    byId.set(line.playerId, [...byId.get(line.playerId) ?? [], line]);
    if (!byName.has(plainName(line.playerName))) byName.set(plainName(line.playerName), line.playerId);
  }
  return picks.map((pick) => {
    const playerId = pick.playerId && byId.has(pick.playerId) ? pick.playerId : byName.get(plainName(pick.title)) ?? null;
    if (!playerId || pick.lineId) return playerId ? { ...pick, playerId } : pick;
    const options = byId.get(playerId) ?? [], stat = pick.key.split('|')[1];
    return { ...pick, playerId, lineId: (options.find((line) => line.market === stat) ?? options[0])?.id ?? null };
  });
}
