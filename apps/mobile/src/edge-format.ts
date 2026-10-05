import type { EdgePick, EdgeRating, EdgeTier } from '@crowniq/contracts';

const labels: Record<string, string> = {
  passing_yards: 'Pass Yards', player_pass_attempts: 'Pass Attempts', player_pass_completions: 'Completions',
  player_pass_tds: 'Pass TDs', player_rush_yds: 'Rush Yards', player_rush_attempts: 'Rush Attempts',
  player_reception_yds: 'Receiving Yards', player_receptions: 'Receptions', player_receiving_targets: 'Targets',
  player_rush_reception_yds: 'Rush + Rec Yards', player_points_rebounds_assists: 'Pts + Rebs + Asts',
  player_points_rebounds: 'Pts + Rebs', player_points_assists: 'Pts + Asts', player_rebounds_assists: 'Rebs + Asts',
  player_threes: '3-Pointers Made', player_blocks_steals: 'Blks + Stls', batter_hits_runs_rbis: 'Hits + Runs + RBIs',
  batter_total_bases: 'Total Bases', pitcher_strikeouts: 'Pitcher Strikeouts', pitcher_outs: 'Pitching Outs',
  shots_on_goal: 'Shots on Goal', points: 'Points', player_tackles_assists: 'Tackles + Assists',
};

export function marketLabel(market: string): string {
  if (labels[market]) return labels[market];
  return market.replace(/^(player|batter|pitcher)_/, '').split('_')
    .map((word) => word.length <= 3 && /^(rbi|hr|tds?|pra)$/.test(word) ? word.toUpperCase()
      : word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export const pct = (value: number, digits = 1) => (value * 100).toFixed(digits) + '%';
export const signedPoints = (value: number) => (value >= 0 ? '+' : '−') + Math.abs(value * 100).toFixed(1);
export const formatLine = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);

export const ratingLabel: Record<EdgeRating, string> = {
  ELITE: 'ELITE EDGE', STRONG: 'STRONG EDGE', VALUE: 'VALUE', THIN: 'THIN EDGE', NONE: 'NO EDGE',
};
export const tierLabel: Record<EdgeTier, string> = {
  SHARP: 'SHARP BOOKS', MARKET: 'SPORTSBOOK', MODEL: 'STATS MODEL', LADDER: 'LADDER',
};
export function ratingColor(rating: EdgeRating, palette: { green: string; muted: string; danger: string; text: string }) {
  return rating === 'ELITE' || rating === 'STRONG' ? palette.green : rating === 'VALUE' ? palette.text
    : rating === 'THIN' ? palette.muted : palette.danger;
}

export function headline(pick: EdgePick): string {
  return `${pick.side} ${formatLine(pick.threshold)} ${marketLabel(pick.market)}`;
}

export function edgeSummary(pick: EdgePick): string {
  if (pick.edge !== null) return `${pct(pick.probability)} to hit · ${signedPoints(pick.edge)} pts vs ${pct(pick.breakEven)} break-even`;
  return `${pct(pick.probability)} to hit · needs payout factor ≥ ${pick.requiredPayoutFactor.toFixed(2)}×`;
}

export function sportsFrom(picks: readonly EdgePick[]): string[] {
  return [...new Set(picks.map((pick) => pick.sport))].sort();
}

/** Add or remove a slip leg. One leg per player: picking another line for the same
 * player replaces the earlier one. */
export function toggleSlipLeg(legs: readonly EdgePick[], pick: EdgePick, max = 6): EdgePick[] {
  if (legs.some((leg) => leg.lineId === pick.lineId)) return legs.filter((leg) => leg.lineId !== pick.lineId);
  const others = legs.filter((leg) => leg.playerId !== pick.playerId);
  return others.length >= max ? [...others] : [...others, pick];
}

export type DayChoice = 'today' | 'tomorrow' | 'all';

/** Local-time day window for the generator; `all` means no window. */
export function dayRange(choice: DayChoice, nowMs: number): { from?: string; to?: string } {
  if (choice === 'all') return {};
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  if (choice === 'tomorrow') start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** "PP 24.5 · Edge 26.5" — the PrizePicks number beside the number Edge would set. */
export function lineComparison(pick: EdgePick): string {
  return `PP ${formatLine(pick.threshold)} · Edge line ${formatLine(pick.fairLine)}`;
}
