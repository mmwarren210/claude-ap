import type { Evidence } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from '@crowniq/engine';

// Stat API history in the 15-minute research loop (owner, 2026-10-05: the paid Stat API must feed GKR, not only the four
// board pulls). Players in games starting soon go first; each player is looked up at most once per cooldown, so a player
// whose history never fills (a rookie) can't burn the daily records every refresh. The data is the same history Second
// Look already uses; model math is unchanged.

export interface StatApiContextOptions {
  /** Only games starting within this many hours. */
  readonly windowHours?: number;
  /** A player is looked up again only after this many hours. */
  readonly cooldownHours?: number;
  /** Most players per refresh. */
  readonly maxPlayers?: number;
  readonly clock?: () => Date;
}

export class StatApiContextResearch implements ResearchAdapter {
  readonly id = 'stat-api-context';
  private readonly lastLooked = new Map<string, number>();
  private health: ResearchHealth = { status: 'OK', targets: 0, searches: 0, cacheHits: 0, skipped: 0, failures: 0,
    noSources: 0, lastRunAt: null };

  constructor(private readonly inner: ResearchAdapter, private readonly options: StatApiContextOptions = {}) {}

  supports(target: ResearchTarget): boolean { return this.inner.supports?.(target) ?? true; }
  getHealth(): ResearchHealth { return this.inner.getHealth?.() ?? this.health; }

  async research(targets: readonly ResearchTarget[]): Promise<readonly Evidence[]> {
    const now = (this.options.clock ?? (() => new Date()))().getTime();
    const window = (this.options.windowHours ?? 36) * 3600_000, cooldown = (this.options.cooldownHours ?? 6) * 3600_000;
    const key = (target: ResearchTarget) => `${target.sport}|${target.playerId}`;
    const soon = targets.filter((target) => this.supports(target) && Date.parse(target.eventStartTime) > now &&
      Date.parse(target.eventStartTime) - now <= window && now - (this.lastLooked.get(key(target)) ?? 0) >= cooldown)
      .sort((a, b) => a.eventStartTime.localeCompare(b.eventStartTime));
    const players: string[] = [];
    for (const target of soon) if (!players.includes(key(target))) players.push(key(target));
    const chosen = new Set(players.slice(0, this.options.maxPlayers ?? 300));
    const selected = soon.filter((target) => chosen.has(key(target)));
    this.health = { ...this.health, targets: targets.length, skipped: targets.length - selected.length,
      lastRunAt: new Date(now).toISOString() };
    if (!selected.length) return [];
    for (const player of chosen) this.lastLooked.set(player, now);
    if (this.lastLooked.size > 50_000) this.lastLooked.clear();
    const evidence = await this.inner.research(selected);
    console.log(`[stat-context] ${chosen.size} players, ${selected.length} lines, ${evidence.length} findings`);
    return evidence;
  }
}
