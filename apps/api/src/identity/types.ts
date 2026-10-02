import type { ResearchTarget } from '@crowniq/engine';

/** What one source knows about a player in one game. Either field may be missing. */
export interface IdentityMatch {
  /** One of the target's own homeTeam/awayTeam strings, exactly as the odds feed names it. */
  readonly team: string | null;
  readonly photoUrl: string | null;
  readonly sourceName: string;
  /** Where the identity was read, for the evidence record. */
  readonly sourceUrl: string;
  readonly sourceType: 'OFFICIAL' | 'PUBLIC' | 'LICENSED_FEED';
  readonly confidence: number;
}

/**
 * One place player identity can come from: a licensed API, a public feed or a scraper.
 * To add one, implement this and list it in `identitySources` (main.ts); the order there is
 * the fallback order. A source must match a player only within the target's two game sides and
 * return null when it cannot tell players apart. Throw only for an outage, never for "not found".
 */
export interface PlayerIdentitySource {
  readonly id: string;
  supports(target: ResearchTarget): boolean;
  resolve(target: ResearchTarget): Promise<IdentityMatch | null>;
}

export const normalizeName = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s+(jr|sr|ii|iii|iv|v)$/, '');

export type TeamNames = { readonly displayName: string; readonly nickname?: string | null;
  readonly location?: string | null; readonly abbreviation?: string | null };

/**
 * Which listed team is this odds-feed side? Exact names win; a nickname suffix
 * ("LA Clippers" for "Los Angeles Clippers") counts only when it points to one team.
 */
export function matchTeam<T extends TeamNames>(side: string, teams: readonly T[]): T | null {
  const wanted = normalizeName(side);
  const exact = teams.filter((team) => [team.displayName,
    team.location && team.nickname ? `${team.location} ${team.nickname}` : null]
    .some((name) => name && normalizeName(name) === wanted));
  if (exact.length === 1) return exact[0];
  const bySuffix = teams.filter((team) => team.nickname && normalizeName(team.nickname).length > 2 &&
    (wanted === normalizeName(team.nickname) || wanted.endsWith(' ' + normalizeName(team.nickname))));
  return bySuffix.length === 1 ? bySuffix[0] : null;
}

/** Small time-boxed JSON cache shared by sources. */
export class JsonCache {
  private entries = new Map<string, { until: number; value: Promise<unknown> }>();
  requests = 0;
  hits = 0;
  constructor(private readonly fetchFn: typeof fetch, private readonly clock: () => Date) {}
  get(url: string, ttlMs: number, maxBytes = 30_000_000): Promise<unknown> {
    const now = this.clock().getTime(), cached = this.entries.get(url);
    if (cached && cached.until > now) { this.hits++; return cached.value; }
    this.requests++;
    const value = (async () => {
      const response = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('IDENTITY_SOURCE_UNAVAILABLE');
      const body = await response.text();
      if (body.length > maxBytes) throw new Error('IDENTITY_SOURCE_TOO_LARGE');
      return JSON.parse(body) as unknown;
    })();
    this.entries.set(url, { until: now + ttlMs, value });
    // A failed request is not cached, so the next run retries it.
    value.catch(() => { if (this.entries.get(url)?.value === value) this.entries.delete(url); });
    return value;
  }
}
