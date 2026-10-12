import { normalizedName } from './context/match.js';
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

export async function gradeFromBoxScores(tips: readonly Tip[], history: PropLineHistory, now: Date): Promise<Result[]> {
  const out: Result[] = [];
  for (const tip of tips) {
    if (tip.market !== 'PLAYER_PROP' || tip.line === null || !tip.side || !tip.stat || !tip.sport) continue;
    const sport = tip.sport.toUpperCase();
    const read = marketKeysFor(tip.stat).map((key) => proplineStat(sport, key)).find((value) => value !== null) ?? null;
    if (!read) continue;
    const games = await history.gamesFor({ sport: sport as never, eventId: '', playerName: tip.selection, league: tip.league }, 8000).catch(() => null);
    if (!games || games === 'PENDING') continue;
    const game = gameOf(tip as never, games);
    if (!game) {
      const date = Date.parse(tip.eventDate ?? tip.createdAt);
      if (now.getTime() - date > 3 * DAY) out.push({ id: tip.id, status: 'VOID', result: `No ${tip.selection} game found on PropLine (did not play?)` });
      continue;
    }
    const value = gameValue(game.stats, read);
    if (value === null) continue;
    const over = value > tip.line, under = value < tip.line;
    const status: Result['status'] = !over && !under ? 'PUSH' : (tip.side === 'OVER') === over ? 'WON' : 'LOST';
    out.push({ id: tip.id, status, result: `${tip.selection} had ${value} ${tip.stat.toLowerCase()} (${game.away && game.home ? `${game.away} @ ${game.home}, ` : ''}${game.at.slice(0, 10)}) · PropLine box score` });
  }
  void normalizedName;
  return out;
}
