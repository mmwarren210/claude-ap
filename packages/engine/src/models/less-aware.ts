import type { MarketDefinition } from './definitions.js';

/**
 * Factors that measure how reliable a read is rather than how much the player will produce.
 * A steady role or clean evidence helps a MORE and a LESS pick alike, so these keep their
 * meaning on both sides. Every other factor reads "observed above reference = more output",
 * which favors MORE and, in a LESS-aware version, counts against LESS.
 */
export const reliabilityFactors: ReadonlySet<string> = new Set([
  'evidence_quality', 'stability', 'stability_risk', 'recent_hs_stability', 'recent_serve_stability',
]);

/** Does this factor's favorable side flip for a LESS pick? */
export const flipsForLess = (factorKey: string) => !reliabilityFactors.has(factorKey);

/** The LESS-aware version id: the same model with its minor version raised by one (1.3 to 1.4). */
export function lessAwareVersion(version: string): string {
  const match = /^(.*-)(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error('UNVERSIONED_MODEL:' + version);
  return `${match[1]}${match[2]}.${Number(match[3]) + 1}`;
}

/** The opt-in LESS-aware variant of a market model. Thresholds and gates are unchanged. */
export function lessAwareDefinition(definition: MarketDefinition): MarketDefinition {
  return { ...definition, version: lessAwareVersion(definition.version), lessAware: true };
}
