import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { fitDispersion, marketProfiles, setLearnedDispersion } from '@crowniq/edge';
import type { DispersionFit, StatRow } from '@crowniq/edge';

// The learned dispersion table (spec §2.1), refit daily from the board players' game rows. It is saved as a versioned file
// (edge-dispersion-v1.json) and applied to every Edge price through `setLearnedDispersion`. Markets are fit one at a time,
// yielding to the event loop between them, so the API keeps answering while it runs.

export const DISPERSION_VERSION = 1;
const MAX_GAMES = 20_000;

interface DispersionFile { version: number; fittedAt: string; markets: Record<string, DispersionFit> }

export class DispersionStore {
  private table: DispersionFile | null = null;
  private running = false;
  constructor(private readonly path: string | null, private readonly clock: () => Date = () => new Date()) {}

  /** Loads the saved table and applies it. */
  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as DispersionFile;
      if (value.version === DISPERSION_VERSION && value.markets) { this.table = value; this.apply(); }
    } catch { /* first run */ }
  }

  private apply() {
    setLearnedDispersion(new Map(Object.entries(this.table?.markets ?? {}).map(([key, fit]) => [key, { phi: fit.phi, psi: fit.psi }])));
  }

  /** Whether the table is missing or older than a day. */
  due(): boolean {
    return !this.running && (!this.table || this.clock().getTime() - Date.parse(this.table.fittedAt) > 86_400_000);
  }

  /** Refits every market with enough player-games from these players' rows (sport → each player's rows). */
  async refit(players: Iterable<{ sport: string; rows: readonly StatRow[] }>): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const values = new Map<string, number[][]>();
      for (const { sport, rows } of players) {
        for (const [key, profile] of Object.entries(marketProfiles)) {
          if (!key.startsWith(sport + ':')) continue;
          const market = key.slice(sport.length + 1), list: number[] = [];
          for (const row of rows) {
            if (profile.stat?.opportunity?.(row.metrics) === 0) continue;
            const value = Number.isFinite(row.marketValues?.[market]) ? row.marketValues![market]! : profile.stat?.value(row.metrics) ?? null;
            if (value !== null && Number.isFinite(value)) list.push(value);
          }
          if (list.length >= 10) { const all = values.get(key); if (all) all.push(list); else values.set(key, [list]); }
        }
      }
      const markets: Record<string, DispersionFit> = {};
      for (const [key, players] of values) {
        await yieldToLoop();
        // Cap the work per market: a stride sample of players keeps the fit fast without biasing it.
        const games = players.reduce((sum, list) => sum + list.length, 0), stride = Math.max(1, Math.ceil(games / MAX_GAMES));
        const fit = fitDispersion(players.filter((_, index) => index % stride === 0), marketProfiles[key]!);
        if (fit) markets[key] = fit;
      }
      this.table = { version: DISPERSION_VERSION, fittedAt: this.clock().toISOString(), markets };
      this.apply();
      if (this.path) {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(`${this.path}.tmp`, JSON.stringify(this.table), { mode: 0o600 });
        await rename(`${this.path}.tmp`, this.path);
      }
      return Object.keys(markets).length;
    } finally { this.running = false; }
  }

  /** The table for owner diagnostics. */
  status() {
    return this.table ? { version: this.table.version, fittedAt: this.table.fittedAt, markets: Object.fromEntries(Object.entries(this.table.markets)
      .map(([key, fit]) => [key, { n: fit.n, players: fit.players, phi: round(fit.phi), psi: round(fit.psi), fittedPhi: round(fit.fittedPhi),
        fittedPsi: round(fit.fittedPsi), defaultPhi: fit.defaultPhi, defaultPsi: fit.defaultPsi, ks: round(fit.ks) }])) } : null;
  }
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;
