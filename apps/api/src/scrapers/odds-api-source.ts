import { createHash } from 'node:crypto';
import type { PlayableDirection, PropLine } from '@crowniq/contracts';
import type { OddsProvider } from '@crowniq/engine';
import { classifyPrizePicksLineTypes } from '../prizepicks-line-types.js';
import { leagueLabel } from './markets.js';
import type { ReadResult, ScraperSource } from './scraped-line.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

/**
 * The Odds API's PrizePicks lines as a third source next to the scrapers. It spends Odds API credits
 * (guarded by the provider's own credit limits), so by default it runs only when the owner pulls.
 * Its separate Over and Under outcomes are joined back into one line per player, market and number.
 */
export function oddsApiSource(provider: OddsProvider, clock: () => Date = () => new Date()): ScraperSource {
  return {
    id: 'the-odds-api', actor: null, apps: ['prizepicks'], rowCap: null, input: () => null,
    async run() {
      const fetchedAt = clock().toISOString();
      const lines = classifyPrizePicksLineTypes((await provider.fetchPrizePicksLines()).map((raw) => provider.normalize(raw, fetchedAt)));
      const groups = new Map<string, PropLine[]>();
      for (const line of lines) {
        // Alternates whose tier cannot be told from the Regular line are left out rather than guessed.
        if (line.lineType === 'UNKNOWN_ALTERNATE') continue;
        const key = JSON.stringify([line.eventId, line.playerId, line.market, line.threshold, line.lineType]);
        groups.set(key, [...groups.get(key) ?? [], line]);
      }
      return { rows: [...groups.values()], complete: true };
    },
    read(row: unknown, now: Date): ReadResult {
      const group = row as PropLine[];
      const [first] = group;
      if (!first || Date.parse(first.eventStartTime) <= now.getTime()) return { skip: 'LIVE_OR_STARTED' };
      const directions = [...new Set(group.flatMap((line) => line.availableDirections))] as PlayableDirection[];
      const real = group.find((line) => !line.sourceLineIdIsSynthetic)?.sourceLineId;
      const multipliers = Object.fromEntries(group.flatMap((line) =>
        line.payoutMultiplier ? line.availableDirections.map((direction) => [direction, line.payoutMultiplier!]) : []));
      return { line: { app: 'prizepicks', appLineId: real ?? 'odds:' + hash(JSON.stringify([first.eventId, first.playerId,
        first.market, first.threshold, first.lineType])), league: leagueLabel(first.sport), gameId: 'odds:' + first.eventId,
        player: first.playerName, team: null, teamName: null, opponent: null, stat: first.market, marketKey: first.market,
        line: first.threshold, tier: first.lineType === 'GOBLIN' || first.lineType === 'DEMON' ? first.lineType : 'REGULAR',
        directions, startTime: new Date(first.eventStartTime).toISOString(), imageUrl: null,
        home: first.homeTeam ? { abbreviation: first.homeTeam, name: first.homeTeam } : null,
        away: first.awayTeam ? { abbreviation: first.awayTeam, name: first.awayTeam } : null,
        multipliers: Object.keys(multipliers).length ? multipliers : null } };
    },
  };
}
