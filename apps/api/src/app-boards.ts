import { createHash } from 'node:crypto';
import type { Analysis, BoardResponse, PlayableDirection, PropLine } from '@crowniq/contracts';
import { leagueInfo, lineMarket } from './scrapers/markets.js';
import type { ScrapedLineStore, StoredLine } from './scrapers/line-store.js';
import type { DfsApp } from './scrapers/scraped-line.js';

// Underdog and DraftKings Pick6 boards from the scraper store: the apps' own lines, for picking and line shopping.
// The same PrizePicks line and its GKR score show beside them. GKR scores the app lines themselves (owner approved
// 2026-10-04, CROWNIQ_APP_GKR_SCORES) with the approved models on the PrizePicks line's research; see appScores.

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
 * GKR scores on the app lines, when given, ride along as analyses so a backed leg keeps its score.
 */
export function asBoard(lines: readonly AppLine[], fetchedAt: string,
  scores: ReadonlyMap<string, AppScore> = new Map()): BoardResponse {
  return { board: { provider: 'prizepicks', fetchedAt,
    lines: lines.map(({ app: _app, stat: _stat, multipliers: _multipliers, prizePicks: _reference, playerImageUrl, ...line }) =>
      ({ ...line, provider: 'prizepicks', sourceLineId: line.id.split(':').slice(1).join(':'),
        availableDirections: [...line.availableDirections], ...(playerImageUrl ? { playerImageUrl } : {}) }) as unknown as PropLine) },
  // A leg on the side GKR backs keeps its GKR score on the saved slip.
  analyses: [...scores].map(([lineId, score]) => ({ lineId, direction: score.direction, score: score.score,
    modelVersion: score.modelVersion })), rankedLineIds: [], builtAt: fetchedAt } as unknown as BoardResponse;
}

/** How an app's number compares with the PrizePicks number for the side picked (MORE: lower is easier). */
export type LineComparison = 'SAME' | 'BETTER' | 'WORSE';
export interface PortedLeg {
  readonly lineId: string; readonly direction: PlayableDirection;
  /** The app's line for the same player and stat that day, or null when the app does not list one. */
  readonly match: AppLine | null;
  /** False when the app lists the line but not the side picked (e.g. Higher only). */
  readonly sideOffered: boolean;
  readonly comparison: LineComparison | null;
}

/**
 * Carries PrizePicks picks over to Underdog or Pick6: for each pick, the app's line for the same player and stat on the
 * same day (standard lines first, then the closest number), and how that number compares for the side picked.
 */
export async function portLegs(store: ScrapedLineStore, app: OtherApp, board: BoardResponse,
  legs: readonly { lineId: string; direction: PlayableDirection }[]): Promise<PortedLeg[]> {
  const { lines } = await appBoard(store, app, null);
  const byKey = new Map<string, AppLine[]>();
  for (const line of lines) {
    const key = JSON.stringify([line.playerId, statKey(line.market), line.eventStartTime.slice(0, 10)]);
    byKey.set(key, [...byKey.get(key) ?? [], line]);
  }
  const source = new Map(board.board.lines.map((line) => [line.id, line]));
  return legs.map(({ lineId, direction }) => {
    const line = source.get(lineId);
    const options = line ? byKey.get(JSON.stringify([line.playerId, statKey(line.market), line.eventStartTime.slice(0, 10)])) ?? [] : [];
    const match = [...options].sort((a, b) => Number(b.availableDirections.includes(direction)) -
      Number(a.availableDirections.includes(direction)) || Number(b.lineType === 'REGULAR') - Number(a.lineType === 'REGULAR') ||
      Math.abs(a.threshold - line!.threshold) - Math.abs(b.threshold - line!.threshold))[0] ?? null;
    const comparison: LineComparison | null = !match || !line ? null : match.threshold === line.threshold ? 'SAME'
      : (match.threshold < line.threshold) === (direction === 'MORE') ? 'BETTER' : 'WORSE';
    return { lineId, direction, match, sideOffered: !!match?.availableDirections.includes(direction), comparison };
  });
}

/** How much of an app's board PrizePicks also lists, for the owner's scoring decision. */
export async function appCoverage(store: ScrapedLineStore, app: OtherApp, board: BoardResponse | null) {
  const { lines } = await appBoard(store, app, board);
  const regular = lines.filter((line) => line.lineType === 'REGULAR');
  return { lines: lines.length, regular: regular.length,
    onPrizePicks: regular.filter((line) => line.prizePicks).length,
    sameNumber: regular.filter((line) => line.prizePicks?.threshold === line.threshold).length,
    gkrRead: regular.filter((line) => line.prizePicks?.gkr).length,
    byLeague: Object.fromEntries([...new Set(regular.map((line) => line.league))].map((league) => {
      const group = regular.filter((line) => line.league === league);
      return [league, { lines: group.length, onPrizePicks: group.filter((line) => line.prizePicks).length,
        gkrRead: group.filter((line) => line.prizePicks?.gkr).length }];
    })) };
}

/** PrizePicks lines by player, stat and day, for finding the line whose research applies to an app line. */
export function prizePicksIndex(lines: readonly PropLine[]): Map<string, PropLine[]> {
  const byKey = new Map<string, PropLine[]>();
  for (const line of lines) {
    const key = JSON.stringify([line.playerId, statKey(line.market), line.eventStartTime.slice(0, 10)]);
    byKey.set(key, [...byKey.get(key) ?? [], line]);
  }
  return byKey;
}

/** The PrizePicks line whose research applies to an app line: same player, stat and day; standard first, then closest. */
export function researchLineFor(line: Pick<AppLine, 'playerId' | 'market' | 'eventStartTime' | 'threshold'>,
  index: Map<string, PropLine[]>): PropLine | null {
  const options = index.get(JSON.stringify([line.playerId, statKey(line.market), line.eventStartTime.slice(0, 10)])) ?? [];
  return [...options].sort((a, b) => Number(b.lineType === 'REGULAR') - Number(a.lineType === 'REGULAR') ||
    Math.abs(a.threshold - line.threshold) - Math.abs(b.threshold - line.threshold))[0] ?? null;
}

/** The app line as a board line on the PrizePicks game, so the PrizePicks research applies at the app's number. */
export function scoredLine(app: Pick<AppLine, 'id' | 'threshold' | 'availableDirections' | 'lineType' | 'fetchedAt'>,
  prizePicks: PropLine): PropLine {
  return { ...prizePicks, id: app.id, sourceLineId: app.id, threshold: app.threshold,
    availableDirections: [...app.availableDirections], lineType: app.lineType as PropLine['lineType'],
    fetchedAt: app.fetchedAt };
}

export interface AppScore { readonly direction: PlayableDirection; readonly score: number; readonly modelVersion: string }

/**
 * GKR on an app's lines (owner approved 2026-10-04): each line PrizePicks also lists runs through the same approved
 * model, at the app's number and sides, on the PrizePicks line's research. Lines GKR passes on have no entry.
 */
export function appScores(lines: readonly AppLine[], boardLines: readonly PropLine[],
  scoreLines: (lines: readonly PropLine[]) => Analysis[], now: Date): Map<string, AppScore> {
  const index = prizePicksIndex(boardLines);
  const pairs = lines.flatMap((line) => {
    const prizePicks = Date.parse(line.eventStartTime) > now.getTime() ? researchLineFor(line, index) : null;
    return prizePicks ? [{ line, prizePicks }] : [];
  });
  const analyses = scoreLines(pairs.map(({ line, prizePicks }) => scoredLine(line, prizePicks)));
  const scores = new Map<string, AppScore>();
  pairs.forEach(({ line }, index) => {
    const analysis = analyses[index];
    if (analysis && analysis.direction !== 'PASS' && analysis.score !== null && analysis.modelVersion)
      scores.set(line.id, { direction: analysis.direction, score: analysis.score, modelVersion: analysis.modelVersion });
  });
  return scores;
}
