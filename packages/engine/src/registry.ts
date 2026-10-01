import type { PropLine, Sport } from '@crowniq/contracts';
import type { ModelModule } from './interfaces.js';

export class ModelRegistry {
  private readonly modules = new Map<string, ModelModule>();

  register(module: ModelModule): void {
    if (!module.version.trim() || !module.market.trim()) throw new Error('Model version and market are required');
    const key = this.key(module.sport, module.market);
    if (this.modules.has(key)) throw new Error('Model already registered: ' + key);
    this.modules.set(key, module);
  }

  resolve(line: Pick<PropLine, 'sport' | 'market'>): ModelModule | null {
    return this.modules.get(this.key(line.sport, line.market)) ?? null;
  }

  versions(): Readonly<Record<string, string>> {
    return Object.fromEntries([...this.modules].map(([key, module]) => [key, module.version]));
  }

  requirements(): Readonly<Record<string, { readonly version: string;
    readonly approved: boolean; readonly required: readonly string[];
    readonly hardRequired: readonly string[]; readonly recommended: readonly string[] }>> {
    return Object.fromEntries([...this.modules].map(([key, module]) => [key, {
      version: module.version, approved: module.calibrationApproved === true,
      required: module.requiredEvidenceKinds,
      hardRequired: module.hardRequiredEvidenceKinds ?? module.requiredEvidenceKinds,
      recommended: module.recommendedEvidenceKinds ?? [],
    }]));
  }

  private key(sport: Sport, market: string): string {
    return sport + ':' + market.trim().toLowerCase();
  }
}
