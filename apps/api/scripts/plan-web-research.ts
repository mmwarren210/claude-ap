import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { boardSchema } from '@crowniq/contracts';
import { createGkrRegistry, evaluateBoard, researchTargetsFor } from '@crowniq/engine';
import { planWebResearch, sourceHintsFor } from '../src/web-research.js';

// Read-only planning from a saved board; no provider or AI requests and no credits spent.
const [, , boardPath, asOfValue, outputPath] = process.argv;
if (!boardPath || !asOfValue || !outputPath || !Number.isFinite(Date.parse(asOfValue))) {
  throw new Error('Usage: npm run plan:research -- BOARD_JSON AS_OF_ISO OUTPUT_JSON');
}
const board = boardSchema.parse(JSON.parse(await readFile(boardPath, 'utf8')));
const asOf = new Date(asOfValue);
if (asOf.getTime() < Date.parse(board.fetchedAt)) throw new Error('AS_OF_PRECEDES_BOARD');
const plans = planWebResearch(researchTargetsFor(board), asOf);
const plannedKeys = new Set(plans.map((item) => JSON.stringify([item.eventId, item.playerId])));
const plannedLines = board.lines.filter((line) => plannedKeys.has(
  JSON.stringify([line.eventId, line.playerId]))).length;
const evaluated = evaluateBoard(board, [], createGkrRegistry([]), asOf);
const reasons = Object.fromEntries([...new Set(evaluated.analyses.map((item) => item.reasonCode))]
  .sort().map((reason) => [reason, evaluated.analyses.filter((item) => item.reasonCode === reason).length]));
const bySport = Object.fromEntries([...new Set(board.lines.map((item) => item.sport))].sort().map(
  (sport) => [sport, { lines: board.lines.filter((item) => item.sport === sport).length,
    events: new Set(board.lines.filter((item) => item.sport === sport).map((item) => item.eventId)).size,
    searches: plans.filter((item) => item.sport === sport).length }]));
// Exact exploratory searches and the official pages found while building the guide.
// These are website hints; no claim that a player's result was consulted.
const sourceDiscovery = [
  { sport: 'MLB', queries: ['site:mlb.com/stats/ 2026 baseball player stats MLB official',
    'site:mlb.com/starting-lineups 2026 starting lineups official MLB'], sourceUrls: [
    'https://www.mlb.com/stats/national-league',
    'https://www.mlb.com/stats/pitching?playerPool=ALL',
    'https://www.mlb.com/starting-lineups/2026-05-27'] },
  { sport: 'NFL', queries: ['site:nfl.com/stats/player-stats/ 2026 passing NFL stats injury report official',
    'site:nfl.com/playerhealthandsafety/health-and-wellness/injury-report NFL injury report teams'], sourceUrls: [
    'https://www.nfl.com/stats/player-stats/', 'https://www.nfl.com/injuries/'] },
  { sport: 'NCAAFB', queries: ['site:ncaa.com/stats/football/fbs 2026 college football player statistics official'],
    sourceUrls: ['https://www.ncaa.com/stats/football/fbs',
      'https://www.ncaa.com/stats/football/fbs/current/individual/11'] },
  { sport: 'NBA', queries: ['site:nba.com/stats/players 2026 NBA official player stats injury report',
    'site:nba.com/player-injury 2026 injury report official NBA'], sourceUrls: [
    'https://www.nba.com/stats/players/traditional',
    'https://www.nba.com/stats/players/boxscores',
    'https://official.nba.com/nba-injury-report-2025-26-season/'] },
  { sport: 'WNBA', queries: ['site:wnba.com/stats/players 2026 official WNBA player stats injury report'],
    sourceUrls: ['https://stats.wnba.com/player/', 'https://www.wnba.com/wnba-injury-report'] },
  { sport: 'OTHER', league: 'MLS', queries: [
    'site:mlssoccer.com/stats/players 2026 official MLS player stats availability report',
    'site:mlssoccer.com/news MLS player status report 2026'], sourceUrls: [
    'https://www.mlssoccer.com/stats/',
    'https://www.mlssoccer.com/media-resources/stats-and-gameday'] },
  { sport: 'WEATHER', queries: ['site:weather.gov API forecast hourly game stadium weather official'],
    sourceUrls: ['https://www.weather.gov/documentation/services-web-api'] },
].map((item) => ({ ...item, status: 'DISCOVERY_SEARCHED_NOT_PLAYER_VERIFIED' as const }));
const report = { kind: 'CROWNIQ_WEB_RESEARCH_PLAN_V1', status: 'PLANNED_NOT_SEARCHED',
  boardFetchedAt: board.fetchedAt, asOf: asOf.toISOString(),
  boardLines: board.lines.length, uniqueEvents: new Set(board.lines.map((line) => line.eventId)).size,
  evaluatedLines: evaluated.analyses.length, rankedLines: evaluated.rankedLineIds.length,
  analysisReasons: reasons, plannedLines, unplannedLines: board.lines.length - plannedLines,
  distinctEventPlayerSearches: plans.length, bySport, sourceDiscovery,
  searches: plans.map((plan) => ({ ...plan,
    priorSourceDomainsForDiscoveryOnly: sourceHintsFor(plan.sport, plan.league),
    status: 'PLANNED_NOT_SEARCHED' as const, sourceUrls: [] })) };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, boardLines: report.boardLines,
  evaluatedLines: report.evaluatedLines, plannedLines: report.plannedLines,
  events: report.uniqueEvents, searches: report.distinctEventPlayerSearches, bySport,
  analysisReasons: reasons }));
