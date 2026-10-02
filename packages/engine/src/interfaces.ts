import type { Analysis, Assessment, Board, Evidence, PropLine, SavedSelection, Sport } from '@crowniq/contracts';

/** Each adapter owns its raw format; only normalized lines cross into the engine. */
export interface OddsProvider<TRaw = unknown> {
  readonly id: string;
  fetchPrizePicksLines(): Promise<readonly TRaw[]>;
  normalize(raw: TRaw, fetchedAt: string): PropLine;
  getHealth?(): {
    readonly creditsRemaining: number | null;
    readonly lastRequestCost: number | null;
    readonly lastHttpStatus: number | null;
  };
}

export interface ResearchTarget {
  readonly eventId: string;
  readonly eventName: string;
  readonly eventStartTime: string;
  readonly league: string;
  readonly playerId: string;
  readonly playerName: string;
  readonly team: string | null;
  readonly opponent: string | null;
  /** The event's sides as the odds feed names them, when known. */
  readonly homeTeam?: string | null;
  readonly awayTeam?: string | null;
  readonly market: string;
  readonly sport: Sport;
  /** The provider's own sport key (for example soccer_epl), which names the league inside a sport. */
  readonly sourceSportKey?: string | null;
}

export interface ResearchAdapter {
  readonly id: string;
  research(targets: readonly ResearchTarget[]): Promise<readonly Evidence[]>;
  getHealth?(): ResearchHealth;
  /** Optional capability check for targeted research stages such as Second Look. */
  supports?(target: ResearchTarget): boolean;
}

export interface ResearchHealth {
  readonly status: 'OK' | 'PARTIAL' | 'FAILED';
  readonly targets: number;
  readonly searches: number;
  readonly cacheHits: number;
  readonly skipped: number;
  readonly failures: number;
  readonly noSources?: number;
  readonly lastRunAt: string | null;
  /** Sanitized adapter/source diagnostics. Never include credentials, raw URLs with secrets, or payloads. */
  readonly sources?: Readonly<Record<string, {
    readonly status: 'OK' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
    readonly targets: number;
    readonly evidence: number;
    readonly failures: number;
    readonly errorCode?: string | null;
  }>>;
}

/** A future adapter may persist findings with per-kind expiry to avoid repeat searches. */
export interface EvidenceCache {
  get(target: ResearchTarget, now: Date): Promise<readonly Evidence[]>;
  put(findings: readonly Evidence[]): Promise<void>;
}

export interface ModelContext {
  readonly line: PropLine;
  readonly evidence: readonly Evidence[];
  readonly phase: Assessment['phase'];
  readonly previous: Assessment | null;
}

/** Versioned sport and market rules are code. Research adapters never make picks. */
export interface ModelModule {
  readonly sport: Sport;
  readonly market: string;
  readonly version: string;
  readonly requiredEvidenceKinds: readonly string[];
  /** Evidence that must exist before the module is even invoked. Other declared inputs
   * may be scored as missing/zero only when the module explicitly supports partial coverage. */
  readonly hardRequiredEvidenceKinds?: readonly string[];
  readonly recommendedEvidenceKinds?: readonly string[];
  readonly calibrationApproved?: boolean;
  assess(context: ModelContext): Assessment;
}

export interface CrownCandidate {
  readonly line: PropLine;
  readonly analysis: Analysis;
}

export type CorrelationPolicy = (picks: readonly CrownCandidate[]) => readonly string[];

export interface CrownBuildResult {
  readonly picks: readonly CrownCandidate[] | null;
  readonly issues: readonly string[];
  readonly reserves?: readonly CrownCandidate[];
  readonly requestedSize?: number;
}

export interface SelectionStore {
  save(selection: SavedSelection): Promise<void>;
  getById(id: string): Promise<SavedSelection | null>;
}

export interface GradeResult {
  readonly selectionId: string;
  readonly outcome: SavedSelection['grade'];
  readonly observedValue: number | null;
  readonly gradedAt: string;
  readonly source: string;
}

export interface Grader {
  grade(selection: SavedSelection): Promise<GradeResult>;
}

export interface BoardStore {
  put(board: Board, analyses: readonly Analysis[], rankedLineIds: readonly string[]): Promise<void>;
}
