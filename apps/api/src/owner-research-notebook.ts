/** Private research notebook. Neither snapshots nor owner edits are GKR evidence. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { StatApiOwnerError, StatApiOwnerResearch } from './stat-api-owner-research.js';
import type { StatApiSport } from './stat-api-owner-research.js';

type Detail = Awaited<ReturnType<StatApiOwnerResearch['inspect']>>;
const sportSchema=z.enum(['NFL','NBA','MLB','PGA']);
const detailSchema=z.object({sport:sportSchema,player:z.object({id:z.number().int().positive(),
  name:z.string(),teamId:z.number().int().positive().nullable()}),table:z.string(),
  sourceUrl:z.url(),retrievedAt:z.iso.datetime(),nextFromId:z.number().nullable(),
  sampleOnly:z.literal(true),officialStatusConfirmed:z.literal(false),
  rows:z.array(z.object({gameId:z.number().nullable(),tournamentId:z.number().nullable(),
    occurredAt:z.iso.datetime().nullable().optional(),
    metrics:z.record(z.string(),z.number())})).max(40)});
const entrySchema=z.object({key:z.string(),sport:sportSchema,playerId:z.number().int().positive(),
  table:z.string(),playerName:z.string(),watching:z.boolean(),addedAt:z.iso.datetime(),
  lastAttemptAt:z.iso.datetime().nullable(),lastSuccessfulAt:z.iso.datetime().nullable(),
  lastError:z.string().nullable(),detail:detailSchema.nullable(),notes:z.string().max(2000),
  independentSources:z.array(z.url().startsWith('https://')).max(5),reviewed:z.boolean()});
const fileSchema=z.object({version:z.literal(1),updatedAt:z.iso.datetime(),
  entries:z.array(entrySchema).max(100)});
const importSchema=z.object({version:z.literal(1),entries:z.array(z.object({key:z.string(),
  notes:z.string().max(2000),independentSources:z.array(z.url().startsWith('https://')).max(5),
  reviewed:z.boolean(),lastSuccessfulAt:z.iso.datetime().nullable()}).passthrough()).max(100)}).passthrough();

export function researchKey(sport:StatApiSport,playerId:number,table:string){
  return `${sport}/${playerId}/${table}`;
}

export class OwnerResearchNotebook {
  private file:z.infer<typeof fileSchema>;
  private writes=Promise.resolve();
  private timer:ReturnType<typeof setInterval>|null=null;
  private refreshPromise:Promise<unknown>|null=null;
  private lastRunAt:string|null=null;
  private lastRunError:string|null=null;

  constructor(private readonly path:string,private readonly provider:StatApiOwnerResearch,
    private readonly minutes=60,private readonly clock:()=>Date=()=>new Date()){
    if(!Number.isInteger(minutes)||minutes<15||minutes>1440)
      throw new Error('INVALID_OWNER_RESEARCH_REFRESH_INTERVAL');
    this.file={version:1,updatedAt:this.clock().toISOString(),entries:[]};
  }
  async load(){
    try{this.file=fileSchema.parse(JSON.parse(await readFile(this.path,'utf8')));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  private async save(){
    this.file.updatedAt=this.clock().toISOString();
    const payload=JSON.stringify(fileSchema.parse(this.file));
    this.writes=this.writes.catch(()=>undefined).then(async()=>{
      await mkdir(dirname(this.path),{recursive:true,mode:0o700});
      const temp=`${this.path}.${randomUUID()}.tmp`;
      try{await writeFile(temp,payload,{mode:0o600});await rename(temp,this.path);}
      finally{await rm(temp,{force:true});}
    });
    await this.writes;
  }
  status(){return {watched:this.file.entries.filter((entry)=>entry.watching).length,
    saved:this.file.entries.length,autoRefreshMinutes:this.minutes,
    running:this.refreshPromise!==null,lastRunAt:this.lastRunAt,lastRunError:this.lastRunError};}
  export(){return structuredClone({...this.file,scope:'OWNER_PERSONAL_RESEARCH',
    canPublishToUsers:false,exportedAt:this.clock().toISOString()});}
  start(){
    if(this.timer)return;
    this.timer=setInterval(()=>{void this.refreshAll().catch(()=>undefined);},this.minutes*60_000);
    this.timer.unref();
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}

  async watch(sport:StatApiSport,playerId:number,table:string){
    const key=researchKey(sport,playerId,table);
    if(this.file.entries.length>=100 && !this.file.entries.some((item)=>item.key===key))
      throw new StatApiOwnerError('RESEARCH_WATCHLIST_FULL',409);
    const detail=await this.provider.inspect(sport,playerId,table);
    let entry=this.file.entries.find((item)=>item.key===key);
    if(!entry){
      entry={key,sport,playerId,table,playerName:detail.player.name,watching:true,
        addedAt:this.clock().toISOString(),lastAttemptAt:null,lastSuccessfulAt:null,
        lastError:null,detail:null,notes:'',independentSources:[],reviewed:false};
      this.file.entries.push(entry);
    }
    entry.watching=true;
    this.record(entry,detail);
    await this.save();
    return {entry};
  }
  private record(entry:z.infer<typeof entrySchema>,detail:Detail){
    if(entry.detail?.retrievedAt!==detail.retrievedAt)entry.reviewed=false;
    entry.lastAttemptAt=this.clock().toISOString();
    entry.lastSuccessfulAt=detail.retrievedAt;
    entry.playerName=detail.player.name;
    entry.detail=detail;
    entry.lastError=null;
  }
  async unwatch(key:string){
    const entry=this.file.entries.find((item)=>item.key===key);
    if(!entry)throw new StatApiOwnerError('RESEARCH_ITEM_NOT_FOUND',404);
    entry.watching=false;await this.save();return {entry};
  }
  async importAnnotations(input:unknown){
    const parsed=importSchema.safeParse(input);
    if(!parsed.success)throw new StatApiOwnerError('INVALID_RESEARCH_ANNOTATIONS',400);
    const ids=parsed.data.entries.map((item)=>item.key);
    if(new Set(ids).size!==ids.length || ids.some((key)=>!this.file.entries.some((e)=>e.key===key)))
      throw new StatApiOwnerError('UNKNOWN_RESEARCH_ITEM',400);
    if(parsed.data.entries.some((update)=>update.reviewed &&
      this.file.entries.find((item)=>item.key===update.key)?.lastSuccessfulAt!==update.lastSuccessfulAt))
      throw new StatApiOwnerError('STALE_RESEARCH_ANNOTATION',409);
    for(const update of parsed.data.entries){
      const entry=this.file.entries.find((item)=>item.key===update.key)!;
      entry.notes=update.notes;entry.independentSources=update.independentSources;
      entry.reviewed=update.reviewed;
    }
    await this.save();
    return {updated:ids.length,providerSnapshotsChanged:false,gkrEvidenceCreated:false};
  }
  async refreshAll():Promise<{updated:number;failed:number;skipped:boolean}>{
    if(this.refreshPromise)return this.refreshPromise as Promise<{updated:number;failed:number;skipped:boolean}>;
    const task=(async()=>{
      let updated=0,failed=0;
      for(const entry of this.file.entries.filter((item)=>item.watching)){
        entry.lastAttemptAt=this.clock().toISOString();
        try{this.record(entry,await this.provider.inspect(entry.sport,entry.playerId,entry.table));updated++;}
        catch(error){entry.lastError=error instanceof StatApiOwnerError?error.code:'STAT_API_UNAVAILABLE';failed++;
          if(error instanceof StatApiOwnerError && error.status===429)break;}
        await this.save();
      }
      this.lastRunAt=this.clock().toISOString();
      this.lastRunError=failed?`${failed} item(s) could not be refreshed`:null;
      return {updated,failed,skipped:updated+failed===0};
    })();
    this.refreshPromise=task;
    try{return await task;}
    finally{this.refreshPromise=null;}
  }
}
