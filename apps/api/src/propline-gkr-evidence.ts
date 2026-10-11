import type { Evidence } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from '@crowniq/engine';
import type { PropLineHistory } from './propline-history.js';
import { historyEvidence } from './stat-api-gkr-evidence.js';

// GKR evidence from PropLine's box scores (owner, 2026-10-09: PropLine is the source of truth, every model): for an approved
// model's stat, the player's recent PropLine games give the projection, recent form and stability, the same way the free
// history evidence does. It runs in Second Look, so a line the other sources already scored keeps their read.

export class PropLineGkrEvidence implements ResearchAdapter {
  readonly id: string;
  private readonly allowed: ReadonlySet<string>;
  private health: ResearchHealth = { status: 'OK', targets: 0, searches: 0, cacheHits: 0, skipped: 0, failures: 0, lastRunAt: null };
  /**
   * `waitMs`: how long one player may take. GKR's main pass and the context refresh use a short wait (owner, 2026-10-11:
   * every model reads PropLine): players from the nightly pull answer at once, and one still loading is skipped this pass
   * (its request keeps going, so the next refresh has it) instead of holding up the board.
   */
  constructor(private readonly history: PropLineHistory, allowedKeys: readonly string[],
    private readonly clock: () => Date = () => new Date(), private readonly waitMs = 3_000, id = 'propline-history-v1') {
    this.allowed = new Set(allowedKeys); this.id = id;
  }
  getHealth(): ResearchHealth { return this.health; }
  supports(target: ResearchTarget): boolean {
    return this.allowed.has(`${target.sport}:${target.market}`) && Date.parse(target.eventStartTime) > this.clock().getTime();
  }
  async research(targets: readonly ResearchTarget[]): Promise<readonly Evidence[]> {
    const now = this.clock(), evidence: Evidence[] = [];
    let skipped = 0, noSources = 0, failures = 0;
    // Up to 32 players at a time (PropLine requests themselves stay capped by the history client), so players that
    // aren't pulled yet never add their waits up one after another.
    let cursor = 0;
    const one = async (target: ResearchTarget) => {
      if (!this.supports(target)) { skipped++; return; }
      try {
        const found = await this.history.values({ sport: target.sport, eventId: target.eventId, eventStartTime: target.eventStartTime,
          playerName: target.playerName, market: target.market, league: target.league } as never, this.waitMs);
        if (!found || found === 'PENDING') { noSources++; return; }
        // Newest first; the dates aren't kept per value, so each game is spaced a day apart for ordering only.
        const start = Date.parse(target.eventStartTime);
        const rows = found.values.map((value, index) => ({ occurredAt: new Date(start - (index + 1) * 86_400_000).toISOString(), metrics: { value } }));
        const value = (row: { metrics: Readonly<Record<string, number>> }) => Number.isFinite(row.metrics.value) ? row.metrics.value : null;
        evidence.push(...historyEvidence(target, { value, unit: target.market.replace(/_/g, ' '), factors: { historical_volume: value } },
          { sourceUrl: 'https://prop-line.com', retrievedAt: now.toISOString(), rows }, now,
          { minSamples: 5, recentSamples: 15, sourceName: found.source, sourceLabel: found.source, sourceType: 'PUBLIC', idPrefix: 'propline:' }));
      } catch { failures++; }
    };
    await Promise.all(Array.from({ length: Math.min(32, targets.length) }, async () => {
      for (let index = cursor++; index < targets.length; index = cursor++) await one(targets[index]);
    }));
    this.health = { status: failures ? evidence.length ? 'PARTIAL' : 'FAILED' : 'OK', targets: targets.length, searches: 0,
      cacheHits: 0, skipped, failures, noSources, lastRunAt: now.toISOString() };
    return evidence;
  }
}
