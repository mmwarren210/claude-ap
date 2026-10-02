import { ModelRegistry } from '../registry.js';
import { marketDefinitions } from './definitions.js';
import { lessAwareDefinition } from './less-aware.js';
import { createMarketModule } from './scoring.js';

export { marketDefinitions, statHistoryReadyVersions } from './definitions.js';
export type { MarketDefinition } from './definitions.js';
export { createMarketModule } from './scoring.js';
export { flipsForLess, lessAwareDefinition, lessAwareVersion, reliabilityFactors } from './less-aware.js';

export function createGkrRegistry(approvedVersions: readonly string[] = []): ModelRegistry {
  const registry = new ModelRegistry();
  const approved = new Set(approvedVersions);
  for (const definition of marketDefinitions) {
    // The LESS-aware variant replaces the current model only when its exact version is approved.
    const lessAware = lessAwareDefinition(definition);
    registry.register(approved.has(lessAware.version) ? createMarketModule(lessAware, true)
      : createMarketModule(definition, approved.has(definition.version)));
  }
  return registry;
}
