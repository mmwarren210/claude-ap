// Synthetic worked examples: these are acceptance inputs, never live player claims.
import type { Evidence, PropLine, Sport } from '@crowniq/contracts';
import { evidenceSchema, propLineSchema } from '@crowniq/contracts';

export interface WorkedExample {
  readonly id: string;
  readonly inputLine: { sport: Sport; market: string; playerName: string; threshold: number;
    league?: string; opponent?: string; lineType?: PropLine['lineType'] };
  readonly researchPlan: { sources: readonly string[]; required: readonly string[];
    important: readonly string[]; optional: readonly string[]; ttlHours: Readonly<Record<string,number>> };
  readonly evidenceFound: Readonly<Record<string, string | number>>;
  readonly evidenceMissing: readonly string[];
  readonly componentEffects: Readonly<Record<string,string | number>>;
  readonly expectedBehavior: { readonly status: 'READY' | 'DOWNGRADED' | 'PASS';
    readonly missingRequired?: string; readonly note: string };
  readonly modelVersion: string | null;
}

export const at = new Date('2030-09-24T12:00:00Z');
export function lineFor(example: WorkedExample, overrides: Partial<PropLine> = {}): PropLine {
  return propLineSchema.parse({ id: example.id, sourceLineId: example.id, provider:'prizepicks',
    sport:example.inputLine.sport, league:example.inputLine.league ?? example.inputLine.sport,
    eventId:`event-${example.id}`,eventName:`Synthetic ${example.id} event`,
    eventStartTime:'2030-09-25T00:00:00Z',playerId:`player-${example.id}`,
    playerName:example.inputLine.playerName,team:'TEST',opponent:example.inputLine.opponent ?? 'OPP',
    market:example.inputLine.market,threshold:example.inputLine.threshold,
    availableDirections:['MORE','LESS'],lineType:example.inputLine.lineType ?? 'REGULAR',
    fetchedAt:at.toISOString(),...overrides });
}

/** Populate only fields explicitly named by the independent acceptance fixture. */
export function evidenceFor(example: WorkedExample, line: PropLine = lineFor(example)): Evidence[] {
  return [...example.researchPlan.required,...example.researchPlan.important,
    ...example.researchPlan.optional].filter((kind) =>
      !example.evidenceMissing.includes(kind) && Object.hasOwn(example.evidenceFound, kind))
    .map((kind, index) => {
      const value = example.evidenceFound[kind];
      return evidenceSchema.parse({ id:`${example.id}-${index}`,entityType:'PLAYER',
        entityId:line.playerId,eventId:line.eventId,market:line.market,kind,
        finding:typeof value === 'string' ? `Synthetic: ${value}` : 'Synthetic acceptance fixture.',
        sourceName:example.researchPlan.sources[0],sourceUrl:null,sourceType:'OFFICIAL',
        retrievedAt:at.toISOString(),expiresAt:'2030-09-25T00:00:00Z',
        quality:'HIGH',confidence:1,
        ...(kind.startsWith('status:') ? {numeric:{value:typeof value === 'number' ? value : 1}} :
          typeof value === 'number' ? {numeric:{value,baseline:1}} : {}) });
    });
}
