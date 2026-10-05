import { breakEven, DEFAULT_PAYOUTS } from '@crowniq/contracts';
import type { AppPayouts, EntryMode, PlayerGameLog } from '@crowniq/contracts';

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
 * The table an entry of this size uses: Flex where the app offers it for that many legs, else Power (all must hit).
 * The apps change payouts and pay less on Goblins, Demons and some lines, so every unit figure is an estimate.
 */
export function entryTable(payouts: AppPayouts, legs: number, mode: EntryMode = 'FLEX'): { mode: EntryMode;
  table: Readonly<Record<string, number>> } | null {
  const table = payouts[mode][legs];
  if (table) return { mode, table };
  const other: EntryMode = mode === 'FLEX' ? 'POWER' : 'FLEX';
  return payouts[other][legs] ? { mode: other, table: payouts[other][legs]! } : null;
}

export type CrownStatus = 'CASHED' | 'SPLIT' | 'MISSED' | 'PENDING';
type LegGrade = 'WIN' | 'LOSS' | 'PUSH' | 'PENDING' | 'DNP' | 'VOID' | string;

/** Status and estimated units (1-unit stake, Flex where offered) for a Crown from its leg grades and its app's payouts. */
export function crownOutcome(grades: readonly LegGrade[], payouts: AppPayouts = DEFAULT_PAYOUTS.prizepicks): {
  status: CrownStatus; units: number | null; multiplier: number | null } {
  if (grades.some((grade) => grade === 'PENDING')) return { status: 'PENDING', units: null, multiplier: null };
  // Pushes and voids drop out of the entry, as the apps reduce the pick count.
  const live = grades.filter((grade) => grade === 'WIN' || grade === 'LOSS');
  const wins = live.filter((grade) => grade === 'WIN').length;
  // Flex where the app offers it, except 2 picks: those are graded as Power (PrizePicks' 2-pick Flex is new; 2-pick
  // entries have always been graded as Power here).
  const multiplier = entryTable(payouts, live.length, live.length === 2 ? 'POWER' : 'FLEX')?.table[wins] ?? 0;
  const status: CrownStatus = live.length > 0 && wins === live.length ? 'CASHED' : multiplier > 0 ? 'SPLIT' : 'MISSED';
  return { status, units: Math.round((multiplier - 1) * 100) / 100, multiplier };
}

/** What an entry of this size pays when every leg hits, and the per-pick hit rate it needs to break even. */
export function entryOutlook(payouts: AppPayouts, legs: number, mode: EntryMode): { fullHit: number; breakEven: number } | null {
  const table = payouts[mode][legs];
  const value = breakEven(table, legs);
  return table && value !== null ? { fullHit: table[legs] ?? 0, breakEven: value } : null;
}

/**
 * How Goblins and Demons change a PrizePicks entry's payout: each one carries its own multiplier on the standard payout.
 * A Goblin without a known multiplier counts at the typical cut seen on real PrizePicks entries (six Goblins took a
 * 6-pick Power from 37.5x to 5.75x, about 0.73 a leg) and is marked as estimated; a Demon without one is left out
 * (Demons pay more, by an amount only PrizePicks shows).
 */
export const TYPICAL_GOBLIN_MULTIPLIER = 0.73;
export function slipAdjustment(legs: readonly { lineType: string; payoutMultiplier?: number }[]) {
  let factor = 1, estimated = 0, unknownDemons = 0, special = 0;
  for (const leg of legs) {
    if (leg.lineType !== 'GOBLIN' && leg.lineType !== 'DEMON') continue;
    special++;
    if (leg.payoutMultiplier) factor *= leg.payoutMultiplier;
    else if (leg.lineType === 'GOBLIN') { factor *= TYPICAL_GOBLIN_MULTIPLIER; estimated++; }
    else unknownDemons++;
  }
  return { factor, estimated, unknownDemons, special };
}
/** The entry's payout and break-even with every tier scaled by the slip's Goblin/Demon factor. */
export function adjustedOutlook(payouts: AppPayouts, legs: number, mode: EntryMode, factor: number) {
  const table = payouts[mode][legs];
  if (!table) return null;
  const scaled = Object.fromEntries(Object.entries(table).map(([hits, pays]) => [hits, pays * factor]));
  const value = breakEven(scaled, legs);
  return value === null ? null : { fullHit: Math.round((table[legs] ?? 0) * factor * 100) / 100, breakEven: value };
}

/** "6-pick Flex" */
export const entryName = (legs: number, mode: EntryMode) => `${legs}-pick ${mode === 'FLEX' ? 'Flex' : 'Power'}`;
export const percent1 = (value: number) => `${(value * 100).toFixed(1)}%`;

/** Same minimum leg scores the server's Crown audit applies (packages/engine/src/crowns.ts). */
export const crownMinimumLineScore: Readonly<Record<number, number>> = { 2: 80, 3: 80, 4: 80, 5: 80, 6: 80 };

/** Plain reasons for the server's Crown rule codes. */
const crownIssueTexts: Readonly<Record<string, string>> = {
  TEAM_IDENTITY_UNAVAILABLE: 'a leg’s team is not confirmed yet (try again after the next reanalysis)',
  CORRELATION_AUDIT_UNAVAILABLE: 'Crown saving is turned off on this server',
  SAME_EVENT_CONCENTRATION: 'more than two legs come from one game',
  QB_RECEIVER_STACK: 'a quarterback and his own receiver are picked in the same direction',
  SAME_TEAM_CONCENTRATION: 'three legs come from one team',
  BELOW_CROWN_MINIMUM: 'a leg is below the minimum score for this Crown size',
  DUPLICATE_PLAYER: 'the same player appears twice',
  STALE_OR_UNAVAILABLE_LINE: 'a game has already started',
  STALE_MODEL_EVIDENCE: 'a leg’s evidence expired and needs reanalysis',
  MISSING_MODEL_EVIDENCE: 'a leg has no attributed evidence',
  INELIGIBLE_PICK: 'a leg is not playable',
  INVALID_OR_STALE_CROWN: 'a leg is no longer on the board or its evidence expired',
  STALE_OR_INVALID_CROWN_LEG: 'a leg is no longer on the board or its evidence expired',
  DUPLICATE_PUBLIC_CROWN: 'you already shared this exact Crown',
  APEX_SAME_TEAM: 'two Apex players come from one team',
  SNAPSHOT_TOO_OLD: 'the board’s lines are older than this server allows for public Crowns (wait for the next board pull)',
};

export function crownIssueMessage(issues: readonly string[] | undefined): string {
  const reasons = [...new Set((issues ?? []).map((code) => crownIssueTexts[code]).filter(Boolean))];
  return reasons.length ? `This Crown was not saved: ${reasons.join('; ')}.`
    : 'This Crown did not pass validation. Check that every leg is still on the board.';
}
