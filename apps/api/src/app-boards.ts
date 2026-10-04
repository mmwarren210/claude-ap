import { createHash } from 'node:crypto';
import type { Analysis, BoardResponse, PlayableDirection, PropLine } from '@crowniq/contracts';
import { leagueInfo, lineMarket } from './scrapers/markets.js';
import type { ScrapedLineStore, StoredLine } from './scrapers/line-store.js';
import type { DfsApp } from './scrapers/scraped-line.js';

// Underdog and DraftKings Pick6 boards from the scraper store. These are the apps' own lines, shown for picking and
// line shopping. GKR does not score them: when PrizePicks has the same player and stat, its line and GKR score are
// shown beside them for reference only. Scoring other apps' lines needs the owner's approval and a new model version.

export type OtherApp = Exclude<DfsApp, 'prizepicks'>;
export const otherApps: readonly OtherApp[] = ['underdog', 'pick6'];
const prefixes: Readonly<Record<OtherApp, string>> = { underdog: 'ud', pick6: 'p6' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

/** Stat names that mean the same thing under different keys, so lines match across apps. */
const sameStat: Readonly<Record<string, string>> = { rush_plus_rec_yds: 'player_rush_reception_yds',
  pass_plus_rush_yds: 'player_pass_rush_yds', rush_rec_tds: 'anytime_tds', rush_plus_rec_tds: 'anytime_tds' };
export const statKey = (market: string) => sameStat[market] ?? market;

/** What PrizePicks shows for the same player and stat, for reference. */
export interface PrizePicksReference {
  readonly lineId: string; readonly threshold: number; readonly lineType: string;
  /** GKR's side and score on that PrizePicks line; null when GKR passes or has no model for it. */
  readonly gkr: { readonly direction: PlayableDirection; readonly score: number } | null;
}

export interface AppLine {
  readonly id: string; readonly app: OtherApp; readonly sport: string; readonly league: string;
  readonly eventId: string; readonly eventName: string; readonly eventStartTime: string;
  readonly playerId: string; readonly playerName: string; readonly team: string | null; readonly opponent: string | null;
  readonly homeTeam: string | null; readonly awayTeam: string | null;
  readonly market: string; readonly stat: string; readonly threshold: number; readonly lineType: string;
  readonly availableDirections: readonly PlayableDirection[];
  readonly multipliers: Partial<Record<PlayableDirection, number>> | null;
  readonly playerImageUrl: string | null; readonly fetchedAt: string;
  readonly prizePicks: PrizePicksReference | null;
}

function toAppLine(app: OtherApp, line: StoredLine): Omit<AppLine, 'prizePicks'> {
  const league = leagueInfo(line.league);
  const home = line.home?.name ?? line.home?.abbreviation ?? null, away = line.away?.name ?? line.away?.abbreviation ?? null;
  const team = line.teamName ?? line.team, opponent = line.opponent;
  const sides = home && away ? [away, home] : [team, opponent].filter((side): side is string => !!side).sort();
  return { id: `${prefixes[app]}:${line.appLineId}`, app, sport: league.sport, league: line.league,
    eventId: `${prefixes[app]}-game:${line.gameId}`,
    eventName: home && away ? `${away} @ ${home}` : sides.length === 2 ? `${sides[0]} vs ${sides[1]}` : `${line.league} game`,
    eventStartTime: line.startTime,
    // Same player id scheme as PrizePicks lines, so photos and player history line up across apps.
    playerId: `${league.key}:${hash(line.player.trim().toLowerCase())}`, playerName: line.player,
    team, opponent, homeTeam: sides.length === 2 ? sides[1] : null, awayTeam: sides.length === 2 ? sides[0] : null,
    market: lineMarket(line), stat: line.stat, threshold: line.line, lineType: line.tier,
    availableDirections: [...line.directions], multipliers: line.multipliers ?? null, playerImageUrl: line.imageUrl,
    fetchedAt: line.lastSeenAt };
}

/** The standard PrizePicks line for the same player and stat on the same day (the closest number when several). */
function referenceFor(line: Omit<AppLine, 'prizePicks'>, index: Map<string, PropLine[]>,
  analyses: Map<string, Analysis>): PrizePicksReference | null {
  const day = line.eventStartTime.slice(0, 10);
  const candidates = (index.get(JSON.stringify([line.playerId, statKey(line.market)])) ?? [])
    .filter((item) => item.eventStartTime.slice(0, 10) === day)
    .sort((a, b) => Number(b.lineType === 'REGULAR') - Number(a.lineType === 'REGULAR') ||
      Math.abs(a.threshold - line.threshold) - Math.abs(b.threshold - line.threshold));
  const match = candidates[0];
  if (!match) return null;
  const analysis = analyses.get(match.id);
  return { lineId: match.id, threshold: match.threshold, lineType: match.lineType,
    gkr: analysis && analysis.direction !== 'PASS' && analysis.score !== null
      ? { direction: analysis.direction, score: analysis.score } : null };
}

export async function appBoard(store: ScrapedLineStore, app: OtherApp, board: BoardResponse | null) {
  const stored = await store.active(app);
  const index = new Map<string, PropLine[]>();
  for (const line of board?.board.lines ?? []) {
    const key = JSON.stringify([line.playerId, statKey(line.market)]);
    index.set(key, [...index.get(key) ?? [], line]);
  }
  const analyses = new Map((board?.analyses ?? []).map((item) => [item.lineId, item]));
  const lines = stored.map((line) => toAppLine(app, line))
    .map((line) => ({ ...line, prizePicks: referenceFor(line, index, analyses) }))
    .sort((a, b) => a.eventStartTime.localeCompare(b.eventStartTime) || a.playerName.localeCompare(b.playerName));
  const fetchedAt = stored.reduce<string | null>((latest, line) => !latest || line.lastSeenAt > latest ? line.lastSeenAt : latest, null);
  return { app, fetchedAt, lines };
}

/**
 * The app's lines in board shape, so a personal Crown can be saved and graded like any other.
 * There are no analyses: GKR does not score these lines.
 */
export function asBoard(lines: readonly AppLine[], fetchedAt: string): BoardResponse {
  return { board: { provider: 'prizepicks', fetchedAt,
    lines: lines.map(({ app: _app, stat: _stat, multipliers: _multipliers, prizePicks: _reference, playerImageUrl, ...line }) =>
      ({ ...line, provider: 'prizepicks', sourceLineId: line.id.split(':').slice(1).join(':'),
        availableDirections: [...line.availableDirections], ...(playerImageUrl ? { playerImageUrl } : {}) }) as unknown as PropLine) },
  analyses: [], rankedLineIds: [], builtAt: fetchedAt } as unknown as BoardResponse;
}
