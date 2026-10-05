// Underdog and Pick6 lines as /v1/apps/:app/board serves them, and which side each card backs. Pure, so tests load it.

export type Side = 'MORE' | 'LESS';
/** One Underdog or Pick6 line, as /v1/apps/:app/board serves it. */
export type AppLine = { id: string; sport: string; league: string; eventId: string; eventName: string; eventStartTime: string;
  playerId: string; playerName: string; team: string | null; opponent: string | null; stat: string; market?: string;
  threshold: number; lineType: string; availableDirections: Side[]; multipliers: Partial<Record<Side, number>> | null;
  playerImageUrl: string | null;
  prizePicks: { threshold: number; lineType: string; gkr: { direction: Side; score: number } | null } | null;
  /** GKR on this app line itself (its number and sides), or null when GKR passes or can't read it. */
  gkr?: { direction: Side; score: number } | null;
  /** Scout's read on this line (players PrizePicks doesn't list, where GKR has no research), or null. */
  scout?: { pick: Side | 'PASS'; score: number | null; agreement: string } | null;
  /** The free History Read (recent results against this line), on lines GKR doesn't score. */
  history?: { direction: Side | 'PASS'; score: number | null; text: string; source: string; lean?: boolean; trend?: boolean } | null;
  /** Pick6 promos: a gimme pick, or the number before a promo moved it. */
  promo?: { gimme: boolean; originalLine: number | null } | null };

/** Scout's side on a line GKR can't read (55 and up is a play). */
export const scoutSide = (line: AppLine): Side | null => !line.gkr && line.scout && line.scout.pick !== 'PASS' &&
  (line.scout.score ?? 0) >= 55 ? line.scout.pick : null;
/** The History Read's side where GKR and Scout have none. */
export const historySide = (line: AppLine): Side | null => !line.gkr && !scoutSide(line) && line.history &&
  line.history.direction !== 'PASS' && line.history.score !== null ? line.history.direction : null;
/** The side the card backs: GKR's, then Scout's, then the History Read's. */
export const backedSide = (line: AppLine): Side | null => line.gkr?.direction ?? scoutSide(line) ?? historySide(line);

export type Backing = { side: Side; score: number; by: 'GKR' | 'SCOUT' | 'HISTORY'; tier: number };
/**
 * What a generated slip may use on an app line: GKR at 80 and up, then Scout's plays, then History plays (never a
 * History lean). Tier orders them (GKR first); score orders within a tier.
 */
export function backing(line: AppLine): Backing | null {
  if (line.gkr && line.gkr.score >= 80) return { side: line.gkr.direction, score: line.gkr.score, by: 'GKR', tier: 3 };
  const scout = scoutSide(line);
  if (scout) return { side: scout, score: line.scout!.score ?? 0, by: 'SCOUT', tier: 2 };
  const history = historySide(line);
  // A Trend (CrownIQ's own graded lines) is shown, never auto-picked.
  if (history && !line.history!.lean && !line.history!.trend) return { side: history, score: line.history!.score!, by: 'HISTORY', tier: 1 };
  return null;
}

/** Underdog says Higher and Lower; the others say More and Less. */
export const sideLabel = (app: string, side: Side) => app === 'underdog' ? side === 'MORE' ? 'Higher' : 'Lower'
  : side === 'MORE' ? 'More' : 'Less';
