import { autoResolveNflverseMapping, nflverseTrackedMarkets, NflverseResultsFeed,
  readNflverseMappings, trackedResultFromNflverse } from './nflverse-results.js';
import type { BoxScoreResults } from './box-score-results.js';
import { ProductLedger } from './product-ledger.js';
import type { ResultFact } from './product-ledger.js';

export interface ProductGradingStatus {
  running:boolean;
  scheduled:boolean;
  intervalMs:number|null;
  lastStartedAt:string|null;
  lastFinishedAt:string|null;
  nextRunAt:string|null;
  lastResult:{graded:number;pending:number;boxScores?:{graded:number;unsupported:number;waiting:number}}|null;
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
  private lastResult:ProductGradingStatus['lastResult']=null;
  private lastError:string|null=null;
  constructor(private readonly ledger:ProductLedger,private readonly mappingPath:string|null=null,
    private readonly feed:NflverseResultsFeed=new NflverseResultsFeed(),
    private readonly clock:()=>Date=()=>new Date(),
    /** Every other sport (and NFL stats nflverse does not carry) from public box scores; null turns it off. */
    private readonly boxScores:BoxScoreResults|null=null){}
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
      // nflverse first (NFL's tracked stats); then box scores grade whatever is still pending, in every sport.
      let nfl={graded:0,pending:0},nflError:unknown=null;
      try{nfl=await this.nflverse();}catch(error){nflError=error;}
      const boxScores=this.boxScores?await this.gradeFromBoxScores():undefined;
      const result={graded:nfl.graded+(boxScores?.graded??0),pending:nfl.pending,...boxScores?{boxScores}:{}};
      if(nflError&&!boxScores?.graded)throw nflError;
      this.lastResult=result;this.lastError=nflError?errorCode(nflError):null;
      return result;
    }catch(error){
      this.lastError=errorCode(error);throw error;
    }finally{
      this.lastFinishedAt=this.clock().toISOString();this.running=false;
      if(this.timer&&this.intervalMs!==null)
        this.nextRunAt=new Date(this.clock().getTime()+this.intervalMs).toISOString();
    }
  }
  /** Picks from the last week that are still pending, tracked and personal alike, graded from box scores. */
  private async gradeFromBoxScores(){
    const since=this.clock().getTime()-7*86_400_000,targets=[];
    for(let offset=0;;offset+=500){
      const page=await this.ledger.listDecisions(offset,500);
      targets.push(...page.decisions.filter((item)=>item.grade==='PENDING'&&
        Date.parse(item.lineSnapshot.eventStartTime)>=since));
      if(offset+500>=page.total)break;
    }
    for(const {lineSnapshot} of await this.ledger.pendingPersonalLegs())
      if(Date.parse(lineSnapshot.eventStartTime)>=since)
        targets.push({eventId:lineSnapshot.eventId,playerId:lineSnapshot.playerId,lineSnapshot});
    const report=await this.boxScores!.results(targets);
    const graded=report.facts.length?await this.ledger.grade(report.facts):{graded:0,personal:0};
    return {graded:graded.graded+graded.personal,unsupported:report.unsupported,waiting:report.waiting};
  }
  private async nflverse(){
    {
      const pending=[];
      for(let offset=0;;offset+=500){
        const page=await this.ledger.listDecisions(offset,500);
        pending.push(...page.decisions.filter((item)=>item.grade==='PENDING' && item.sport==='NFL' &&
          nflverseTrackedMarkets.includes(item.market)));
        if(offset+500>=page.total)break;
      }
      // Your-call legs in personal Crowns are graded from the same results, outside the tracked record.
      const personal=(await this.ledger.pendingPersonalLegs()).filter(({lineSnapshot})=>lineSnapshot.sport==='NFL'&&
        nflverseTrackedMarkets.includes(lineSnapshot.market));
      if(!pending.length&&!personal.length)return {graded:0,pending:0};
      const targets=[...pending,...personal.map(({lineSnapshot})=>({eventId:lineSnapshot.eventId,
        playerId:lineSnapshot.playerId,lineSnapshot}))];
      const now=this.clock(),mappings=this.mappingPath?await readNflverseMappings(this.mappingPath):[],
        map=new Map(mappings.map((item)=>[JSON.stringify([item.eventId,item.playerId]),item])),
        manual=targets.flatMap((decision)=>{
          const mapping=map.get(JSON.stringify([decision.eventId,decision.playerId]));
          return mapping&&Date.parse(mapping.completedAt)<=now.getTime()? [{decision,mapping}]:[];
        }),
        unresolved=targets.filter((decision)=>!map.has(JSON.stringify([decision.eventId,decision.playerId]))&&
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
      return {graded:graded.graded,pending:pending.length-graded.graded};
    }
  }
}
