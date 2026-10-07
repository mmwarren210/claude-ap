import { ModelRegistry } from '../registry.js';
import { marketDefinitions } from './definitions.js';
import { lessAwareDefinition } from './less-aware.js';
import { createMarketModule } from './scoring.js';

export { marketDefinitions, statHistoryReadyVersions, statHistoryV2Versions, statHistoryV3Versions, statHistoryV4Versions } from './definitions.js';
export type { MarketDefinition } from './definitions.js';
export { createMarketModule } from './scoring.js';
export { flipsForLess, lessAwareDefinition, lessAwareVersion, reliabilityFactors } from './less-aware.js';

export function createGkrRegistry(approvedVersions: readonly string[] = []): ModelRegistry {
  const registry = new ModelRegistry();
  const approved = new Set(approvedVersions);
  // One model per sport and market: an approved version wins over an unapproved one under the same key (stat-history
  // set 3's CS2 and tennis models over the older placeholders); otherwise the first definition stands.
  const isApproved = (definition: (typeof marketDefinitions)[number]) => approved.has(definition.version) ||
    approved.has(lessAwareDefinition(definition).version);
  const chosen = new Map<string, (typeof marketDefinitions)[number]>();
  for (const definition of marketDefinitions) {
    const key = `${definition.sport}:${definition.market}`, previous = chosen.get(key);
    if (!previous || (!isApproved(previous) && isApproved(definition))) chosen.set(key, definition);
  }
  for (const definition of chosen.values()) {
    // The LESS-aware variant replaces the current model only when its exact version is approved.
    const lessAware = lessAwareDefinition(definition);
    registry.register(approved.has(lessAware.version) ? createMarketModule(lessAware, true)
      : createMarketModule(definition, approved.has(definition.version)));
  }
  return registry;
}
