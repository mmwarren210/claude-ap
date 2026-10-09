import { createHash } from 'node:crypto';
import type { PlayableDirection, PropLine } from '@crowniq/contracts';
import type { SidePayout } from '@crowniq/edge';
import type { FairPrice } from '../context/sharp-props.js';
import { normalizedName } from '../context/match.js';
import type { StoredLine } from '../scrapers/line-store.js';
import { leagueInfo, leagueLabel, lineMarket } from '../scrapers/markets.js';
import { decimalOdds, eventKey } from './market-map.js';

// Each platform's lines in the one board-line shape Edge prices, with each side's own payout (spec §4):
// - Underdog and Pick6: their scraped boards, each side carrying its payout multiplier (a side with no multiplier is
//   not offered). A Pick6 promo (a "gimme", or a line a promo moved off its original number) shows its chance but is never
//   ranked as an edge, never anchors another app, and books are checked against its original number, not the promo one.
// - DraftKings and Hard Rock: their SharpAPI prices, every rung each book posts, each side at its own decimal odds.

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

export type PayoutBook = Map<string, Partial<Record<PlayableDirection, SidePayout>>>;

/** Underdog / Pick6 board lines from the scraped store, with each side's multiplier. */
export function appLines(stored: readonly StoredLine[], app: 'underdog' | 'pick6', fetchedAt: string) {
  const lines: PropLine[] = [], payouts: PayoutBook = new Map(), promos = new Map<string, number | null>();
  for (const line of stored) {
    if (line.app !== app || line.removedAt) continue;
    const league = leagueInfo(line.league);
    const home = line.home?.name ?? line.home?.abbreviation ?? null, away = line.away?.name ?? line.away?.abbreviation ?? null;
    const id = `${app}:${line.appLineId}`;
    // The app's own sides: Underdog lists a multiplier per side it offers; a side without one isn't offered.
    const sides = line.directions.filter((side) => !line.multipliers || line.multipliers[side] !== undefined);
    if (!sides.length) continue;
    lines.push({ id, provider: 'prizepicks', sourceLineId: line.appLineId, sourceLineIdIsSynthetic: false, sport: league.sport,
      league: line.league, sourceSportKey: league.key, eventId: `${app}-game:${line.gameId}`,
      eventName: home && away ? `${away} @ ${home}` : `${line.league} ${line.gameId}`, eventStartTime: new Date(line.startTime).toISOString(),
      playerId: `${league.key}:${hash(line.player.trim().toLowerCase())}`, playerName: line.player,
      team: line.teamName ?? line.team, opponent: line.opponent, homeTeam: home, awayTeam: away,
      market: lineMarket(line), threshold: line.line, availableDirections: sides, lineType: 'REGULAR', fetchedAt,
      ...(line.imageUrl ? { playerImageUrl: line.imageUrl } : {}) });
    const moved = line.promo?.originalLine != null && line.promo.originalLine !== line.line;
    if (line.promo?.gimme || moved) promos.set(id, moved ? line.promo!.originalLine : null);
    const blocked = promos.has(id) ? 'A Pick6 promo pick: its payout is promotional, so it is never ranked as an edge.' : undefined;
    payouts.set(id, Object.fromEntries(sides.map((side) => [side, { kind: 'ENTRY', multiplier: line.multipliers?.[side] ?? 1,
      ...(blocked ? { blocked } : {}) } satisfies SidePayout])));
  }
  return { lines, payouts, promos };
}

/** A sportsbook's SharpAPI prices as board lines, every rung it posts, each side at its decimal odds. */
export function bookLines(prices: readonly FairPrice[], book: string, fetchedAt: string) {
  const lines: PropLine[] = [], payouts: PayoutBook = new Map();
  for (const price of prices) {
    if (price.book !== book || price.stale) continue;
    const over = decimalOdds(price.overAmerican), under = decimalOdds(price.underAmerican);
    if (!over && !under) continue;
    const event = eventKey(price.sport, price.home, price.away, price.startTime);
    const id = `${book}:${hash(`${event}|${normalizedName(price.player)}|${price.market}|${price.line}`)}`;
    const sides = [...(over ? ['MORE' as const] : []), ...(under ? ['LESS' as const] : [])];
    lines.push({ id, provider: 'prizepicks', sourceLineId: id, sourceLineIdIsSynthetic: true, sport: price.sport,
      league: leagueLabel(price.sport), eventId: `book-game:${event}`,
      eventName: price.home && price.away ? `${price.away} @ ${price.home}` : event, eventStartTime: new Date(price.startTime).toISOString(),
      playerId: `${price.sport}:${hash(price.player.trim().toLowerCase())}`, playerName: price.player, team: null, opponent: null,
      homeTeam: price.home, awayTeam: price.away, market: price.market, threshold: price.line, availableDirections: sides,
      lineType: 'REGULAR', fetchedAt });
    payouts.set(id, { ...(over ? { MORE: { kind: 'ODDS', decimal: over } } : {}), ...(under ? { LESS: { kind: 'ODDS', decimal: under } } : {}) });
  }
  return { lines, payouts };
}
