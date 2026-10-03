import type { PlayableDirection } from '@crowniq/contracts';

export type DfsApp = 'prizepicks' | 'underdog' | 'pick6';
export type ScrapedTier = 'REGULAR' | 'GOBLIN' | 'DEMON';

/** One pick'em line as a scraper reported it, in a source-neutral shape. */
export interface ScrapedLine {
  readonly app: DfsApp;
  /** The app's own id for this line (stable while the line is up, even when its number moves). */
  readonly appLineId: string;
  /** The app's league label, e.g. NFL, CFB, SOCCER. */
  readonly league: string;
  readonly gameId: string;
  readonly player: string;
  /** Team abbreviation as the app shows it, and the team's display name when given. */
  readonly team: string | null;
  readonly teamName: string | null;
  readonly opponent: string | null;
  /** The app's stat label, e.g. "Rec Yards". */
  readonly stat: string;
  /** The model market key, when the source already gives one (the Odds API does). */
  readonly marketKey?: string | null;
  readonly line: number;
  readonly tier: ScrapedTier;
  readonly directions: readonly PlayableDirection[];
  readonly startTime: string;
  readonly imageUrl: string | null;
  /** The game's home and away teams (abbreviation and name), when the source says which is which. */
  readonly home?: TeamSide | null;
  readonly away?: TeamSide | null;
  /** Payout multipliers per side, when the source gives them. */
  readonly multipliers?: Partial<Record<PlayableDirection, number>> | null;
}

export interface TeamSide { readonly abbreviation: string; readonly name: string | null }

export type ReadResult<Skip extends string = string> = { line: ScrapedLine } | { skip: Skip };

/** One Apify scraper: which actor, what to ask it for, and how to read a row it returns. */
export interface ScraperSource {
  readonly id: string;
  /** The Apify actor to run; sources without one fetch through `run`. */
  readonly actor: string | null;
  /** Fetch without Apify (for example The Odds API). Its cost is in that service's own credits, not Apify USD. */
  run?(): Promise<{ rows: unknown[]; complete: boolean }>;
  readonly apps: readonly DfsApp[];
  input(): unknown;
  /** Rows at or above this mean the run was cut short (the actor's own hard cap), or null if uncapped. */
  readonly rowCap: number | null;
  read(row: unknown, now: Date): ReadResult;
}
