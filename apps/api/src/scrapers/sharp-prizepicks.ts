import type { PickemLine } from '../context/sharp-props.js';
import { normalizedName } from '../context/match.js';
import { leagueLabel } from './markets.js';
import type { ScrapedLine } from './scraped-line.js';

// Step 0: SharpAPI's PrizePicks lines as one more source in the scraped-line store, the primary one for regular lines.
// SharpAPI carries no Goblins or Demons (is_alternate_line returns nothing), so those still come from The Odds API and the
// scrapers. Only lines whose stat maps to a CrownIQ market go in: an unmapped stat would land under a different key from
// the same line the scrapers carry, a duplicate rather than a confirmation.

export const SHARP_SOURCE = 'sharpapi';

/** SharpAPI PrizePicks lines as store lines, and how many were left out per sport and SharpAPI market type. */
export function sharpPrizePicksScraped(lines: readonly PickemLine[]): { lines: ScrapedLine[]; unmapped: Map<string, number> } {
  const out = new Map<string, ScrapedLine>(), unmapped = new Map<string, number>();
  for (const line of lines) {
    if (!line.book.startsWith('prizepicks') || !line.sport || line.alternate || line.stale) continue;
    if (!line.market) { const key = `${line.sport}:${line.marketType}`; unmapped.set(key, (unmapped.get(key) ?? 0) + 1); continue; }
    // Stable while the line is up, even when its number moves (a move then needs confirming again).
    const appLineId = `sharp:${line.eventId}:${normalizedName(line.player).replace(/ /g, '-')}:${line.marketType}`;
    const existing = out.get(appLineId);
    // PrizePicks and PrizePicks Flex list the same line once each.
    out.set(appLineId, { app: 'prizepicks', appLineId, league: leagueLabel(line.sport), gameId: `sharp:${line.eventId}`,
      player: line.player, team: null, teamName: null, opponent: null, stat: line.marketType, marketKey: line.market,
      line: line.line, tier: 'REGULAR', directions: [...new Set([...existing?.directions ?? [], ...line.sides])],
      startTime: new Date(line.startTime).toISOString(), imageUrl: null,
      home: line.home ? { abbreviation: line.home, name: line.home } : null,
      away: line.away ? { abbreviation: line.away, name: line.away } : null, multipliers: null });
  }
  return { lines: [...out.values()], unmapped };
}
