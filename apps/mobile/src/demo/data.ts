import type { Analysis, BoardResponse, PlayerGameLog, PlayerMedia, PropLine, RankingCard,
  RankingsResponse, ScoreBand, SecondLookCard, Sport } from '@crowniq/contracts';

/**
 * Demo mode's sample slate. Every number here is illustrative sample data, not a real
 * projection, result or pick. The clock is frozen on a past date so nothing can be played.
 */
export const DEMO_NOW = Date.parse('2026-01-13T20:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const hours = (count: number) => DEMO_NOW + count * 3_600_000;
const FETCHED_AT = iso(DEMO_NOW - 4 * 60_000);
const MODEL = 'GKR-DEMO-SAMPLE';

type Quality = Analysis['evidenceQuality'];
type Spec = {
  key: string; sport: Sport; league: string; player: string; team: string; opponent: string; home: boolean;
  start: number; market: string; threshold: number; lineType: PropLine['lineType']; direction: 'MORE' | 'LESS' | 'PASS';
  score: number | null; quality: Quality; projection: number; reason?: string; secondLook?: boolean;
  photo?: string; games: number[];
};

const nba = (id: number) => `https://cdn.nba.com/headshots/nba/latest/1040x760/${id}.png`;

const slate: Spec[] = [
  { key: 'luka-ast-85', sport: 'NBA', league: 'NBA', player: 'Luka Dončić', team: 'LAL', opponent: 'DEN', home: true,
    start: hours(7), market: 'player_assists', threshold: 8.5, lineType: 'REGULAR', direction: 'MORE', score: 93,
    quality: 'HIGH', projection: 10.2, photo: nba(1629029),
    games: [11, 8, 14, 10, 9, 10, 12, 7, 9, 11, 8, 13, 9, 10, 12] },
  { key: 'aja-pts-195', sport: 'WNBA', league: 'WNBA', player: "A'ja Wilson", team: 'LV', opponent: 'LA', home: true,
    start: hours(7), market: 'player_points', threshold: 19.5, lineType: 'DEMON', direction: 'MORE', score: 88,
    quality: 'HIGH', projection: 22.1, photo: 'https://cdn.wnba.com/headshots/wnba/latest/1040x760/1628932.png',
    games: [24, 21, 18, 26, 22, 20, 17, 25, 23, 19, 22, 27, 21, 18, 24] },
  { key: 'ja-pts-215', sport: 'NBA', league: 'NBA', player: 'Ja Morant', team: 'MEM', opponent: 'SAS', home: false,
    start: hours(28), market: 'player_points', threshold: 21.5, lineType: 'REGULAR', direction: 'MORE', score: 87,
    quality: 'MEDIUM', projection: 23.4, photo: nba(1629630),
    games: [25, 19, 28, 22, 24, 18, 26, 21, 23, 20, 27, 22, 19, 24, 25] },
  { key: 'ant-pts-265', sport: 'NBA', league: 'NBA', player: 'Anthony Edwards', team: 'MIN', opponent: 'PHX', home: true,
    start: hours(6), market: 'player_points', threshold: 26.5, lineType: 'REGULAR', direction: 'MORE', score: 86,
    quality: 'HIGH', projection: 28.3, photo: nba(1630162),
    games: [31, 27, 24, 33, 29, 22, 30, 28, 26, 32, 25, 29, 34, 27, 23] },
  { key: 'allen-pass-2455', sport: 'NFL', league: 'NFL', player: 'Josh Allen', team: 'BUF', opponent: 'MIA', home: true,
    start: hours(113), market: 'passing_yards', threshold: 245.5, lineType: 'GOBLIN', direction: 'MORE', score: 84,
    quality: 'MEDIUM', projection: 278.4, photo: 'https://a.espncdn.com/i/headshots/nfl/players/full/3918298.png',
    games: [298, 262, 231, 284, 307, 249, 266, 238, 291, 274, 255, 288, 241, 279, 260] },
  { key: 'tatum-reb-85', sport: 'NBA', league: 'NBA', player: 'Jayson Tatum', team: 'BOS', opponent: 'NYK', home: false,
    start: hours(4.5), market: 'player_rebounds', threshold: 8.5, lineType: 'GOBLIN', direction: 'MORE', score: 82,
    quality: 'MEDIUM', projection: 9.1, photo: nba(1628369),
    games: [11, 9, 7, 10, 8, 12, 9, 6, 10, 9, 11, 8, 10, 7, 9] },
  { key: 'brown-rec-45', sport: 'NFL', league: 'NFL', player: 'Chase Brown', team: 'CIN', opponent: 'PIT', home: false,
    start: hours(113), market: 'player_receptions', threshold: 4.5, lineType: 'GOBLIN', direction: 'MORE', score: 81,
    quality: 'MEDIUM', projection: 5.8, games: [6, 5, 7, 4, 6, 3, 5, 6, 4, 7, 5, 6, 4, 5, 6] },
  { key: 'curry-pts-295', sport: 'NBA', league: 'NBA', player: 'Stephen Curry', team: 'GSW', opponent: 'LAC', home: true,
    start: hours(8), market: 'player_points', threshold: 29.5, lineType: 'REGULAR', direction: 'LESS', score: 80,
    quality: 'MEDIUM', projection: 26.2, photo: nba(201939),
    games: [24, 31, 22, 27, 25, 33, 21, 26, 28, 23, 30, 24, 27, 22, 26] },
  // Below the ranking cut: watchlist and full-board lines.
  { key: 'kd-pts-275', sport: 'NBA', league: 'NBA', player: 'Kevin Durant', team: 'HOU', opponent: 'DAL', home: true,
    start: hours(6), market: 'player_points', threshold: 27.5, lineType: 'REGULAR', direction: 'MORE', score: 76,
    quality: 'MEDIUM', projection: 28.1, secondLook: true, photo: nba(201142),
    games: [29, 24, 31, 27, 26, 30, 22, 28, 33, 25, 27, 29, 24, 31, 26] },
  { key: 'mcbride-rec-55', sport: 'NFL', league: 'NFL', player: 'Trey McBride', team: 'ARI', opponent: 'LAR', home: false,
    start: hours(116), market: 'player_receptions', threshold: 5.5, lineType: 'REGULAR', direction: 'MORE', score: 78,
    quality: 'MEDIUM', projection: 6.3, secondLook: true, games: [7, 6, 8, 5, 7, 6, 4, 9, 6, 7, 5, 8, 6, 7, 5] },
  { key: 'bam-reb-95', sport: 'NBA', league: 'NBA', player: 'Bam Adebayo', team: 'MIA', opponent: 'ORL', home: false,
    start: hours(4), market: 'player_rebounds', threshold: 9.5, lineType: 'REGULAR', direction: 'MORE', score: 71,
    quality: 'LOW', projection: 10.0, photo: nba(1628389),
    games: [11, 9, 12, 8, 10, 13, 9, 7, 11, 10, 12, 9, 8, 11, 10] },
  { key: 'hall-rush-705', sport: 'NFL', league: 'NFL', player: 'Breece Hall', team: 'NYJ', opponent: 'TEN', home: true,
    start: hours(113), market: 'player_rush_yds', threshold: 70.5, lineType: 'REGULAR', direction: 'MORE', score: 74,
    quality: 'MEDIUM', projection: 74.2, games: [81, 66, 92, 58, 77, 70, 88, 63, 79, 71, 84, 59, 75, 90, 68] },
  { key: 'pg-pts-185', sport: 'NBA', league: 'NBA', player: 'Paul George', team: 'PHI', opponent: 'HOU', home: false,
    start: hours(5), market: 'player_points', threshold: 18.5, lineType: 'REGULAR', direction: 'PASS', score: null,
    quality: 'NONE', projection: 18.0, reason: 'STALE_OR_MISSING_EVIDENCE', photo: nba(202331),
    games: [17, 21, 15, 19, 22, 14, 18, 20, 16, 23, 19, 17, 15, 21, 18] },
  { key: 'evans-rec-55', sport: 'NFL', league: 'NFL', player: 'Mike Evans', team: 'TB', opponent: 'DET', home: false,
    start: hours(116), market: 'player_receptions', threshold: 5.5, lineType: 'REGULAR', direction: 'PASS', score: null,
    quality: 'MEDIUM', projection: 5.4, reason: 'INSUFFICIENT_EDGE', games: [5, 6, 4, 7, 5, 6, 3, 6, 5, 4, 7, 5, 6, 4, 5] },
];

// Luka's assists ladder, for the line selector on Player Research.
const ladder: Spec[] = [
  { ...slate[0], key: 'luka-ast-65', threshold: 6.5, lineType: 'GOBLIN', score: 89, quality: 'HIGH' },
  { ...slate[0], key: 'luka-ast-75', threshold: 7.5, lineType: 'GOBLIN', score: 91, quality: 'HIGH' },
  { ...slate[0], key: 'luka-ast-95', threshold: 9.5, lineType: 'DEMON', score: 84, quality: 'HIGH' },
  { ...slate[0], key: 'luka-ast-105', threshold: 10.5, lineType: 'DEMON', score: 76, quality: 'HIGH' },
];
const specs = [...slate, ...ladder];

const opponents: Readonly<Record<string, string[]>> = {
  NBA: ['HOU', 'MIN', 'SAC', 'PHX', 'UTA', 'DEN', 'OKC', 'POR', 'DAL', 'LAC', 'NOP', 'MEM', 'SAS', 'GSW', 'DEN'],
  WNBA: ['SEA', 'LA', 'PHX', 'MIN', 'DAL', 'CON', 'NY', 'IND', 'ATL', 'LA', 'CHI', 'WAS', 'SEA', 'PHX', 'LA'],
  NFL: ['NYJ', 'NE', 'MIA', 'KC', 'BAL', 'PIT', 'CLE', 'MIA', 'DEN', 'LV', 'LAC', 'JAX', 'HOU', 'TEN', 'IND'],
};

function bandOf(score: number | null): ScoreBand {
  if (score === null) return 'PASS';
  return score >= 92 ? 'CROWN_ELITE' : score >= 86 ? 'CROWN_STRONG' : score >= 80 ? 'PLAYABLE' :
    score >= 74 ? 'LEAN' : score >= 68 ? 'WEAK' : 'PASS';
}

const factorSets: Readonly<Record<string, [string, number][]>> = {
  player_assists: [['minutes', 20], ['potential_assists', 25], ['ball_handling_rate', 20],
    ['historical_assist_volume', 15], ['opponent_defense', 10], ['pace', 5], ['stability', 5]],
  player_points: [['expected_minutes', 25], ['shot_volume', 20], ['usage_proxy', 20], ['scoring_rate', 15],
    ['matchup', 10], ['pace', 5], ['stability', 5]],
  player_rebounds: [['minutes', 25], ['rebound_rate', 25], ['historical_rebound_volume', 20],
    ['opponent_shot_profile', 10], ['team_rebounding_environment', 10], ['pace', 5], ['stability', 5]],
  passing_yards: [['expected_attempts', 25], ['efficiency_environment', 20], ['protection_pressure', 15],
    ['game_script', 15], ['personnel', 10], ['historical_current_form', 10], ['stability', 5]],
  player_receptions: [['target_floor', 25], ['catch_rate', 20], ['offensive_snap_volume', 20],
    ['historical_reception_volume', 15], ['matchup_coverage', 10], ['qb_completion_environment', 5], ['stability', 5]],
  player_rush_yds: [['expected_carries', 30], ['rush_attempt_rate', 25], ['rb_efficiency_skill', 20],
    ['historical_rush_volume', 10], ['game_script', 5], ['opponent_rush_defense', 5], ['stability', 5]],
};

const round = (value: number) => Math.round(value * 100) / 100;

function analysisFor(spec: Spec, line: PropLine): Analysis {
  const band = bandOf(spec.score);
  const expires = iso(Math.min(spec.start, DEMO_NOW + 50 * 60_000));
  if (spec.direction === 'PASS' || spec.score === null) {
    return { lineId: line.id, direction: 'PASS', score: null, scoreBreakdown: [], assessments: [],
      evidenceIds: [], evidenceExpiresAt: null, evidenceQuality: spec.quality, dangerZone: false, ruleChecks: [],
      supportingFactors: [], opposingFactors: [], rationale: (spec.reason ?? 'MODEL_PASS').replaceAll('_', ' ').toLowerCase(),
      reasonCode: spec.reason ?? 'MODEL_PASS', modelVersion: MODEL, contextScore: null, dataConfidence: null,
      contextBreakdown: [], lineAdjustments: [], scoreBand: 'PASS', thresholdCushion: null,
      reviewStatus: 'STANDARD', secondLook: null };
  }
  const spread = Math.max(1, Math.abs(spec.projection) * 0.18);
  const cushion = round(Math.abs(spec.projection - spec.threshold) / spread);
  const adjustments = [
    { name: 'threshold_cushion', contribution: round(Math.min(12, cushion * 5)), explanation: `Signed margin ${cushion} standard deviations.` },
    { name: 'variance', contribution: 0, explanation: 'Distribution coefficient of variation 0.18.' },
    { name: 'evidence', contribution: spec.quality === 'HIGH' ? 2 : 0, explanation: 'Quality of the attributed, fresh evidence.' },
    { name: 'demon_tax', contribution: spec.lineType === 'DEMON' ? -4 : 0, explanation: 'Added difficulty of this exact Demon outcome.' },
  ];
  const contextScore = round(Math.max(0, Math.min(100, spec.score - adjustments.reduce((sum, item) => sum + item.contribution, 0))));
  const factors = factorSets[spec.market] ?? factorSets.player_points;
  const share = contextScore / 100;
  const contextBreakdown = factors.map(([name, weight], index) => ({ name,
    contribution: round(weight * Math.min(1, share * (index % 2 ? 0.96 : 1.04))),
    explanation: `Sample value versus reference; weight ${weight}.` }));
  const drift = round(contextScore - contextBreakdown.reduce((sum, item) => sum + item.contribution, 0));
  contextBreakdown[0] = { ...contextBreakdown[0], contribution: round(contextBreakdown[0].contribution + drift) };
  const scoreBreakdown = [...contextBreakdown, ...adjustments];
  return {
    lineId: line.id, direction: spec.direction, score: spec.score, scoreBreakdown, assessments: [],
    evidenceIds: [`demo:${spec.key}:projection`, `demo:${spec.key}:status`], evidenceExpiresAt: expires,
    evidenceQuality: spec.quality, dangerZone: cushion < 0.3, ruleChecks: ['DIRECTION_OFFERED', 'THRESHOLD_EVALUATED'],
    supportingFactors: ['Exact threshold has a favorable distribution cushion.',
      `Recent ${spec.direction === 'MORE' ? 'volume trending up' : 'volume trending down'} against the longer baseline.`],
    opposingFactors: spec.quality === 'HIGH' ? [] : ['Missing attributed factor matchup'],
    rationale: `Sample ${spec.direction} on ${spec.market}.`, reasonCode: null, modelVersion: MODEL,
    contextScore, dataConfidence: spec.quality === 'HIGH' ? 100 : 85, contextBreakdown, lineAdjustments: adjustments,
    scoreBand: band, thresholdCushion: cushion,
    reviewStatus: spec.secondLook ? 'SECOND_LOOK' : 'STANDARD',
    secondLook: spec.secondLook ? { initialReasonCode: 'STALE_OR_MISSING_EVIDENCE', initialDataConfidence: 60,
      evidenceAdded: 3, performedAt: iso(DEMO_NOW - 20 * 60_000) } : null,
  };
}

const playerId = (spec: Spec) => `demo:${spec.sport}:${spec.player.toLowerCase().replace(/[^a-z]+/g, '-')}`;
const eventId = (spec: Spec) => `demo-event:${spec.sport}:${[spec.team, spec.opponent].sort().join('-')}`;

function lineFor(spec: Spec): PropLine {
  const away = spec.home ? spec.opponent : spec.team, home = spec.home ? spec.team : spec.opponent;
  const directions: ('MORE' | 'LESS')[] = spec.lineType === 'REGULAR'
    ? [spec.direction === 'LESS' ? 'LESS' : 'MORE'] : ['MORE'];
  return { id: `demo-line:${spec.key}`, provider: 'prizepicks', sourceLineId: `demo:${spec.key}`,
    sourceLineIdIsSynthetic: true, sport: spec.sport, league: spec.league, eventId: eventId(spec),
    eventName: `${away} @ ${home}`, eventStartTime: iso(spec.start), playerId: playerId(spec),
    playerName: spec.player, team: spec.team, opponent: spec.opponent, market: spec.market,
    threshold: spec.threshold, availableDirections: directions, lineType: spec.lineType, fetchedAt: FETCHED_AT };
}

const lines = specs.map(lineFor);
const analyses = specs.map((spec, index) => analysisFor(spec, lines[index]));
const byId = new Map(lines.map((line) => [line.id, line]));

// One best line per player, highest score first, PLAYABLE or better: the same rule the engine uses.
const rankedLineIds = (() => {
  const best = new Map<string, Analysis>();
  for (const analysis of analyses) {
    if (analysis.score === null || analysis.score < 80) continue;
    const player = byId.get(analysis.lineId)!.playerId;
    const current = best.get(player);
    if (!current || (current.score ?? 0) < analysis.score) best.set(player, analysis);
  }
  return [...best.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((item) => item.lineId);
})();

const playerMedia: Record<string, PlayerMedia> = Object.fromEntries(slate.map((spec) =>
  [playerId(spec), { photoUrl: spec.photo ?? null, source: spec.photo ? 'demo' : null }]));

export const demoBoard: BoardResponse = { board: { provider: 'prizepicks', fetchedAt: FETCHED_AT, lines },
  analyses, rankedLineIds, builtAt: iso(DEMO_NOW - 3 * 60_000), playerMedia };

function card(line: PropLine, analysis: Analysis, rank: number) {
  return { rank, lineId: line.id, playerId: line.playerId, playerName: line.playerName, sport: line.sport,
    league: line.league, eventId: line.eventId, eventName: line.eventName, eventStartTime: line.eventStartTime,
    team: line.team, opponent: line.opponent, market: line.market, threshold: line.threshold,
    direction: analysis.direction as 'MORE' | 'LESS', lineType: line.lineType as 'REGULAR' | 'GOBLIN' | 'DEMON',
    score: analysis.score!, contextScore: analysis.contextScore, dataConfidence: analysis.dataConfidence,
    modelVersion: MODEL, evidenceQuality: analysis.evidenceQuality, dangerZone: analysis.dangerZone,
    thresholdCushion: analysis.thresholdCushion };
}

const analysisById = new Map(analyses.map((item) => [item.lineId, item]));
const rankings: RankingCard[] = rankedLineIds.map((id, index) => {
  const analysis = analysisById.get(id)!;
  return { ...card(byId.get(id)!, analysis, index + 1), scoreBand: analysis.scoreBand as RankingCard['scoreBand'],
    reviewStatus: analysis.reviewStatus ?? 'STANDARD', secondLook: analysis.secondLook ?? null };
});
const watchlist: SecondLookCard[] = analyses.filter((item) => item.reviewStatus === 'SECOND_LOOK' &&
  (item.scoreBand === 'LEAN' || item.scoreBand === 'WEAK')).map((analysis, index) => ({
  ...card(byId.get(analysis.lineId)!, analysis, index + 1), scoreBand: analysis.scoreBand as 'LEAN' | 'WEAK',
  reviewStatus: 'SECOND_LOOK' as const, secondLook: analysis.secondLook! }));

/** True for the built-in sample board, false for real lines from the server's demo feed. */
export const isSampleBoard = (board: { builtAt: string }) => board.builtAt === demoBoard.builtAt;

export const demoRankings: RankingsResponse = { builtAt: demoBoard.builtAt, rankedLineIds,
  analyses: analyses.filter((item) => rankedLineIds.includes(item.lineId)), rankings,
  watchlistLineIds: watchlist.map((item) => item.lineId), watchlist };

export function demoGameLog(sport: string, player: string, market: string): PlayerGameLog | null {
  const spec = slate.find((item) => item.sport === sport && playerId(item) === player && item.market === market);
  if (!spec) return null;
  const pool = opponents[spec.sport] ?? opponents.NBA;
  const step = spec.sport === 'NFL' ? 7 : 2;
  return { sport: spec.sport, playerId: player, playerName: spec.player, market, source: 'DEMO', unit: null,
    games: spec.games.map((value, index) => ({ date: iso(DEMO_NOW - (index + 1) * step * 86_400_000).slice(0, 10),
      opponent: pool[index % pool.length], value })) };
}

/* ---------- Results ---------- */

type Grade = 'WIN' | 'LOSS' | 'PUSH' | 'PENDING';
type Leg = { playerName: string; playerId: string; sport: Sport; market: string; threshold: number;
  direction: 'MORE' | 'LESS'; lineType: PropLine['lineType']; score: number; grade: Grade; actual: number | null;
  opponent: string; eventStartTime: string };
const legOf = (spec: Spec, grade: Grade, actual: number | null, daysAgo: number): Leg => ({
  playerName: spec.player, playerId: playerId(spec), sport: spec.sport, market: spec.market, threshold: spec.threshold,
  direction: spec.direction === 'LESS' ? 'LESS' : 'MORE', lineType: spec.lineType, score: spec.score ?? 80, grade, actual,
  opponent: spec.opponent, eventStartTime: iso(DEMO_NOW - daysAgo * 86_400_000) });
const find = (key: string) => slate.find((spec) => spec.key === key)!;
const extra = (player: string, team: string, opponent: string, sport: Sport, market: string, threshold: number,
  lineType: PropLine['lineType'], photo?: string): Spec => ({ key: player, sport, league: sport, player, team, opponent,
  home: true, start: DEMO_NOW, market, threshold, lineType, direction: 'MORE', score: 84, quality: 'MEDIUM',
  projection: threshold, games: [], photo });

export const demoCrowns = [
  { id: '7d1b6c4e-0000-4000-8000-000000000001', name: "King's Crown", savedAt: iso(DEMO_NOW - 1 * 86_400_000), legs: [
    legOf(find('luka-ast-85'), 'WIN', 10, 1), legOf(find('aja-pts-195'), 'WIN', 22, 1),
    legOf(find('allen-pass-2455'), 'WIN', 298, 1), legOf(find('ja-pts-215'), 'WIN', 24, 1),
    legOf(find('tatum-reb-85'), 'WIN', 11, 1)] },
  { id: '7d1b6c4e-0000-4000-8000-000000000002', name: 'Demon Line', savedAt: iso(DEMO_NOW - 2 * 86_400_000), legs: [
    legOf(extra('Stephen Curry', 'GSW', 'LAC', 'NBA', 'player_threes', 3.5, 'DEMON', nba(201939)), 'WIN', 5, 2),
    legOf(find('brown-rec-45'), 'WIN', 6, 2), legOf(find('kd-pts-275'), 'LOSS', 24, 2),
    legOf(extra('Bam Adebayo', 'MIA', 'ORL', 'NBA', 'player_rebounds', 9.5, 'DEMON', nba(1628389)), 'WIN', 11, 2)] },
  { id: '7d1b6c4e-0000-4000-8000-000000000003', name: 'Goblin Line', savedAt: iso(DEMO_NOW - 3 * 86_400_000), legs: [
    legOf(find('mcbride-rec-55'), 'WIN', 7, 3), legOf(find('ant-pts-265'), 'LOSS', 18, 3),
    legOf(extra('Paul George', 'PHI', 'HOU', 'NBA', 'player_threes', 2.5, 'GOBLIN', nba(202331)), 'LOSS', 1, 3)] },
  { id: '7d1b6c4e-0000-4000-8000-000000000004', name: 'Standard Line', savedAt: iso(DEMO_NOW - 0.1 * 86_400_000), legs: [
    legOf(extra('Anthony Richardson', 'IND', 'GB', 'NFL', 'passing_yards', 200.5, 'REGULAR'), 'PENDING', null, -5),
    legOf(find('hall-rush-705'), 'PENDING', null, -5),
    legOf(extra('Malik Nabers', 'NYG', 'WAS', 'NFL', 'player_receptions', 6.5, 'REGULAR'), 'PENDING', null, -5),
    legOf(find('evans-rec-55'), 'PENDING', null, -5)] },
];

/** Graded single picks for the record and units chart: 36 wins and 14 losses over 7 days. */
export const demoPicks = Array.from({ length: 54 }, (_, index) => {
  const spec = slate[index % 8];
  const daysAgo = index < 4 ? -1 : 1 + Math.floor((index - 4) / 7.2);
  const grade: Grade = index < 4 ? 'PENDING' : [5, 9, 13, 18, 22, 26, 31, 35, 38, 42, 45, 48, 51, 53].includes(index)
    ? 'LOSS' : 'WIN';
  const value = grade === 'PENDING' ? null : grade === 'WIN'
    ? spec.threshold + (spec.direction === 'LESS' ? -2 : 2) : spec.threshold + (spec.direction === 'LESS' ? 2 : -2);
  return { id: `demo-pick-${index}`, savedAt: iso(DEMO_NOW - daysAgo * 86_400_000), playerName: spec.player,
    sport: spec.sport, market: spec.market, eventStartTime: iso(DEMO_NOW - daysAgo * 86_400_000),
    threshold: spec.threshold, direction: spec.direction === 'LESS' ? 'LESS' : 'MORE', lineType: spec.lineType,
    lineScore: spec.score ?? 80, modelVersion: MODEL, result: grade, actual: value === null ? null : round(value) };
});

/* ---------- Social ---------- */

export const demoTopUsers = [
  ['CourtVision', 61, 22, 2], ['GoblinKing', 55, 21, 1], ['MikeyBets', 48, 19, 3], ['DemonHunter', 44, 20, 0],
  ['SharpSide', 41, 18, 2], ['PropDoc', 39, 17, 1], ['LineLord', 36, 17, 0], ['OverEasy', 33, 16, 2],
  ['ParlayPilot', 31, 15, 1], ['FadeTheFloor', 29, 14, 0],
].map(([name, wins, losses, pushes], index) => ({
  publicId: `7d1b6c4e-0000-4000-9000-0000000000${String(index + 10)}`, displayName: name as string,
  wins: wins as number, losses: losses as number, pushes: pushes as number,
  graded: (wins as number) + (losses as number) + (pushes as number),
  hitRate: (wins as number) / ((wins as number) + (losses as number)) }));

export const demoPublicCrowns = demoCrowns.slice(0, 3).map((crown, index) => ({
  publicCrownId: crown.id, ownerPublicId: demoTopUsers[index].publicId, createdAt: crown.savedAt,
  legs: crown.legs.map((leg) => ({ playerName: leg.playerName, market: leg.market, direction: leg.direction,
    exactLine: leg.threshold, lineType: leg.lineType, lineScore: leg.score, modelVersion: MODEL, grade: leg.grade })) }));
