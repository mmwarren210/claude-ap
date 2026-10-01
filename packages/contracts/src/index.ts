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
  'SOCCER', 'AFL', 'DARTS', 'KBO',
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
});

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

export const boardResponseSchema = z.object({
  board: boardSchema,
  analyses: z.array(analysisSchema),
  rankedLineIds: z.array(identifier),
  builtAt: timestamp,
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

export type PropLine = z.infer<typeof propLineSchema>;
export type Board = z.infer<typeof boardSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
export type Assessment = z.infer<typeof assessmentSchema>;
export type ScoreBand = z.infer<typeof scoreBandSchema>;
export type SecondLookAudit = z.infer<typeof secondLookAuditSchema>;
export type Direction = z.infer<typeof directionSchema>;
export type PlayableDirection = z.infer<typeof playableDirectionSchema>;
export type Sport = z.infer<typeof sportSchema>;
export type BoardResponse = z.infer<typeof boardResponseSchema>;
export type RankingCard = z.infer<typeof rankingCardSchema>;
export type SecondLookCard = z.infer<typeof secondLookCardSchema>;
export type RankingsResponse = z.infer<typeof rankingsResponseSchema>;
export type SavedSelection = z.infer<typeof savedSelectionSchema>;
export type NflPassingResult = z.infer<typeof nflPassingResultSchema>;
