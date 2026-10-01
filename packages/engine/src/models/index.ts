import { ModelRegistry } from '../registry.js';
import { marketDefinitions } from './definitions.js';
import { createMarketModule } from './scoring.js';

export { marketDefinitions, statHistoryReadyVersions } from './definitions.js';
export type { MarketDefinition } from './definitions.js';
export { createMarketModule } from './scoring.js';

export function createGkrRegistry(approvedVersions: readonly string[] = []): ModelRegistry {
  const registry = new ModelRegistry();
  const approved = new Set(approvedVersions);
  for (const definition of marketDefinitions) {
    registry.register(createMarketModule(definition, approved.has(definition.version)));
  }
  return registry;
}
