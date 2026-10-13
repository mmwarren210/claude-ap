import { teamsMatch } from './edge/market-map.js';
import { gameValue, proplineStat } from './propline-history.js';
import type { Game, PropLineHistory } from './propline-history.js';
import type { Tip, TipStatus } from './tips.js';

// Vetted and tips graded from box scores (owner, 2026-10-12: "Vetted needs to grade picks"): a player prop is graded from
// the player's PropLine game on the pick's date, the same box scores GKR's record uses. A prop the box score can't settle
// (no stat for it, or a moneyline/spread) is left for the web-search grader. A player with no game three days after the
// pick's date (a scratch, a postponement) is VOID.

const DAY = 86_400_000;

/** The market keys a tip's stat text could be ("Pitcher Strikeouts" → pitcher_strikeouts, strikeouts…). */
export function marketKeysFor(stat: string): string[] {
  const base = stat.toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const short = base.replace(/^(player|batter|pitcher|hitter)_/, '');
  return [...new Set([base, short, `player_${short}`, `batter_${short}`, `pitcher_${short}`])];
}

type Result = { id: string; status: Exclude<TipStatus, 'PENDING'>; result: string };

/** The game a tip was about: on its start (or date), else the player's first game within two days after it was posted. */
export function gameOf(tip: Pick<Tip, 'eventDate' | 'createdAt'> & { analysis?: { start?: string | null } | null; market_read?: { start?: string } | null },
  games: readonly Game[]): Game | null {
  const start = tip.market_read?.start ?? tip.analysis?.start ?? null;
  if (start && Number.isFinite(Date.parse(start))) {
    const at = Date.parse(start);
    return games.find((game) => Math.abs(Date.parse(game.at) - at) <= 12 * 3600_000) ?? null;
  }
  // A date is the local day: its games run from that morning (UTC) to early the next day (UTC).
  const from = tip.eventDate ? Date.parse(tip.eventDate) - 6 * 3600_000 : Date.parse(tip.createdAt) - 6 * 3600_000;
  const to = tip.eventDate ? Date.parse(tip.eventDate) + 36 * 3600_000 : Date.parse(tip.createdAt) + 2 * DAY;
  return [...games].sort((a, b) => a.at.localeCompare(b.at)).find((game) => { const time = Date.parse(game.at); return time >= from && time <= to; }) ?? null;
}

/**
 * Whether the box-score game is the tip's: its teams must include the tip's game (from the read's "Away @ Home") or its
 * opponent. With neither known, nothing is matched (CLAUDE.md shared-names rule: two Max Muncys), and the web grader decides.
 */
export function sameGameAsTip(tip: Pick<Tip, 'opponent'> & { analysis?: { event?: string | null } | null; market_read?: { event?: string } | null },
  game: Pick<Game, 'home' | 'away'>): boolean {
  const teams = [game.home, game.away].filter((team): team is string => !!team);
  if (teams.length < 2) return false;
  const event = tip.market_read?.event ?? tip.analysis?.event ?? null;
  const sides = event?.split(/\s+(?:@|at|vs\.?|v)\s+/i).map((side) => side.trim()).filter(Boolean) ?? [];
  if (sides.length === 2) return sides.every((side) => teams.some((team) => teamsMatch(side, team)));
  return !!tip.opponent && teams.some((team) => teamsMatch(tip.opponent!, team));
}

const HOUR = 3600_000;
/** When the tip's game should be over: 3h after a known start; else from its date or posting. Null with no clue at all. */
const overAt = (tip: Tip) => {
  const known = tip.market_read?.start ?? tip.analysis?.start ?? null;
  if (known && Number.isFinite(Date.parse(known))) return { at: Date.parse(known) + 3 * HOUR, known: true };
  return { at: (tip.eventDate ? Date.parse(tip.eventDate) + 20 * HOUR : Date.parse(tip.createdAt)) + 3 * HOUR, known: false };
};

export async function gradeFromBoxScores(tips: readonly Tip[], history: PropLineHistory, now: Date): Promise<Result[]> {
  const out: Result[] = [];
  // Four at a time (code check, 2026-10-13: one at a time, a run could take many minutes and hold up the next).
  const queue = [...tips];
  const one = async (tip: Tip) => {
    if (tip.market !== 'PLAYER_PROP' || tip.line === null || !tip.side || !tip.stat || !tip.sport) return;
    const due = overAt(tip);
    // A game known not to be over yet isn't asked about (code check, 2026-10-13: future picks were refetched every 2 hours).
    if (due.known && due.at > now.getTime()) return;
    const sport = tip.sport.toUpperCase();
    const read = marketKeysFor(tip.stat).map((key) => proplineStat(sport, key)).find((value) => value !== null) ?? null;
    if (!read) return;
    const player = { sport: sport as never, eventId: '', playerName: tip.selection, league: tip.league };
    const mine = (list: readonly Game[]) => { const game = gameOf(tip as never, list); return game && sameGameAsTip(tip, game) ? game : null; };
    let games = await history.gamesFor(player, 8000).catch(() => null);
    if (!games || games === 'PENDING') return;
    let game = mine(games);
    // A log cached before the game finished doesn't have it yet (owner, 2026-10-12: a Sunday night start sat ungraded on
    // Monday): ask again when the copy is over two hours old, once the game should be over.
    if (!game && due.at <= now.getTime()) {
      games = await history.gamesFor(player, 8000, now.getTime() - 2 * HOUR).catch(() => null);
      if (!games || games === 'PENDING') return;
      game = mine(games);
    }
    if (!game) {
      const date = Date.parse(tip.eventDate ?? tip.createdAt);
      // VOID only when the tip's teams are known (else a namesake's missing game proves nothing).
      const teamsKnown = !!(tip.market_read?.event ?? tip.analysis?.event ?? tip.opponent);
      if (teamsKnown && now.getTime() - date > 3 * DAY) out.push({ id: tip.id, status: 'VOID', result: `No ${tip.selection} game found on PropLine (did not play?)` });
      return;
    }
    const value = gameValue(game.stats, read);
    if (value === null) return;
    const over = value > tip.line, under = value < tip.line;
    const status: Result['status'] = !over && !under ? 'PUSH' : (tip.side === 'OVER') === over ? 'WON' : 'LOST';
    out.push({ id: tip.id, status, result: `${tip.selection} had ${value} ${tip.stat.toLowerCase()} (${game.away && game.home ? `${game.away} @ ${game.home}, ` : ''}${game.at.slice(0, 10)}) · PropLine box score` });
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let tip = queue.shift(); tip; tip = queue.shift()) await one(tip);
  }));
  return out;
}
