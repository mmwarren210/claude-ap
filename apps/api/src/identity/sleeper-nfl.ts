import type { ResearchTarget } from '@crowniq/engine';
import { NFL_TEAMS } from '../current-context.js';
import { JsonCache, normalizeName } from './types.js';
import type { IdentityMatch, PlayerIdentitySource } from './types.js';

const PLAYERS = 'https://api.sleeper.app/v1/players/nfl';
type Entry = { id: string; team: string | null };

/** NFL team and headshot from Sleeper's public player file (one cached download for the whole league). */
export class SleeperNflIdentitySource implements PlayerIdentitySource {
  readonly id = 'sleeper-nfl';
  private index: { built: unknown; byName: Map<string, Entry[]> } | null = null;
  constructor(private readonly cache: JsonCache) {}

  supports(target: ResearchTarget): boolean {
    return target.sport === 'NFL' && !!target.homeTeam && !!target.awayTeam;
  }

  private async byName(): Promise<Map<string, Entry[]>> {
    const raw = await this.cache.get(PLAYERS, 3600_000);
    const index = this.index;
    if (index && index.built === raw) return index.byName;
    const byName = new Map<string, Entry[]>();
    for (const [id, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      const player = value as { full_name?: string | null; first_name?: string | null;
        last_name?: string | null; team?: string | null } | null;
      const full = (player?.full_name ?? [player?.first_name, player?.last_name].filter(Boolean).join(' ')).trim();
      if (!full) continue;
      const key = normalizeName(full);
      byName.set(key, [...(byName.get(key) ?? []), { id, team: NFL_TEAMS[(player?.team ?? '').toUpperCase()] ?? null }]);
    }
    this.index = { built: raw, byName };
    return byName;
  }

  async resolve(target: ResearchTarget): Promise<IdentityMatch | null> {
    const sides = [target.homeTeam, target.awayTeam].filter((side): side is string => !!side);
    const matches = ((await this.byName()).get(normalizeName(target.playerName)) ?? [])
      .filter((entry) => entry.team && sides.includes(entry.team));
    if (matches.length !== 1) return null;
    return { team: matches[0].team, photoUrl: `https://sleepercdn.com/content/nfl/players/${encodeURIComponent(matches[0].id)}.jpg`,
      sourceName: 'Sleeper public NFL player feed', sourceUrl: PLAYERS, sourceType: 'PUBLIC', confidence: 0.8 };
  }
}
