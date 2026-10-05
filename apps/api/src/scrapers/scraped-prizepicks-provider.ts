import { createHash } from 'node:crypto';
import { propLineSchema } from '@crowniq/contracts';
import type { PropLine } from '@crowniq/contracts';
import type { OddsProvider } from '@crowniq/engine';
import { NFL_TEAMS } from '../current-context.js';
import type { ScrapedLineStore, StoredLine } from './line-store.js';
import { leagueInfo, lineMarket, sameLineKey } from './markets.js';
import { prizePicksSides } from './scraped-line.js';
export { marketKey } from './markets.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

/** PrizePicks NFL abbreviations that differ from the standard ones. */
const nflAliases: Readonly<Record<string, string>> = { JAC: 'JAX', LA: 'LAR', WSH: 'WAS' };

/** Readable team names for a slate: NFL full names, otherwise the names the rows themselves give. */
function teamNames(lines: readonly StoredLine[]): (league: string, abbreviation: string | null) => string | null {
  const names = new Map<string, string>();
  for (const line of lines) {
    if (line.team && line.teamName) names.set(`${line.league}|${line.team}`, line.teamName);
    for (const side of [line.home, line.away]) if (side?.name) names.set(`${line.league}|${side.abbreviation}`, side.name);
  }
  return (league, abbreviation) => {
    if (!abbreviation) return null;
    if (league === 'NFL') return NFL_TEAMS[nflAliases[abbreviation] ?? abbreviation] ?? abbreviation;
    return names.get(`${league}|${abbreviation}`) ?? abbreviation;
  };
}

/**
 * PrizePicks lines from the scraper store, as board lines. Reading the store is free; the scraper
 * pulls happen on their own schedule. Ids and market keys follow the Odds API provider's, so player
 * history and models line up whichever source supplied a line.
 */
export class ScrapedPrizePicksProvider implements OddsProvider<PropLine> {
  readonly id = 'apify-scrapers:prizepicks';
  constructor(private readonly store: ScrapedLineStore) {}

  async fetchPrizePicksLines(): Promise<readonly PropLine[]> {
    const stored = await this.store.active('prizepicks');
    if (!stored.length) throw new Error('SCRAPED_LINES_UNAVAILABLE');
    const name = teamNames(stored);
    const sidesOf = (line: StoredLine) => {
      const team = name(line.league, line.team), opponent = name(line.league, line.opponent);
      // Real home and away when a source said which is which; otherwise the two sides in a fixed order.
      const home = line.home ? name(line.league, line.home.abbreviation) : null;
      const away = line.away ? name(line.league, line.away.abbreviation) : null;
      const sides = home && away ? [away, home] : [team, opponent].filter((side): side is string => !!side).sort();
      return { team, opponent, home, away, sides };
    };
    // Sources can list a game's start a few minutes apart, so games match on league, teams and start hour.
    const gameKey = (line: StoredLine) => JSON.stringify([line.league, line.startTime.slice(0, 13), [...sidesOf(line).sides].sort()]);
    const fromApp = (line: StoredLine) => !line.gameId.startsWith('odds:');
    // One game id per game: lines a source reported under its own event id join the app's game id.
    const appGames = new Map<string, string>();
    for (const line of stored) if (fromApp(line)) appGames.set(gameKey(line), line.gameId);
    // One board line per real line: when sources reported it under different ids, keep the record
    // most sources confirmed (app ids first, then the newest) and fill its gaps from the others.
    const groups = new Map<string, StoredLine[]>();
    for (const line of stored) groups.set(sameLineKey(line), [...groups.get(sameLineKey(line)) ?? [], line]);
    return [...groups.values()].map((group) => {
      const [best, ...others] = [...group].sort((a, b) => Number(fromApp(b)) - Number(fromApp(a)) ||
        b.confirmedBy.length - a.confirmedBy.length || b.lastSeenAt.localeCompare(a.lastSeenAt));
      const line: StoredLine = { ...best, imageUrl: best.imageUrl ?? others.find((item) => item.imageUrl)?.imageUrl ?? null,
        home: best.home ?? others.find((item) => item.home)?.home ?? null, away: best.away ?? others.find((item) => item.away)?.away ?? null,
        team: best.team ?? others.find((item) => item.team)?.team ?? null, opponent: best.opponent ?? others.find((item) => item.opponent)?.opponent ?? null };
      const league = leagueInfo(line.league);
      const { team, opponent, home, away, sides } = sidesOf(line);
      const gameId = fromApp(line) ? line.gameId : appGames.get(gameKey(line)) ?? line.gameId;
      return propLineSchema.parse({
        id: 'pp:' + line.appLineId, provider: 'prizepicks', sourceLineId: line.appLineId,
        sport: league.sport, league: line.league, sourceSportKey: league.key,
        eventId: 'pp-game:' + gameId,
        eventName: sides.length !== 2 ? `${line.league} ${gameId}` : home && away ? `${away} @ ${home}` : `${sides[0]} vs ${sides[1]}`,
        eventStartTime: line.startTime,
        playerId: league.key + ':' + hash(line.player.trim().toLowerCase()), playerName: line.player,
        team, opponent, homeTeam: sides.length === 2 ? sides[1] : null, awayTeam: sides.length === 2 ? sides[0] : null,
        market: lineMarket(line), threshold: line.line, availableDirections: prizePicksSides(line.tier, line.directions),
        lineType: line.tier, fetchedAt: line.lastSeenAt,
        ...(line.imageUrl ? { playerImageUrl: line.imageUrl } : {}),
        // A Goblin's or Demon's payout multiplier, when a source gave one (the Crown's payout estimate uses it).
        ...(line.tier !== 'REGULAR' && (line.multipliers?.MORE ?? line.multipliers?.LESS)
          ? { payoutMultiplier: line.multipliers?.MORE ?? line.multipliers?.LESS } : {}),
      });
    });
  }

  normalize(raw: PropLine): PropLine { return raw; }
}
