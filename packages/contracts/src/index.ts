import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });
const identifier = z.string().min(1);

export const directionSchema = z.enum(['MORE', 'LESS', 'PASS']);
export const playableDirectionSchema = z.enum(['MORE', 'LESS']);
// Preserve alternate lines even when the upstream feed does not identify their tier.
// The engine must PASS those lines until they can be classified reliably.
export const lineTypeSchema = z.enum(['REGULAR', 'GOBLIN', 'DEMON', 'UNKNOWN_ALTERNATE']);
export const sportSchema = z.enum([
  'NFL', 'MLB', 'NBA', 'WNBA', 'TENNIS', 'TABLE_TENNIS', 'BADMINTON',
  'CS2', 'VALORANT', 'LOL', 'DOTA', 'APEX', 'NHL', 'NCAAFB', 'HANDBALL',
  'SOCCER', 'AFL', 'DARTS', 'KBO', 'NCAAB', 'NCAAW', 'EUROLEAGUE',
  'OTHER',
]);

export const propLineSchema = z.object({
  id: identifier,
  provider: z.literal('prizepicks'),
  sourceLineId: identifier,
  sourceLineIdIsSynthetic: z.boolean().default(false),
  sourceMarketKey: identifier.optional(),
  sourceSportKey: identifier.optional(),
  sport: sportSchema,
  league: identifier,
  eventId: identifier,
  eventName: identifier,
  eventStartTime: timestamp,
  playerId: identifier,
  playerName: identifier,
  team: z.string().nullable(),
  opponent: z.string().nullable(),
  /** The event's two sides as the odds feed names them; team is only ever set to one of these. */
  homeTeam: z.string().nullable().optional(),
  awayTeam: z.string().nullable().optional(),
  market: identifier,
  threshold: z.number().finite(),
  availableDirections: z.array(playableDirectionSchema).min(1).refine(
    (directions) => new Set(directions).size === directions.length,
    'Directions must be unique',
  ),
  lineType: lineTypeSchema,
  fetchedAt: timestamp,
  // Optional because a provider may omit payout. Never infer payout from line type.
  payoutMultiplier: z.number().positive().finite().optional(),
  /** Player headshot the line source supplied, when it has one. Display only. */
  playerImageUrl: z.url().optional(),
  /** The feeds that reported this exact line (sharpapi, odds-api, scrapers), when the board knows. */
  sources: z.array(identifier).optional(),
  /** False when only one source reports this number for the player and stat (the two-source rule); unset when unknown. */
  confirmed: z.boolean().optional(),
});

// A sportsbook quote (SharpAPI) as Edge reads it: one book's decimal prices for one player, stat and number, exactly as
// returned; nothing is de-vigged or inferred here.
export const marketQuoteSchema = z.object({
  bookmaker: identifier,
  sport: sportSchema,
  sourceSportKey: identifier.optional(),
  eventId: identifier,
  sourceMarketKey: identifier,
  market: identifier,
  playerName: identifier,
  point: z.number().finite(),
  overPrice: z.number().gt(1).finite().nullable(),
  underPrice: z.number().gt(1).finite().nullable(),
  fetchedAt: timestamp,
  /** When the feed last saw the price, and whether it flags it stale. */
  observedAt: timestamp.optional(),
  stale: z.boolean().optional(),
}).refine((quote) => quote.overPrice !== null || quote.underPrice !== null,
  'A quote needs at least one priced side');

export const boardSchema = z.object({
  provider: z.literal('prizepicks'),
  fetchedAt: timestamp,
  lines: z.array(propLineSchema),
});

export const evidenceSchema = z.object({
  id: identifier,
  entityType: z.enum(['PLAYER', 'TEAM', 'EVENT']),
  entityId: identifier,
  eventId: identifier,
  market: identifier.nullable(),
  kind: identifier,
  finding: z.string().min(1),
  sourceName: identifier,
  sourceUrl: z.url().nullable(),
  sourceType: z.enum(['OFFICIAL', 'LICENSED_FEED', 'PUBLIC', 'AI_STRUCTURED']),
  retrievedAt: timestamp,
  expiresAt: timestamp,
  quality: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  confidence: z.number().min(0).max(1),
  // Numeric observations are supplied by attributed feeds. The GKR module owns
  // their interpretation and weighting; AI never supplies a final score.
  numeric: z.object({ value: z.number().finite(), baseline: z.number().finite().optional(),
    unit: z.string().min(1).optional() }).optional(),
  // Scenarios contain joint stat lines, avoiding independent-event fantasy math.
  scenarios: z.array(z.object({ probability: z.number().min(0).max(1),
    stats: z.record(z.string(), z.number().finite()) })).optional(),
});

export const scoreComponentSchema = z.object({
  name: identifier,
  contribution: z.number().finite(),
  explanation: z.string().min(1),
  /** Structured copies of what the explanation says, so clients never parse text. All optional. */
  kind: z.enum(['FACTOR', 'EVIDENCE_QUALITY', 'COVERAGE', 'LINE_ADJUSTMENT', 'CLAMP']).optional(),
  /** False when the factor had no current attributed metric and contributed zero. */
  measured: z.boolean().optional(),
  /** The factor's maximum points. */
  weight: z.number().finite().optional(),
  observed: z.number().finite().optional(),
  reference: z.number().finite().optional(),
  /** True when a LESS-aware model scored this factor for LESS (below reference favorable). */
  favorsBelowReference: z.boolean().optional(),
});

export const assessmentSchema = z.object({
  phase: z.enum(['INITIAL', 'ADVERSARIAL', 'FINAL']),
  direction: directionSchema,
  scoreComponents: z.array(scoreComponentSchema),
  dangerZone: z.boolean(),
  ruleChecks: z.array(z.string()),
  supportingFactors: z.array(z.string()),
  opposingFactors: z.array(z.string()),
  rationale: z.string().min(1),
  contextScore: z.number().min(0).max(100).nullable().optional(),
  // Weighted share of model factors backed by fresh attributed numeric evidence.
  // This is a data-completeness indicator, not a hit probability.
  dataConfidence: z.number().min(0).max(100).nullable().optional(),
  contextComponents: z.array(scoreComponentSchema).optional(),
  lineScore: z.number().min(0).max(100).nullable().optional(),
  lineAdjustments: z.array(scoreComponentSchema).optional(),
  thresholdCushion: z.number().finite().nullable().optional(),
  reasonCode: identifier.nullable().optional(),
});

export const scoreBandSchema = z.enum([
  'CROWN_ELITE', 'CROWN_STRONG', 'PLAYABLE', 'LEAN', 'WEAK', 'PASS',
]);

export const secondLookAuditSchema = z.object({
  initialReasonCode: z.string().nullable(),
  initialDataConfidence: z.number().min(0).max(100).nullable(),
  evidenceAdded: z.number().int().nonnegative(),
  performedAt: timestamp,
});

export const analysisSchema = z.object({
  lineId: identifier,
  direction: directionSchema,
  score: z.number().min(0).max(100).nullable(),
  scoreBreakdown: z.array(scoreComponentSchema),
  assessments: z.array(assessmentSchema),
  evidenceIds: z.array(identifier),
  evidenceExpiresAt: timestamp.nullable().optional(),
  evidenceQuality: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']),
  dangerZone: z.boolean(),
  ruleChecks: z.array(z.string()),
  supportingFactors: z.array(z.string()),
  opposingFactors: z.array(z.string()),
  rationale: z.string(),
  reasonCode: z.string().nullable(),
  modelVersion: identifier.nullable(),
  contextScore: z.number().min(0).max(100).nullable().optional(),
  dataConfidence: z.number().min(0).max(100).nullable().optional(),
  contextBreakdown: z.array(scoreComponentSchema).optional(),
  lineAdjustments: z.array(scoreComponentSchema).optional(),
  scoreBand: scoreBandSchema.nullable().optional(),
  thresholdCushion: z.number().finite().nullable().optional(),
  reviewStatus: z.enum(['STANDARD', 'SECOND_LOOK']).optional(),
  secondLook: secondLookAuditSchema.nullable().optional(),
  /** Display-only findings (web research) that no model scores. */
  contextEvidenceIds: z.array(identifier).optional(),
});

export const rankingCardSchema = z.object({
  rank: z.number().int().positive(),
  lineId: identifier,
  playerId: identifier,
  playerName: identifier,
  sport: sportSchema,
  league: identifier,
  eventId: identifier,
  eventName: identifier,
  eventStartTime: timestamp,
  team: z.string().nullable(),
  opponent: z.string().nullable(),
  market: identifier,
  threshold: z.number().finite(),
  direction: playableDirectionSchema,
  lineType: z.enum(['REGULAR', 'GOBLIN', 'DEMON']),
  payoutMultiplier: z.number().positive().finite().optional(),
  score: z.number().min(80).max(100),
  scoreBand: z.enum(['CROWN_ELITE', 'CROWN_STRONG', 'PLAYABLE']),
  contextScore: z.number().min(0).max(100).nullable().optional(),
  dataConfidence: z.number().min(0).max(100).nullable().optional(),
  modelVersion: identifier,
  evidenceQuality: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']),
  dangerZone: z.boolean(),
  thresholdCushion: z.number().finite().nullable().optional(),
  reviewStatus: z.enum(['STANDARD', 'SECOND_LOOK']),
  secondLook: secondLookAuditSchema.nullable(),
}).superRefine((card, ctx) => {
  const expectedBand = card.score >= 92 ? 'CROWN_ELITE' : card.score >= 86 ? 'CROWN_STRONG' : 'PLAYABLE';
  if (card.scoreBand !== expectedBand) ctx.addIssue({ code:'custom', path:['scoreBand'],
    message:'Primary ranking score band must match the final score.' });
  if ((card.reviewStatus === 'SECOND_LOOK') !== (card.secondLook !== null))
    ctx.addIssue({ code:'custom', path:['secondLook'],
      message:'SECOND_LOOK rankings require an audit and STANDARD rankings must not carry one.' });
});

export const secondLookCardSchema = z.object({
  rank: z.number().int().positive(),
  lineId: identifier,
  playerId: identifier,
  playerName: identifier,
  sport: sportSchema,
  league: identifier,
  eventId: identifier,
  eventName: identifier,
  eventStartTime: timestamp,
  team: z.string().nullable(),
  opponent: z.string().nullable(),
  market: identifier,
  threshold: z.number().finite(),
  direction: playableDirectionSchema,
  lineType: z.enum(['REGULAR', 'GOBLIN', 'DEMON']),
  payoutMultiplier: z.number().positive().finite().optional(),
  score: z.number().min(68).lt(80),
  scoreBand: z.enum(['LEAN', 'WEAK']),
  contextScore: z.number().min(0).max(100).nullable().optional(),
  dataConfidence: z.number().min(0).max(100).nullable().optional(),
  modelVersion: identifier,
  evidenceQuality: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']),
  dangerZone: z.boolean(),
  thresholdCushion: z.number().finite().nullable().optional(),
  reviewStatus: z.literal('SECOND_LOOK'),
  secondLook: secondLookAuditSchema,
}).superRefine((card, ctx) => {
  const expectedBand = card.score >= 74 ? 'LEAN' : 'WEAK';
  if (card.scoreBand !== expectedBand) ctx.addIssue({ code:'custom', path:['scoreBand'],
    message:'Second Look score band must match the final score.' });
});

export const rankingsResponseSchema = z.object({
  builtAt: timestamp,
  rankedLineIds: z.array(identifier),
  analyses: z.array(analysisSchema),
  rankings: z.array(rankingCardSchema),
  watchlistLineIds: z.array(identifier),
  watchlist: z.array(secondLookCardSchema),
});

/** Display media for a player, resolved from an exact source match. Absent means initials. */
export const playerMediaSchema = z.object({
  photoUrl: z.url().nullable(),
  source: z.string().nullable(),
});

export const boardResponseSchema = z.object({
  board: boardSchema,
  analyses: z.array(analysisSchema),
  rankedLineIds: z.array(identifier),
  builtAt: timestamp,
  playerMedia: z.record(z.string(), playerMediaSchema).optional(),
});

/** Recent pre-event results for one player and market, newest first. Values are never inferred. */
export const playerGameLogSchema = z.object({
  sport: sportSchema,
  playerId: identifier,
  playerName: identifier,
  market: identifier,
  source: z.enum(['CROWNIQ_INTERNAL_HISTORY', 'DEMO', 'FREE_PUBLIC_HISTORY']),
  unit: z.string().nullable(),
  games: z.array(z.object({
    date: z.string().min(10),
    opponent: z.string().nullable(),
    value: z.number().finite(),
  })).max(40),
});

export const savedSelectionSchema = z.object({
  id: identifier,
  savedAt: timestamp,
  line: propLineSchema,
  direction: playableDirectionSchema,
  score: z.number().min(0).max(100),
  contextScore: z.number().min(0).max(100).nullable().optional(),
  dataConfidence: z.number().min(0).max(100).nullable().optional(),
  scoreBand: scoreBandSchema.nullable().optional(),
  modelVersion: identifier,
  evidenceSnapshot: z.array(evidenceSchema),
  grade: z.enum(['PENDING', 'WIN', 'LOSS', 'PUSH', 'DNP_VOID']),
  gradedAt: timestamp.nullable(),
  gradeDetail: z.object({ observedValue: z.number().finite().nullable(),
    sourceName: identifier, sourceUrl: z.url(), completedAt: timestamp,
    status: z.enum(['FINAL', 'DNP', 'VOID']) }).optional(),
});

// Result IDs are mapped explicitly to the odds IDs; names alone never identify a QB.
export const nflPassingResultSchema = z.object({
  eventId: identifier,
  playerId: identifier,
  market: z.enum(['passing_yards', 'player_pass_attempts']),
  status: z.enum(['FINAL', 'DNP', 'VOID']),
  observedValue: z.number().int().nonnegative().finite().nullable(),
  completedAt: timestamp,
  retrievedAt: timestamp,
  sourceName: identifier,
  sourceUrl: z.url(),
}).superRefine((result, ctx) => {
  if ((result.status === 'FINAL') !== (result.observedValue !== null)) {
    ctx.addIssue({ code: 'custom', message: 'FINAL requires a value; DNP/VOID forbids one.' });
  }
});

// ---- CrownIQ Edge engine output (a standalone engine; never reads or changes GKR output) ----
/** Every platform Edge reads. */
export const edgePlatformSchema = z.enum(['prizepicks', 'underdog', 'pick6', 'dabble', 'draftkings', 'hardrock']);
const probability = z.number().min(0).max(1);
export const edgeTierSchema = z.enum(['SHARP', 'MARKET', 'MODEL', 'LADDER']);
export const edgeRatingSchema = z.enum(['ELITE', 'STRONG', 'VALUE', 'THIN', 'NONE']);
export const edgeBookQuoteSchema = z.object({
  bookmaker: identifier, point: z.number().finite(),
  overPrice: z.number().gt(1).nullable(), underPrice: z.number().gt(1).nullable(),
  fairOver: probability, twoSided: z.boolean(),
});
export const edgePickSchema = z.object({
  platform: edgePlatformSchema.default('prizepicks'),
  key: identifier,
  lineId: identifier,
  oppositeLineId: identifier.nullable(),
  sport: sportSchema, league: identifier,
  eventId: identifier, eventName: identifier, eventStartTime: timestamp,
  playerId: identifier, playerName: identifier,
  /** The player's team when the app lists it (same-game correlation uses it). */
  team: z.string().nullable().optional(),
  market: identifier, threshold: z.number().finite(),
  lineType: lineTypeSchema,
  side: playableDirectionSchema,
  probability, pushProbability: probability, oppositeProbability: probability,
  breakEven: probability,
  // p − break-even for standard-payout lines; null when the payout factor is unknown.
  edge: z.number().finite().nullable(),
  // Minimum PrizePicks payout factor for this leg to beat the reference break-even.
  requiredPayoutFactor: z.number().positive().finite(),
  edgeScore: z.number().min(0).max(100),
  rating: edgeRatingSchema,
  tier: edgeTierSchema,
  projection: z.object({ mean: z.number().finite(), median: z.number().finite(),
    sd: z.number().nonnegative().finite(), family: z.enum(['POISSON', 'NEGBIN', 'NORMAL']) }),
  lineGap: z.number().finite().nullable(),
  // Edge's own line: the number where MORE and LESS are closest to 50/50 on Edge's distribution.
  fairLine: z.number().finite(),
  sources: z.object({
    market: z.object({ mean: z.number().finite(), weight: probability,
      books: z.array(edgeBookQuoteSchema) }).nullable(),
    stats: z.object({ mean: z.number().finite(), weight: probability, samples: z.number().int(),
      recentMean: z.number().finite(), seasonMean: z.number().finite(),
      hitRateAtLine: probability.nullable() }).nullable(),
    ladder: z.object({ mean: z.number().finite(), weight: probability,
      regularThreshold: z.number().finite() }).nullable(),
    /** Other DFS apps' regular numbers for the same player and stat, read as weak 50/50 anchors (step 3). */
    anchors: z.object({ mean: z.number().finite(), weight: probability, thresholds: z.array(z.number().finite()) }).optional(),
  }),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  calibrated: z.boolean(),
  modelVersion: identifier,
  // The side's own payout: an app's per-pick multiplier (Underdog, DK Pick'em, a confirmed Goblin/Demon factor) or a
  // sportsbook's decimal odds, with the bet's expected value per $1 and a quarter-Kelly stake (share of bankroll).
  payoutMultiplier: z.number().positive().finite().optional(),
  decimalOdds: z.number().gt(1).finite().optional(),
  ev: z.number().finite().optional(),
  kelly: z.number().min(0).max(1).optional(),
  // Movement (spec §3): the books moved after this app's number last changed, toward this side; and steam (3+ books
  // moving together). `rank` is the sort score (EV × confidence × freshness, spec §6).
  stale: z.object({ minutesAgo: z.number().nonnegative(), books: z.number().int().nonnegative(),
    direction: z.enum(['UP', 'DOWN']) }).optional(),
  steam: z.boolean().optional(),
  rank: z.number().finite().optional(),
  injury: z.string().optional(),
  // The same player and stat on the other platforms (spec §8 "best number across apps"): each one's number, Edge's chance
  // for this side there, its payout and edge.
  /** The player's headshot (the board's player photos, or the app line's own image), when there is one. */
  playerImageUrl: z.url().optional(),
  elsewhere: z.array(z.object({ platform: z.enum(['prizepicks', 'underdog', 'pick6', 'dabble', 'draftkings', 'hardrock']),
    lineId: identifier, threshold: z.number().finite(), side: playableDirectionSchema, probability, edge: z.number().finite().nullable(),
    payoutMultiplier: z.number().positive().finite().optional(), ev: z.number().finite().optional() })).optional(),
});
export const edgeEntrySchema = z.object({
  type: z.enum(['POWER', 'FLEX', 'PARLAY']), size: z.number().int().min(2).max(20),
  // payouts[k] is the multiple of the entry returned when exactly k legs hit.
  payouts: z.record(z.string(), z.number().nonnegative()),
  breakEven: probability,
});
export const edgeSlipSchema = z.object({
  entry: edgeEntrySchema,
  legs: z.array(z.object({ lineId: identifier, playerName: identifier, market: identifier,
    threshold: z.number().finite(), side: playableDirectionSchema, probability,
    eventId: identifier, sport: sportSchema, payoutMultiplier: z.number().positive().finite().optional() })),
  allHitProbability: probability,
  expectedReturn: z.number().nonnegative().finite(),
  expectedProfit: z.number().finite(),
  hitDistribution: z.array(probability),
  sameGameLegs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  /** Same-game pairs CrownIQ prices as correlated (spec §7), and the EV the independent closed form would give. */
  correlatedPairs: z.array(z.object({ a: identifier, b: identifier, rho: z.number().min(-1).max(1), label: z.string() })).optional(),
  independentExpectedReturn: z.number().nonnegative().finite().optional(),
  correlationNote: z.string().optional(),
  /** Kelly fraction of bankroll for this entry alone and its expected log growth per entry. */
  kellyFraction: z.number().min(0).max(1).optional(),
  growth: z.number().finite().optional(),
  /** The single swap that adds the most EV (custom slip checker). */
  suggestion: z.object({ replaceLineId: identifier, replacePlayerName: z.string(), lineId: identifier, playerName: z.string(),
    market: identifier, threshold: z.number().finite(), side: playableDirectionSchema, expectedReturn: z.number().finite(),
    gain: z.number().finite() }).optional(),
});
export const edgeBoardResponseSchema = z.object({
  modelVersion: identifier,
  builtAt: timestamp,
  boardFetchedAt: timestamp,
  referenceEntry: edgeEntrySchema,
  entries: z.array(edgeEntrySchema),
  counts: z.object({ linesPriced: z.number().int(), linesUnpriced: z.number().int(),
    sharp: z.number().int(), market: z.number().int(), model: z.number().int(), ladder: z.number().int(),
    positiveEdge: z.number().int(), quotes: z.number().int() }),
  calibration: z.object({ status: z.enum(['UNCALIBRATED', 'CALIBRATED']), graded: z.number().int(),
    brier: z.number().nullable(), hitRate: z.number().nullable() }),
  picks: z.array(edgePickSchema),
  slips: z.array(edgeSlipSchema),
  /** Why a sportsbook's tab is empty when its feed is down at the provider ("book unavailable"). */
  feedNote: z.string().optional(),
  /** Every sport with a rated upcoming pick on this platform and how many (the sport chips), whatever the list was cut to. */
  sports: z.array(z.object({ sport: z.string(), picks: z.number().int().nonnegative() })).optional(),
  /** Rated picks per stat for the chosen sports (the stat picker). */
  markets: z.array(z.object({ market: z.string(), picks: z.number().int().nonnegative() })).optional(),
  /** Games with rated picks for the chosen sports (the game picker), soonest first. */
  games: z.array(z.object({ eventId: z.string(), eventName: z.string(), sport: z.string(), startTime: z.string(), picks: z.number().int().nonnegative() })).optional(),
});

export const edgeUnpricedLineSchema = z.object({
  lineId: identifier, sport: sportSchema, league: identifier, eventId: identifier, eventName: identifier,
  eventStartTime: timestamp, playerId: identifier, playerName: identifier, market: identifier,
  threshold: z.number().finite(), lineType: lineTypeSchema, availableDirections: z.array(playableDirectionSchema),
  platform: edgePlatformSchema.default('prizepicks'),
  reason: z.enum(['NO_DATA', 'NO_INDEPENDENT_READ', 'NO_MARKET_MAP']), note: z.string(),
});
// Every line on the board, read or not: Edge never hides a line it could not price.
export const edgeBoardRowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PICK'), pick: edgePickSchema }),
  z.object({ kind: z.literal('NO_READ'), line: edgeUnpricedLineSchema }),
]);
export const edgeBoardPageSchema = z.object({
  modelVersion: identifier, builtAt: timestamp, boardFetchedAt: timestamp,
  total: z.number().int(), offset: z.number().int(), limit: z.number().int(),
  sports: z.array(z.string()), rows: z.array(edgeBoardRowSchema),
  /** Stats listed for the chosen sports (the stat picker), most lines first. */
  markets: z.array(z.object({ market: z.string(), lines: z.number().int().nonnegative() })).optional(),
  /** Games for the chosen sports (the game picker), soonest first; `picks` counts their lines. */
  games: z.array(z.object({ eventId: z.string(), eventName: z.string(), sport: z.string(), startTime: z.string(), picks: z.number().int().nonnegative() })).optional(),
});
export const edgeGenResponseSchema = z.object({
  modelVersion: identifier, builtAt: timestamp, pool: z.number().int(),
  slips: z.array(edgeSlipSchema), notes: z.array(z.string()),
});

export type PropLine = z.infer<typeof propLineSchema>;
export type MarketQuote = z.infer<typeof marketQuoteSchema>;
export type EdgePick = z.infer<typeof edgePickSchema>;
export type EdgeEntry = z.infer<typeof edgeEntrySchema>;
export type EdgeSlip = z.infer<typeof edgeSlipSchema>;
export type EdgeBoardResponse = z.infer<typeof edgeBoardResponseSchema>;
export type EdgeTier = z.infer<typeof edgeTierSchema>;
export type EdgeRating = z.infer<typeof edgeRatingSchema>;
export type EdgeUnpricedLine = z.infer<typeof edgeUnpricedLineSchema>;
export type EdgeBoardRow = z.infer<typeof edgeBoardRowSchema>;
export type EdgeBoardPage = z.infer<typeof edgeBoardPageSchema>;
export type EdgeGenResponse = z.infer<typeof edgeGenResponseSchema>;
export type EdgePlatform = z.infer<typeof edgePlatformSchema>;
export type Board = z.infer<typeof boardSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
export type Assessment = z.infer<typeof assessmentSchema>;
export type ScoreComponent = z.infer<typeof scoreComponentSchema>;
export type ScoreBand = z.infer<typeof scoreBandSchema>;
export type SecondLookAudit = z.infer<typeof secondLookAuditSchema>;
export type Direction = z.infer<typeof directionSchema>;
export type PlayableDirection = z.infer<typeof playableDirectionSchema>;
export type Sport = z.infer<typeof sportSchema>;
export type BoardResponse = z.infer<typeof boardResponseSchema>;
export type PlayerMedia = z.infer<typeof playerMediaSchema>;
export type PlayerGameLog = z.infer<typeof playerGameLogSchema>;
export type RankingCard = z.infer<typeof rankingCardSchema>;
export type SecondLookCard = z.infer<typeof secondLookCardSchema>;
export type RankingsResponse = z.infer<typeof rankingsResponseSchema>;
export type SavedSelection = z.infer<typeof savedSelectionSchema>;
export type NflPassingResult = z.infer<typeof nflPassingResultSchema>;

/* ---------- Pick'em payouts and break-evens ---------- */

export const pickAppSchema = z.enum(['prizepicks', 'underdog', 'pick6', 'dabble']);
export type PickApp = z.infer<typeof pickAppSchema>;
export const entryModeSchema = z.enum(['POWER', 'FLEX']);
export type EntryMode = z.infer<typeof entryModeSchema>;

const multiplier = z.number().nonnegative().finite();
/** Multipliers by legs, then by hits ("6": { "6": 25, "5": 2 }). A hit count that isn't listed pays nothing. */
export const payoutTableSchema = z.record(z.string().regex(/^[2-8]$/), z.record(z.string().regex(/^[0-8]$/), multiplier));
export const appPayoutsSchema = z.object({ POWER: payoutTableSchema, FLEX: payoutTableSchema });
export const payoutsSchema = z.record(pickAppSchema, appPayoutsSchema);
export type PayoutTable = Readonly<Record<string, Readonly<Record<string, number>>>>;
export type AppPayouts = Readonly<Record<EntryMode, PayoutTable>>;
export type Payouts = Readonly<Record<PickApp, AppPayouts>>;

/**
 * Standard-line payouts each app has published (estimates: the apps change them, pay less on some lines and run
 * promos). The server can replace them with CROWNIQ_PAYOUTS without a release. Pick6 has no Flex play, and publishes no fixed
 * chart: it shows a Base Payout at entry and pays extra by contest standings, so its numbers here are estimates.
 */
export const DEFAULT_PAYOUTS: Payouts = {
  // PrizePicks' published chart (checked 2026-10-05): Power 3/6/10/20/37.5x; Flex now starts at 2 picks.
  prizepicks: {
    POWER: { 2: { 2: 3 }, 3: { 3: 6 }, 4: { 4: 10 }, 5: { 5: 20 }, 6: { 6: 37.5 } },
    FLEX: { 2: { 2: 2, 1: 0.5 }, 3: { 3: 3, 2: 1 }, 4: { 4: 6, 3: 1.5 }, 5: { 5: 10, 4: 2, 3: 0.4 }, 6: { 6: 25, 5: 2, 4: 0.4 } },
  },
  // Underdog's published base multipliers (checked 2026-10-05), before each pick's own multiplier: Standard 2–8 picks,
  // Flex 3–8 picks (6+ picks are double-flexed).
  underdog: {
    POWER: { 2: { 2: 3.5 }, 3: { 3: 6.5 }, 4: { 4: 12 }, 5: { 5: 20 }, 6: { 6: 35 }, 7: { 7: 65 }, 8: { 8: 120 } },
    FLEX: { 3: { 3: 3.25, 2: 1.09 }, 4: { 4: 6, 3: 1.4 }, 5: { 5: 10, 4: 2.5 }, 6: { 6: 25, 5: 2.6, 4: 0.25 },
      7: { 7: 40, 6: 2.75, 5: 0.5 }, 8: { 8: 80, 7: 3, 6: 1 } },
  },
  // DK Pick'em (owner, 2026-10-06): the published minimum base payouts are used as floors (3: 6x, 4: 10x, 5: 12x, 7: 40x,
  // 8: 80x, with 5/6 = 1.5x, 6/7 = 2x, 7/8 = 3x and 6/8 = 1x). Pick'em lists 2 and 6 picks as "varies", so those use the
  // PrizePicks numbers. Pool winnings on top of the base are not counted, so Edge's Pick'em EV is a lower bound.
  pick6: {
    POWER: { 2: { 2: 3 }, 3: { 3: 6 }, 4: { 4: 10 }, 5: { 5: 12 }, 6: { 6: 37.5, 5: 1.5 }, 7: { 7: 40, 6: 2 }, 8: { 8: 80, 7: 3, 6: 1 } },
    FLEX: {},
  },
  // Dabble (owner's app screenshots, 2026-10-09): every pick must hit, 2–12 picks at 3/6/10/20/40/80/150/275/500/1000/1500x.
  // Dabble's Hedge entries (13–16 picks, and payouts with a miss) show only their top prize, so none is assumed for them.
  dabble: {
    POWER: { 2: { 2: 3 }, 3: { 3: 6 }, 4: { 4: 10 }, 5: { 5: 20 }, 6: { 6: 40 }, 7: { 7: 80 }, 8: { 8: 150 }, 9: { 9: 275 },
      10: { 10: 500 }, 11: { 11: 1000 }, 12: { 12: 1500 } },
    FLEX: {},
  },
};

const choose = (n: number, k: number) => { let result = 1; for (let i = 1; i <= k; i++) result = result * (n - k + i) / i; return result; };

/** What a 1-unit entry returns on average when every pick hits with chance p. */
export function entryReturn(table: Readonly<Record<string, number>>, legs: number, p: number): number {
  let total = 0;
  for (const [hits, pays] of Object.entries(table)) {
    const k = Number(hits);
    total += pays * choose(legs, k) * p ** k * (1 - p) ** (legs - k);
  }
  return total;
}

/** The chance each pick must hit for this entry to break even, to 4 places; null when it never pays back. */
export function breakEven(table: Readonly<Record<string, number>> | undefined, legs: number): number | null {
  if (!table || entryReturn(table, legs, 1) < 1) return null;
  let low = 0, high = 1;
  for (let step = 0; step < 50; step++) {
    const mid = (low + high) / 2;
    if (entryReturn(table, legs, mid) < 1) low = mid; else high = mid;
  }
  return Math.round(high * 10_000) / 10_000;
}

export interface EntryBreakEven { readonly mode: EntryMode; readonly legs: number; readonly breakEven: number; readonly fullHit: number }

/** Every entry an app offers with its break-even, lowest first. */
export function entryBreakEvens(payouts: AppPayouts): EntryBreakEven[] {
  const entries: EntryBreakEven[] = [];
  for (const mode of entryModeSchema.options) for (const [legs, table] of Object.entries(payouts[mode])) {
    const value = breakEven(table, Number(legs));
    if (value !== null) entries.push({ mode, legs: Number(legs), breakEven: value, fullHit: table[legs] ?? 0 });
  }
  return entries.sort((a, b) => a.breakEven - b.breakEven || a.legs - b.legs);
}

/** The app's easiest entry to beat: the lowest per-pick break-even it offers. */
export const bestBreakEven = (payouts: AppPayouts): EntryBreakEven | null => entryBreakEvens(payouts)[0] ?? null;

/**
 * Defaults with a valid override merged in by entry size: { "pick6": { "POWER": { "3": { "3": 6 } } } } changes only
 * Pick6's 3-pick Power payout. An empty table ({}) removes that entry. Anything invalid leaves the defaults.
 */
export function mergePayouts(override: unknown): Payouts {
  const parsed = z.partialRecord(pickAppSchema, appPayoutsSchema.partial()).safeParse(override);
  if (!parsed.success) return DEFAULT_PAYOUTS;
  const merged = { ...DEFAULT_PAYOUTS } as Record<PickApp, AppPayouts>;
  for (const [app, modes] of Object.entries(parsed.data) as [PickApp, Partial<AppPayouts>][]) {
    const next = { ...merged[app] } as Record<EntryMode, PayoutTable>;
    for (const [mode, table] of Object.entries(modes) as [EntryMode, PayoutTable][]) {
      const sizes: Record<string, Readonly<Record<string, number>>> = { ...next[mode], ...table };
      for (const legs of Object.keys(sizes)) if (!Object.keys(sizes[legs]!).length) delete sizes[legs];
      next[mode] = sizes;
    }
    merged[app] = next;
  }
  return merged;
}
