import { autoResolveNflverseMapping, nflverseTrackedMarkets, NflverseResultsFeed,
  readNflverseMappings, trackedResultFromNflverse } from './nflverse-results.js';
import { ProductLedger } from './product-ledger.js';
import type { ResultFact } from './product-ledger.js';

export interface ProductGradingStatus {
  running:boolean;
  scheduled:boolean;
  intervalMs:number|null;
  lastStartedAt:string|null;
  lastFinishedAt:string|null;
  nextRunAt:string|null;
  lastResult:{graded:number;pending:number}|null;
  lastError:string|null;
}

/** Optional periodic grader. No Odds API, no mobile requests, no inferred DNP/zero. */
const seasonFor=(iso:string)=>{const date=new Date(iso),year=date.getUTCFullYear(),month=date.getUTCMonth()+1;
  return month<=2?year-1:year;};
const errorCode=(error:unknown)=>error instanceof Error?error.message:'UNKNOWN_GRADING_ERROR';

export class ProductGradingWorker {
  private running=false;
  private timer:ReturnType<typeof setInterval>|null=null;
  private intervalMs:number|null=null;
  private lastStartedAt:string|null=null;
  private lastFinishedAt:string|null=null;
  private nextRunAt:string|null=null;
  private lastResult:{graded:number;pending:number}|null=null;
  private lastError:string|null=null;
  constructor(private readonly ledger:ProductLedger,private readonly mappingPath:string|null=null,
    private readonly feed:NflverseResultsFeed=new NflverseResultsFeed(),
    private readonly clock:()=>Date=()=>new Date()){}
  status():ProductGradingStatus{return {
    running:this.running,scheduled:this.timer!==null,intervalMs:this.intervalMs,
    lastStartedAt:this.lastStartedAt,lastFinishedAt:this.lastFinishedAt,nextRunAt:this.nextRunAt,
    lastResult:this.lastResult?{...this.lastResult}:null,lastError:this.lastError,
  };}
  start(intervalMs=60*60_000){
    if(this.timer)return;
    this.intervalMs=intervalMs;
    this.nextRunAt=new Date(this.clock().getTime()+intervalMs).toISOString();
    this.timer=setInterval(()=>{void this.runOnce().catch(()=>undefined);},intervalMs);
    this.timer.unref?.();
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;this.intervalMs=null;this.nextRunAt=null;}
  async runOnce(){
    if(this.running)return {graded:0,pending:0};
    this.running=true;this.lastStartedAt=this.clock().toISOString();
    try {
      const pending=[];
      for(let offset=0;;offset+=500){
        const page=await this.ledger.listDecisions(offset,500);
        pending.push(...page.decisions.filter((item)=>item.grade==='PENDING' && item.sport==='NFL' &&
          nflverseTrackedMarkets.includes(item.market)));
        if(offset+500>=page.total)break;
      }
      if(!pending.length){
        const result={graded:0,pending:0};this.lastResult=result;this.lastError=null;return result;
      }
      const now=this.clock(),mappings=this.mappingPath?await readNflverseMappings(this.mappingPath):[],
        map=new Map(mappings.map((item)=>[JSON.stringify([item.eventId,item.playerId]),item])),
        manual=pending.flatMap((decision)=>{
          const mapping=map.get(JSON.stringify([decision.eventId,decision.playerId]));
          return mapping&&Date.parse(mapping.completedAt)<=now.getTime()? [{decision,mapping}]:[];
        }),
        unresolved=pending.filter((decision)=>!map.has(JSON.stringify([decision.eventId,decision.playerId]))&&
          now.getTime()>=Date.parse(decision.lineSnapshot.eventStartTime)+6*60*60_000);
      const seasons=[...new Set([
        ...manual.map((item)=>item.mapping.season),
        ...unresolved.map((decision)=>seasonFor(decision.lineSnapshot.eventStartTime)),
      ])];
      const stats=new Map(await Promise.all(seasons.map(async(season)=>[season,
        await this.feed.fetchSeason(season)] as const)));
      let automatic:typeof manual=[];
      if(unresolved.length){
        try{
          const schedules=await this.feed.fetchSchedule();
          automatic=unresolved.flatMap((decision)=>{
            const season=seasonFor(decision.lineSnapshot.eventStartTime),rows=stats.get(season);
            const mapping=rows?autoResolveNflverseMapping(decision.lineSnapshot,schedules,rows,now):null;
            return mapping?[{decision,mapping}]:[];
          });
        }catch{automatic=[];}
      }
      const pair=[...manual,...automatic];
      const facts=pair.flatMap(({decision,mapping})=>{
        const rows=stats.get(mapping.season);
        const result=rows?trackedResultFromNflverse(decision.lineSnapshot,mapping,rows,now):null;
        return result?[{eventId:result.eventId,playerId:result.playerId,market:result.market,
          status:result.status,actual:result.observedValue,sourceName:result.sourceName,
          sourceUrl:result.sourceUrl,completedAt:result.completedAt} satisfies ResultFact]:[];
      });
      const unique=[...new Map(facts.map((fact)=>[JSON.stringify([fact.eventId,
        fact.playerId,fact.market]),fact])).values()];
      const graded=unique.length?await this.ledger.grade(unique):{graded:0};
      const result={graded:graded.graded,pending:pending.length-graded.graded};
      this.lastResult=result;this.lastError=null;return result;
    }catch(error){
      this.lastError=errorCode(error);throw error;
    }finally{
      this.lastFinishedAt=this.clock().toISOString();this.running=false;
      if(this.timer&&this.intervalMs!==null)
        this.nextRunAt=new Date(this.clock().getTime()+this.intervalMs).toISOString();
    }
  }
}
