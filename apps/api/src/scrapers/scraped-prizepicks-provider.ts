import { createHash } from 'node:crypto';
import { propLineSchema } from '@crowniq/contracts';
import type { PropLine } from '@crowniq/contracts';
import type { OddsProvider } from '@crowniq/engine';
import { NFL_TEAMS } from '../current-context.js';
import type { ScrapedLineStore, StoredLine } from './line-store.js';
import { leagueInfo, lineMarket, sameLineKey, segmentOf } from './markets.js';
import { canonicalMarket } from '../edge/market-map.js';
import { SHARP_SOURCE } from './sharp-prizepicks.js';
import { prizePicksSides } from './scraped-line.js';
export { marketKey } from './markets.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

export interface BoardSourceReport {
  /** Board lines whose sources include each feed (a line two feeds confirm counts under both). */
  readonly bySource: Record<string, number>;
  /** Board lines by the feed they came from first: SharpAPI, else The Odds API, else a scraper. */
  readonly primary: { sharpapi: number; oddsApi: number; scraper: number };
  readonly goblins: number; readonly demons: number;
  /** Player-stats where sources listed different regular numbers, per sport; and how many board lines are unconfirmed. */
  readonly disagreements: Record<string, number>;
  readonly unconfirmed: number;
}

const playerKeyOf = (line: StoredLine) => JSON.stringify([leagueInfo(line.league).sport === 'OTHER' ? line.league : leagueInfo(line.league).sport,
  segmentOf(line.league), line.player.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''),
  canonicalMarket(leagueInfo(line.league).sport, lineMarket(line)), line.startTime.slice(0, 10)]);
const seenAt = (group: readonly StoredLine[]) => group.reduce((latest, line) => line.lastSeenAt > latest ? line.lastSeenAt : latest, '');

/**
 * One regular line per player and stat (step 0c). When sources list different regular numbers, the most recently observed
 * one is kept (SharpAPI on a tie) and the others dropped; a line is confirmed only when two sources report that number.
 * Goblins and Demons pass through untouched.
 */
export function resolveRegulars(groups: readonly StoredLine[][]): { groups: { lines: StoredLine[]; confirmed: boolean }[]; report: BoardSourceReport } {
  const regulars = new Map<string, StoredLine[][]>();
  const out: { lines: StoredLine[]; confirmed: boolean }[] = [];
  const disagreements: Record<string, number> = {};
  for (const group of groups) {
    if (group[0]!.tier !== 'REGULAR') { out.push({ lines: group, confirmed: new Set(group.flatMap((line) => line.confirmedBy)).size >= 2 }); continue; }
    const key = playerKeyOf(group[0]!);
    regulars.set(key, [...regulars.get(key) ?? [], group]);
  }
  for (const candidates of regulars.values()) {
    const sharp = (group: readonly StoredLine[]) => group.some((line) => line.confirmedBy.includes(SHARP_SOURCE));
    const [best] = [...candidates].sort((a, b) => seenAt(b).localeCompare(seenAt(a)) || Number(sharp(b)) - Number(sharp(a)));
    if (candidates.length > 1) { const sport = leagueInfo(best![0]!.league).sport; disagreements[sport] = (disagreements[sport] ?? 0) + 1; }
    out.push({ lines: best!, confirmed: new Set(best!.flatMap((line) => line.confirmedBy)).size >= 2 });
  }
  const bySource: Record<string, number> = {};
  const primary = { sharpapi: 0, oddsApi: 0, scraper: 0 };
  let goblins = 0, demons = 0, unconfirmed = 0;
  for (const { lines, confirmed } of out) {
    const sources = new Set(lines.flatMap((line) => line.confirmedBy));
    for (const source of sources) bySource[source] = (bySource[source] ?? 0) + 1;
    if (sources.has(SHARP_SOURCE)) primary.sharpapi++; else if (sources.has('the-odds-api')) primary.oddsApi++;
    else primary.scraper++;
    if (lines[0]!.tier === 'GOBLIN') goblins++; else if (lines[0]!.tier === 'DEMON') demons++;
    if (!confirmed) unconfirmed++;
  }
  return { groups: out, report: { bySource, primary, goblins, demons, disagreements, unconfirmed } };
}

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
  /** The last board's lines by source and the regular-line disagreements per sport (step 0 report). */
  lastReport: BoardSourceReport | null = null;
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
    const fromApp = (line: StoredLine) => !line.gameId.startsWith('odds:') && !line.gameId.startsWith('sharp:');
    // One game id per game: lines a source reported under its own event id join the app's game id.
    const appGames = new Map<string, string>();
    for (const line of stored) if (fromApp(line)) appGames.set(gameKey(line), line.gameId);
    // One board line per real line: when sources reported it under different ids, keep the record
    // most sources confirmed (app ids first, then the newest) and fill its gaps from the others.
    const groups = new Map<string, StoredLine[]>();
    for (const line of stored) groups.set(sameLineKey(line), [...groups.get(sameLineKey(line)) ?? [], line]);
    const chosen = resolveRegulars([...groups.values()]);
    this.lastReport = chosen.report;
    console.log(`[board-sources] prizepicks ${chosen.groups.length} lines ${JSON.stringify(chosen.report)}`);
    return chosen.groups.map(({ lines: group, confirmed }) => {
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
        sources: [...new Set(group.flatMap((item) => item.confirmedBy))].sort(), confirmed,
        ...(line.imageUrl ? { playerImageUrl: line.imageUrl } : {}),
        // A Goblin's or Demon's payout multiplier, when a source gave one (the Crown's payout estimate uses it).
        ...(line.tier !== 'REGULAR' && (line.multipliers?.MORE ?? line.multipliers?.LESS)
          ? { payoutMultiplier: line.multipliers?.MORE ?? line.multipliers?.LESS } : {}),
      });
    });
  }

  normalize(raw: PropLine): PropLine { return raw; }
}
