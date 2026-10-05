import type { Evidence } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from '@crowniq/engine';
import type { PlayerHistory } from './player-history.js';
import { twoMaps } from './player-history.js';
import { historyEvidence } from './stat-api-gkr-evidence.js';

// GKR evidence for CS2 and tennis from player history (owner approved 2026-10-05, stat-history set 3): the projection,
// recent form against the larger sample, and stability, read from each player's recent results for the exact stat
// (Sleeper's recent performance, ESPN set scores). No line is used. Per-map rows never stand in for a two-map line.

export class FreeHistoryEvidence implements ResearchAdapter {
  readonly id = 'free-history-v1';
  private readonly allowed: ReadonlySet<string>;
  private health: ResearchHealth = { status: 'OK', targets: 0, searches: 0, cacheHits: 0, skipped: 0, failures: 0, lastRunAt: null };
  constructor(private readonly history: PlayerHistory, allowedKeys: readonly string[],
    private readonly clock: () => Date = () => new Date()) {
    this.allowed = new Set(allowedKeys.filter((key) => key.startsWith('CS2:') || key.startsWith('TENNIS:')));
  }
  getHealth(): ResearchHealth { return this.health; }
  supports(target: ResearchTarget): boolean {
    return this.allowed.has(`${target.sport}:${target.market}`) && Date.parse(target.eventStartTime) > this.clock().getTime();
  }
  async research(targets: readonly ResearchTarget[]): Promise<readonly Evidence[]> {
    const now = this.clock(), evidence: Evidence[] = [];
    let skipped = 0, noSources = 0, failures = 0;
    for (const target of targets) {
      if (!this.supports(target)) { skipped++; continue; }
      try {
        const found = await this.history.values(target.sport, target.playerName, target.market);
        if (!found || (found.perMap && twoMaps(target.market))) { noSources++; continue; }
        const rows = found.values.map((game) => ({ occurredAt: new Date(game.date).toISOString(), metrics: { value: game.value } }));
        const value = (row: { metrics: Readonly<Record<string, number>> }) => Number.isFinite(row.metrics.value) ? row.metrics.value : null;
        evidence.push(...historyEvidence(target, { value, unit: target.market.replace(/_/g, ' '), factors: { historical_volume: value } },
          { sourceUrl: found.url, retrievedAt: now.toISOString(), rows }, now,
          { minSamples: 5, recentSamples: 15, sourceName: found.source, sourceLabel: found.source, sourceType: 'PUBLIC', idPrefix: 'free:' }));
      } catch { failures++; }
    }
    this.health = { status: failures ? evidence.length ? 'PARTIAL' : 'FAILED' : 'OK', targets: targets.length, searches: 0,
      cacheHits: 0, skipped, failures, noSources, lastRunAt: now.toISOString() };
    return evidence;
  }
}
