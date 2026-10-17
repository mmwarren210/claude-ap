import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { throttledSave } from './throttled-save.js';
import { dirname } from 'node:path';
import { boardSchema, evidenceSchema, secondLookAuditSchema } from '@crowniq/contracts';
import type { Board, Evidence, SecondLookAudit } from '@crowniq/contracts';
import { z } from 'zod';

const common={board:boardSchema,evidence:z.array(evidenceSchema),
  researchStatus:z.enum(['UNCONFIGURED','OK','PARTIAL','FAILED']),
  lastSuccessfulRefresh:z.iso.datetime({offset:true}).nullable()};
const cacheV1=z.object({version:z.literal(1),...common}).strict();
const cacheV2=z.object({version:z.literal(2),...common,
  secondLookAudits:z.record(z.string(),secondLookAuditSchema)}).strict();
const cacheSchema=z.union([cacheV2,cacheV1]);
export type SavedBoard={board:Board;evidence:Evidence[];
  researchStatus:'UNCONFIGURED'|'OK'|'PARTIAL'|'FAILED';lastSuccessfulRefresh:string|null;
  secondLookAudits?:Record<string,SecondLookAudit>};

/** The last validated provider board survives server restarts. A read cannot refresh odds. */
export class BoardCache {
  /** `saveEveryMs`: shortest gap between board saves (the server passes 5 minutes; 0 saves every time). */
  constructor(private readonly path:string,saveEveryMs=0){
    this.saver=throttledSave(async()=>{const next=this.latest;if(next)await this.saveNow(next);},saveEveryMs);
  }
  async load():Promise<SavedBoard|null>{
    try{
      const parsed=cacheSchema.parse(JSON.parse(await readFile(this.path,'utf8')));
      return parsed.version===1?{...parsed,secondLookAudits:{}}:parsed;
    }
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  // The newest board is saved at most every 5 minutes (owner, 2026-10-17): checking and writing the 70-80 MB board after
  // every change froze the server for seconds each time. A restart in between reopens the last saved board.
  private latest:SavedBoard|null=null;
  private readonly saver:ReturnType<typeof throttledSave>;
  async save(snapshot:SavedBoard){this.latest=snapshot;await this.saver.save();}
  private async saveNow(snapshot:SavedBoard){
    const contents=JSON.stringify(cacheV2.parse({version:2,...snapshot,
      secondLookAudits:snapshot.secondLookAudits??{}}));
    await mkdir(dirname(this.path),{recursive:true});
    const temporary=`${this.path}.${randomUUID()}.tmp`;
    try{await writeFile(temporary,contents,{mode:0o600});await rename(temporary,this.path);}
    finally{await rm(temporary,{force:true});}
  }
}
