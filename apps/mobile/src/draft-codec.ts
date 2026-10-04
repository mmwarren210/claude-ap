import { propLineSchema } from '@crowniq/contracts';
import { z } from 'zod';
import { emptyFilters } from './state';
import type { CrownLeg, Filters, TipId, ViewMode } from './state';

const filterSchema=z.object({sport:z.string(),market:z.string(),direction:z.string(),
  grade:z.string(),lineType:z.string(),evidence:z.string(),date:z.string()});
const tipIdSchema=z.enum(['NO_SCORE','AGAINST_MODEL','LOW_SCORE','STALE_EVIDENCE','TEAM_STACK','WEAKER_TICKET']);
const draftSchema=z.object({filters:filterSchema,legs:z.array(z.object({line:propLineSchema,
  direction:z.enum(['MORE','LESS']),score:z.number().nullable(),modelVersion:z.string().nullable(),
  yourCall:z.array(tipIdSchema).optional()})),
  viewMode:z.enum(['LITE','FULL']).default('LITE'),
  /** Tips the user chose not to see again. */
  hiddenTips:z.array(tipIdSchema).default([])});
export type Draft={filters:Filters;legs:CrownLeg[];viewMode:ViewMode;hiddenTips:TipId[]};
export const profileDraftKey=(profileId:string)=>`draft-${profileId}`;
export function parseDraft(value:unknown):Draft {
  const result=draftSchema.safeParse(value);
  return result.success?result.data:{filters:{...emptyFilters},legs:[],viewMode:'LITE',hiddenTips:[]};
}
