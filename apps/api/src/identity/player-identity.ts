import { createHash } from 'node:crypto';
import { evidenceSchema } from '@crowniq/contracts';
import type { Evidence } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from '@crowniq/engine';
import type { IdentityMatch, JsonCache, PlayerIdentitySource } from './types.js';

type SourceHealth = { status: 'OK' | 'PARTIAL' | 'FAILED' | 'SKIPPED'; targets: number; evidence: number;
  failures: number; errorCode?: string | null };

const EVIDENCE_TTL = 30 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

export interface PlayerIdentityOptions {
  readonly clock?: () => Date;
  /** Lookups run this many at a time. */
  readonly concurrency?: number;
  /** No new lookups start after this long, so a slow source never holds up the board. */
  readonly budgetMs?: number;
  /** The sources' shared cache, read only to report request counts. */
  readonly cache?: JsonCache;
}

/**
 * Team and headshot for every player on the board, in every sport a source covers.
 * Sources are tried in order per player until both a team and a photo are known. The team is kept
 * only when it is one of the game's own sides. Emits identity evidence only, which is never scored.
 */
export class PlayerIdentityResearch implements ResearchAdapter {
  readonly id: string;
  private readonly clock: () => Date;
  private readonly concurrency: number;
  private readonly budgetMs: number;
  private readonly cache: JsonCache | null;
  private health: ResearchHealth = { status: 'OK', targets: 0, searches: 0, cacheHits: 0, skipped: 0,
    failures: 0, noSources: 0, lastRunAt: null };

  constructor(private readonly sources: readonly PlayerIdentitySource[], options: PlayerIdentityOptions = {}) {
    this.id = 'player-identity:' + sources.map((source) => source.id).join('+');
    this.clock = options.clock ?? (() => new Date());
    this.concurrency = Math.max(1, options.concurrency ?? 6);
    this.budgetMs = options.budgetMs ?? 25_000;
    this.cache = options.cache ?? null;
  }
  getHealth() { return this.health; }
  supports(target: ResearchTarget): boolean {
    return Date.parse(target.eventStartTime) > this.clock().getTime() &&
      this.sources.some((source) => source.supports(target));
  }

  private evidence(target: ResearchTarget, kind: 'identity:team' | 'identity:photo', finding: string,
    match: IdentityMatch, sourceUrl: string, now: Date): Evidence {
    return evidenceSchema.parse({ id: 'identity:' + hash(JSON.stringify([target.eventId, target.playerId, kind,
      Math.floor(now.getTime() / EVIDENCE_TTL)])), entityType: 'PLAYER', entityId: target.playerId,
      eventId: target.eventId, market: null, kind, finding, sourceName: match.sourceName, sourceUrl,
      sourceType: match.sourceType, retrievedAt: now.toISOString(),
      expiresAt: new Date(Math.min(Date.parse(target.eventStartTime), now.getTime() + EVIDENCE_TTL)).toISOString(),
      quality: match.confidence >= 0.9 ? 'HIGH' : 'MEDIUM', confidence: match.confidence, numeric: { value: 1 } });
  }

  async research(targets: readonly ResearchTarget[]): Promise<readonly Evidence[]> {
    const started = this.clock(), deadline = Date.now() + this.budgetMs;
    const requestsBefore = this.cache?.requests ?? 0, hitsBefore = this.cache?.hits ?? 0;
    // Identity belongs to a player in a game, not to a market.
    const players = [...new Map(targets.filter((target) => this.supports(target))
      .map((target) => [target.eventId + '|' + target.playerId, target])).values()];
    const sources: Record<string, SourceHealth> = {};
    const tally = (id: string, field: 'targets' | 'evidence' | 'failures') => {
      sources[id] ??= { status: 'OK', targets: 0, evidence: 0, failures: 0, errorCode: null };
      sources[id][field]++;
    };
    const out: Evidence[] = [];
    let failures = 0, unresolved = 0, skipped = targets.length - players.length;

    const lookup = async (target: ResearchTarget) => {
      let team: { value: string; match: IdentityMatch } | null = null;
      let photo: { value: string; match: IdentityMatch } | null = null;
      for (const source of this.sources) {
        if (team && photo) break;
        if (!source.supports(target)) continue;
        tally(source.id, 'targets');
        let match: IdentityMatch | null;
        try { match = await source.resolve(target); } catch { tally(source.id, 'failures'); failures++; continue; }
        if (!match) continue;
        const sideOk = !!match.team && (match.team === target.homeTeam || match.team === target.awayTeam);
        if (!team && sideOk) team = { value: match.team!, match };
        if (!photo && match.photoUrl?.startsWith('https://')) photo = { value: match.photoUrl, match };
        if (sideOk || match.photoUrl) tally(source.id, 'evidence');
      }
      const now = this.clock();
      if (team) out.push(this.evidence(target, 'identity:team', team.value, team.match, team.match.sourceUrl, now));
      if (photo) out.push(this.evidence(target, 'identity:photo', 'Player headshot', photo.match, photo.value, now));
      if (!team && !photo) unresolved++;
    };

    const queue = [...players];
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      for (let target = queue.shift(); target; target = queue.shift()) {
        if (Date.now() > deadline) { skipped++; continue; }
        await lookup(target);
      }
    }));
    for (const health of Object.values(sources)) {
      health.status = health.failures ? health.evidence ? 'PARTIAL' : 'FAILED' : 'OK';
      health.errorCode = health.failures ? 'IDENTITY_SOURCE_UNAVAILABLE' : health.evidence ? null : 'NO_MATCHING_PLAYERS';
    }
    this.health = { status: failures ? out.length ? 'PARTIAL' : 'FAILED' : 'OK', targets: players.length,
      searches: (this.cache?.requests ?? 0) - requestsBefore, cacheHits: (this.cache?.hits ?? 0) - hitsBefore, skipped, failures, noSources: unresolved, lastRunAt: started.toISOString(), sources };
    return out;
  }
}
