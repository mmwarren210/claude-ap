import { propLineSchema } from '@crowniq/contracts';
import { z } from 'zod';
import { emptyFilters } from './state';
import type { CrownLeg, Filters, ViewMode } from './state';

const filterSchema=z.object({sport:z.string(),market:z.string(),direction:z.string(),
  grade:z.string(),lineType:z.string(),evidence:z.string(),date:z.string()});
const draftSchema=z.object({filters:filterSchema,legs:z.array(z.object({line:propLineSchema,
  direction:z.enum(['MORE','LESS']),score:z.number(),modelVersion:z.string()})),
  viewMode:z.enum(['LITE','FULL']).default('LITE')});
export type Draft={filters:Filters;legs:CrownLeg[];viewMode:ViewMode};
export const profileDraftKey=(profileId:string)=>`draft-${profileId}`;
export function parseDraft(value:unknown):Draft {
  const result=draftSchema.safeParse(value);
  return result.success?result.data:{filters:{...emptyFilters},legs:[],viewMode:'LITE'};
}
