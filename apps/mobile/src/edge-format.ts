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

/** American odds for decimal odds ("+150", "−120"). */
export const americanOdds = (decimal: number) => decimal >= 2 ? `+${Math.round((decimal - 1) * 100)}` : `−${Math.round(100 / (decimal - 1))}`;

export function edgeSummary(pick: EdgePick): string {
  if (pick.decimalOdds && pick.ev !== undefined) return `${pct(pick.probability)} to hit at ${americanOdds(pick.decimalOdds)} · EV ${
    pick.ev >= 0 ? '+' : '−'}${Math.abs(pick.ev * 100).toFixed(1)}% · bet ${pct(pick.kelly ?? 0)} of bankroll (¼ Kelly)`;
  if (pick.edge !== null) return `${pct(pick.probability)} to hit · ${signedPoints(pick.edge)} pts vs ${pct(pick.breakEven)} break-even` +
    (pick.payoutMultiplier && pick.payoutMultiplier !== 1 ? ` (pays ${pick.payoutMultiplier}×)` : '');
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

/** The local day window for a game day picked on the generator (YYYY-MM-DD, from `game-days`); null means any day. */
export function dayWindow(day: string | null): { from?: string; to?: string } {
  if (!day) return {};
  const [year, month, date] = day.split('-').map(Number);
  const start = new Date(year!, month! - 1, date!), end = new Date(year!, month! - 1, date! + 1);
  return { from: start.toISOString(), to: end.toISOString() };
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

/** STALE / STEAM badge text: "STALE · 14m", "STEAM". */
export function moveBadges(pick: EdgePick): string[] {
  return [...(pick.stale ? [`STALE · ${pick.stale.minutesAgo}m`] : []), ...(pick.steam ? ['STEAM'] : [])];
}

/** "Also: UD 24.5 · 61% · +6.1 pts", the same player and stat on the other platforms, best first. */
export function elsewhereText(pick: EdgePick): string | null {
  if (!pick.elsewhere?.length) return null;
  return 'Also: ' + pick.elsewhere.slice(0, 3).map((other) => `${shortNames[other.platform] ?? other.platform} ${formatLine(other.threshold)}` +
    (other.payoutMultiplier && !other.ev && other.payoutMultiplier !== 1 ? ` at ${other.payoutMultiplier}×` : '') +
    ` · ${pct(other.probability, 0)}` + (other.ev !== undefined ? ` · EV ${other.ev >= 0 ? '+' : '−'}${Math.abs(other.ev * 100).toFixed(1)}%`
      : other.edge !== null ? ` · ${signedPoints(other.edge)} pts` : '')).join('  |  ');
}

const shortNames: Readonly<Record<string, string>> = { prizepicks: 'PP', underdog: 'UD', pick6: 'P6', dabble: 'DB', draftkings: 'DK', hardrock: 'HR' };
/** "PP 24.5 · Edge line 26.5": the platform's number beside the number Edge would set. */
export function lineComparison(pick: EdgePick): string {
  return `${shortNames[pick.platform] ?? 'PP'} ${formatLine(pick.threshold)} · Edge line ${formatLine(pick.fairLine)}`;
}

/** Dollars, to the cent below $1,000 and whole dollars above ("$11.20", "$1,250"). */
export function usd(value: number): string {
  const amount = Math.abs(value);
  const text = amount >= 1000 ? Math.round(amount).toLocaleString('en-US') : amount.toFixed(2);
  return `${value < 0 ? '−' : ''}$${text}`;
}

/** An entry's expected result in dollars for a stake: what comes back on average, the profit, and each payout. */
export function slipDollars(slip: { expectedReturn: number; entry: { size: number; payouts: Record<string, number> } }, stake: number) {
  return { back: slip.expectedReturn * stake, profit: (slip.expectedReturn - 1) * stake,
    payouts: Object.entries(slip.entry.payouts).sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([hits, multiple]) => ({ hits: Number(hits), amount: multiple * stake })) };
}

/** A time's calendar date in Eastern time, the slate's "today" (matches the server's Today-only entries). */
export const easternDay = (time: Date | number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(time);

/** Picks still to start, and only today's (Eastern) when the Today-only switch is on. */
export function upcomingPicks<T extends { eventStartTime: string }>(picks: readonly T[], nowMs: number, day: 'all' | 'today'): T[] {
  const today = easternDay(nowMs);
  return picks.filter((pick) => Date.parse(pick.eventStartTime) > nowMs && (day === 'all' || easternDay(Date.parse(pick.eventStartTime)) === today));
}
