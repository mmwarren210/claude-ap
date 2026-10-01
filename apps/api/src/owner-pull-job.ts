import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const countsSchema=z.object({providerReturned:z.number(),normalized:z.number(),saved:z.number(),
  qualified:z.number(),exposed:z.number()});
export const ownerPullJobSchema=z.object({
  status:z.enum(['IDLE','RUNNING','SUCCEEDED','FAILED']),
  startedAt:z.string().nullable(),finishedAt:z.string().nullable(),error:z.string().nullable(),
  trackingStatus:z.enum(['PENDING','OK','FAILED','UNCONFIGURED']),tracked:z.number().default(0),
  webResearchJob:z.string().nullable(),refreshStage:z.string().default('idle'),counts:countsSchema,
  creditsSpent:z.number().nullable().default(null),creditsRemaining:z.number().nullable().default(null),
});
export type OwnerPullJob=z.infer<typeof ownerPullJobSchema>;

export const idlePullJob=():OwnerPullJob=>({status:'IDLE',startedAt:null,finishedAt:null,error:null,
  trackingStatus:'UNCONFIGURED',tracked:0,webResearchJob:null,refreshStage:'idle',
  counts:{providerReturned:0,normalized:0,saved:0,qualified:0,exposed:0},
  creditsSpent:null,creditsRemaining:null});

/** The last paid pull's record survives restarts so a lost job is reported, never silent. */
export class OwnerPullJobStore {
  constructor(private readonly path:string){}
  async load():Promise<OwnerPullJob|null>{
    try{return ownerPullJobSchema.parse(JSON.parse(await readFile(this.path,'utf8')));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  async save(job:OwnerPullJob):Promise<void>{
    await mkdir(dirname(this.path),{recursive:true});
    const temporary=`${this.path}.${randomUUID()}.tmp`;
    try{await writeFile(temporary,JSON.stringify(job),{mode:0o600});await rename(temporary,this.path);}
    finally{await rm(temporary,{force:true});}
  }
}
