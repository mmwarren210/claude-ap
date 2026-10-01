import type { PlayerGameLog } from '@crowniq/contracts';

/** Plain names for provider market keys. Unknown keys are title-cased, never guessed. */
const marketNames: Readonly<Record<string, string>> = {
  player_points: 'Points', player_rebounds: 'Rebounds', player_assists: 'Assists',
  player_points_rebounds_assists: 'Pts + Reb + Ast', player_points_rebounds: 'Pts + Reb',
  player_points_assists: 'Pts + Ast', player_rebounds_assists: 'Reb + Ast', player_threes: '3-Pointers Made',
  player_blocks: 'Blocks', player_steals: 'Steals', player_turnovers: 'Turnovers',
  passing_yards: 'Passing Yards', player_pass_attempts: 'Pass Attempts', player_pass_completions: 'Completions',
  player_pass_tds: 'Passing TDs', player_rush_yds: 'Rushing Yards', player_rush_attempts: 'Rush Attempts',
  player_reception_yds: 'Receiving Yards', player_receptions: 'Receptions', player_receiving_targets: 'Targets',
  batter_hits_runs_rbis: 'Hits + Runs + RBIs', batter_hits: 'Hits', batter_walks: 'Walks',
  batter_home_runs: 'Home Runs', pitcher_strikeouts: 'Strikeouts', batter_total_bases: 'Total Bases',
  shots_on_goal: 'Shots on Goal', points: 'Points', saves: 'Saves', player_fantasy_points: 'Fantasy Score',
};
const marketShort: Readonly<Record<string, string>> = {
  player_points: 'PTS', player_rebounds: 'REB', player_assists: 'AST', player_threes: '3PM',
  player_points_rebounds_assists: 'PRA', passing_yards: 'PASS YDS', player_rush_yds: 'RUSH YDS',
  player_reception_yds: 'REC YDS', player_receptions: 'REC', batter_hits: 'H', pitcher_strikeouts: 'K',
};

export function marketLabel(market: string): string {
  return marketNames[market] ?? market.replace(/^(player|batter|pitcher)_/, '').split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
export function marketAbbrev(market: string): string {
  return marketShort[market] ?? marketLabel(market).toUpperCase();
}

/** 'Tue 10:00 PM' in the viewer's time zone, like the slate. */
export function gameTime(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString('en-US', { weekday: 'short' });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} ${time}`;
}

export function formatLine(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

export type Window = 'L5' | 'L10' | 'L15' | 'H2H' | 'AVG';
export type GameResult = { date: string; opponent: string | null; value: number; hit: boolean };
export type LineStats = { games: GameResult[]; hits: number; sample: number; rate: number | null;
  average: number | null; streak: number; diff: number | null; edge: number | null };

const hitFor = (value: number, threshold: number, direction: 'MORE' | 'LESS') =>
  direction === 'MORE' ? value > threshold : value < threshold;

/**
 * Hit rate, average, streak and edge of real logged games against one exact line.
 * The window picks the games: last 5, 10 or 15, head-to-head against the opponent, or AVG (last 10).
 */
export function lineStats(log: PlayerGameLog | null, threshold: number, direction: 'MORE' | 'LESS',
  window: Window = 'L10', opponent: string | null = null): LineStats {
  const all = (log?.games ?? []).map((game) => ({ ...game, hit: hitFor(game.value, threshold, direction) }));
  const games = window === 'H2H' ? (opponent ? all.filter((game) => game.opponent === opponent) : [])
    : all.slice(0, window === 'L5' ? 5 : window === 'L15' ? 15 : 10);
  const hits = games.filter((game) => game.hit).length;
  const average = games.length ? games.reduce((sum, game) => sum + game.value, 0) / games.length : null;
  let streak = 0;
  for (const game of all) { if (!game.hit) break; streak++; }
  const signed = average === null ? null : (direction === 'MORE' ? average - threshold : threshold - average);
  return { games, hits, sample: games.length, rate: games.length ? hits / games.length : null, average, streak,
    diff: signed === null ? null : Math.round(signed * 10) / 10,
    edge: signed === null || threshold === 0 ? null : signed / Math.abs(threshold) };
}

export function percent(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}
export function signed(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '—';
  const fixed = value.toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

/* ---------- Crown payouts ---------- */

/**
 * Estimated PrizePicks Flex payouts (multiplier by legs, then by hits). PrizePicks changes these and
 * adjusts them for Goblins and Demons, so every unit figure built on them is labelled an estimate.
 */
export const flexPayouts: Readonly<Record<number, Readonly<Record<number, number>>>> = {
  2: { 2: 3 }, 3: { 3: 3, 2: 1 }, 4: { 4: 6, 3: 1.5 }, 5: { 5: 10, 4: 2, 3: 0.4 }, 6: { 6: 25, 5: 2, 4: 0.4 },
};

export type CrownStatus = 'CASHED' | 'SPLIT' | 'MISSED' | 'PENDING';
type LegGrade = 'WIN' | 'LOSS' | 'PUSH' | 'PENDING' | 'DNP' | 'VOID' | string;

/** Status and estimated units (1-unit stake) for a Crown from its leg grades. */
export function crownOutcome(grades: readonly LegGrade[]): { status: CrownStatus; units: number | null;
  multiplier: number | null } {
  if (grades.some((grade) => grade === 'PENDING')) return { status: 'PENDING', units: null, multiplier: null };
  // Pushes and voids drop out of the entry, as PrizePicks reduces the pick count.
  const live = grades.filter((grade) => grade === 'WIN' || grade === 'LOSS');
  const wins = live.filter((grade) => grade === 'WIN').length;
  const table = flexPayouts[live.length];
  const multiplier = table?.[wins] ?? 0;
  const status: CrownStatus = live.length > 0 && wins === live.length ? 'CASHED' : multiplier > 0 ? 'SPLIT' : 'MISSED';
  return { status, units: Math.round((multiplier - 1) * 100) / 100, multiplier };
}

/** Full-hit multiplier a Crown of this size pays, for the projected outcome. */
export function fullHitMultiplier(legs: number): number | null {
  return flexPayouts[legs]?.[legs] ?? null;
}

/** Same minimum leg scores the server's Crown audit applies (packages/engine/src/crowns.ts). */
export const crownMinimumLineScore: Readonly<Record<number, number>> = { 2: 88, 3: 86, 4: 84, 5: 82, 6: 80 };
