import { boardSchema, propLineSchema } from '@crowniq/contracts';
import type { Analysis, Board, BoardResponse, Evidence, PlayerMedia, PropLine, SecondLookAudit } from '@crowniq/contracts';
import { collectResearch, effectiveEvidenceExpiry, evaluateBoard, evaluateLine, ModelRegistry, researchTargetsFor } from '@crowniq/engine';
import type { OddsProvider, ResearchAdapter, ResearchHealth } from '@crowniq/engine';
import { classifyPrizePicksLineTypes, normalizeCachedPrizePicksLines } from './prizepicks-line-types.js';
import type { BoardCache } from './board-cache.js';

const secondLookTerminalReasons=new Set([
  'EVENT_ALREADY_STARTED','MODEL_SUPPORT_INCOMPLETE','MODEL_CALIBRATION_UNAPPROVED',
  'UNCLASSIFIED_ALTERNATE','DIRECTION_UNAVAILABLE','INVALID_SCORE_COMPONENTS',
  'MODEL_EVALUATION_FAILED',
]);

function secondLookEligible(analysis:Analysis):boolean{
  return analysis.direction==='PASS' && !!analysis.modelVersion &&
    !secondLookTerminalReasons.has(analysis.reasonCode??'MODEL_PASS');
}

function evidenceMatchesLine(item:Evidence,line:PropLine):boolean{
  return item.eventId===line.eventId && (item.market===null||item.market===line.market) &&
    (item.entityType==='EVENT' ||
      item.entityType==='PLAYER' && item.entityId===line.playerId ||
      item.entityType==='TEAM' && item.entityId===line.team);
}

function mergeEvidence(base:readonly Evidence[],extra:readonly Evidence[]):Evidence[]{
  const merged=new Map<string,Evidence>();
  for(const item of [...base,...extra])merged.set(item.id,item);
  return [...merged.values()];
}

export type ContextRefreshReport={at:string;status:'SUCCEEDED'|'PARTIAL'|'FAILED'|'SKIPPED';
  reason:string|null;linesTargeted:number;evidenceAdded:number;evidenceExpiredRemoved:number;
  oddsCreditsUsed:0;sourceRequests:number;
  /** Per-source results of the last refresh (e.g. where each MLB game's lookup stopped). */
  sources?:NonNullable<ResearchHealth['sources']>};

export class BoardService {
  private snapshot: BoardResponse | null = null;
  private lastError: string | null = null;
  private lastSuccessfulRefresh: string | null = null;
  private researchStatus: 'UNCONFIGURED' | 'OK' | 'PARTIAL' | 'FAILED' = 'UNCONFIGURED';
  private researchHealth: ResearchHealth | null = null;
  private baseEvidence: readonly Evidence[] = [];
  private webEvidence: readonly Evidence[] = [];
  private evidence: readonly Evidence[] = [];
  private secondLookAudits: Record<string,SecondLookAudit> = {};
  private playerMedia: Record<string,PlayerMedia> = {};
  private nextDeadline = Infinity;
  private startupRecovery = {status:'NOT_NEEDED' as 'NOT_NEEDED'|'UNCONFIGURED'|'RUNNING'|'SUCCEEDED'|'PARTIAL'|'FAILED',
    evidenceAdded:0,oddsCreditsUsed:0 as const,error:null as string|null};
  private mutation:Promise<unknown>=Promise.resolve();
  private pendingMutations=0;
  private exclusive<T>(operation:()=>Promise<T>):Promise<T>{
    this.pendingMutations++;
    const run=async()=>{try{return await operation();}finally{this.pendingMutations--;}};
    const result=this.mutation.then(run,run);
    this.mutation=result.catch(()=>undefined);
    return result;
  }
  private lastContextRefresh:ContextRefreshReport|null=null;
  private lastRefreshStage = 'idle';
  private lastRefreshCounts = { providerReturned: 0, normalized: 0, saved: 0,
    qualified: 0, exposed: 0 };

  constructor(
    private readonly provider: OddsProvider | null,
    private readonly research: ResearchAdapter | null,
    private readonly models: ModelRegistry,
    private readonly clock: () => Date = () => new Date(),
    private readonly cache: BoardCache | null = null,
    private readonly secondLookResearch: ResearchAdapter | null = null,
    /** Local history only: startup must never invoke paid or remote research adapters. */
    private readonly startupResearch: ResearchAdapter | null = null,
  ) {}

  /** Exclusive, so a refresh started while a large board is still restoring waits for it instead of being overwritten. */
  async restore():Promise<boolean>{return this.exclusive(()=>this.restoreNow());}

  private async restoreNow():Promise<boolean>{
    const cached=await this.cache?.load();
    if(!cached)return false;
    // Recalculate against the current time and approved model versions. Never
    // present a persisted score or expired evidence as a new live finding.
    this.baseEvidence=cached.evidence;
    this.secondLookAudits=cached.secondLookAudits??{};
    this.researchStatus=cached.researchStatus;
    this.lastSuccessfulRefresh=cached.lastSuccessfulRefresh;
    const restoredBoard=boardSchema.parse({...cached.board,
      lines:classifyPrizePicksLineTypes(normalizeCachedPrizePicksLines(cached.board.lines))});
    this.publish(restoredBoard,cached.evidence,this.clock());
    return true;
  }

  async recoverStartupEvidence():Promise<void>{
    return this.exclusive(()=>this.recoverStartupEvidenceNow());
  }

  private async recoverStartupEvidenceNow():Promise<void>{
    const board=this.getBoard()?.board;
    if(!board)return;
    const originalEvidence=this.evidence;
    const now=this.clock(),requirements=this.models.requirements();
    const stale=this.evidence.some((item)=>effectiveEvidenceExpiry(item)<=now.getTime());
    if(!stale)return;
    if(!this.startupResearch){this.startupRecovery.status='UNCONFIGURED';return;}
    const lines=board.lines.filter((line)=>Date.parse(line.eventStartTime)>now.getTime() &&
      requirements[`${line.sport}:${line.market}`]?.approved);
    if(!lines.length)return;
    this.startupRecovery.status='RUNNING';
    try{
      const recovered=await collectResearch({...board,lines},this.startupResearch);
      if(this.snapshot?.board!==board || this.evidence!==originalEvidence){
        this.startupRecovery.status='NOT_NEEDED';return;
      }
      if(recovered.status==='FAILED')throw new Error('STARTUP_HISTORY_RECOVERY_FAILED');
      const key=(item:Evidence)=>JSON.stringify([item.entityType,item.entityId,item.eventId,item.market,item.kind]);
      const replacements=new Set(recovered.evidence.map(key));
      const combined=mergeEvidence(this.baseEvidence.filter((item)=>
        !replacements.has(key(item))),recovered.evidence);
      // Save first. A recovery failure preserves the original board and evidence.
      await this.cache?.save({board,evidence:combined,researchStatus:this.researchStatus,
        lastSuccessfulRefresh:this.lastSuccessfulRefresh,secondLookAudits:{...this.secondLookAudits}});
      this.baseEvidence=combined;
      this.publish(board,combined,this.clock());
      this.startupRecovery={status:recovered.status==='PARTIAL'?'PARTIAL':'SUCCEEDED',
        evidenceAdded:recovered.evidence.length,oddsCreditsUsed:0,error:null};
    }catch{
      this.startupRecovery={status:'FAILED',evidenceAdded:0,oddsCreditsUsed:0,
        error:'STARTUP_HISTORY_RECOVERY_FAILED'};
    }
  }

  /**
   * Free context refresh: re-research upcoming lines with the given adapter and republish.
   * Never calls the odds provider. Skipped when a pull, reanalysis or another refresh is running,
   * so a scheduled tick never queues behind paid work.
   */
  async refreshContext(adapter:ResearchAdapter,options:{windowHours:number}):Promise<ContextRefreshReport>{
    const skipped=(reason:string):ContextRefreshReport=>({at:this.clock().toISOString(),status:'SKIPPED',
      reason,linesTargeted:0,evidenceAdded:0,evidenceExpiredRemoved:0,oddsCreditsUsed:0,sourceRequests:0});
    if(this.pendingMutations>0)return this.lastContextRefresh=skipped('BOARD_BUSY');
    return this.exclusive(()=>this.refreshContextNow(adapter,options.windowHours,skipped));
  }

  private async refreshContextNow(adapter:ResearchAdapter,windowHours:number,
    skipped:(reason:string)=>ContextRefreshReport):Promise<ContextRefreshReport>{
    const board=this.getBoard()?.board;
    if(!board)return this.lastContextRefresh=skipped('BOARD_UNAVAILABLE');
    const now=this.clock(),start=now.getTime(),end=start+windowHours*3600_000;
    const lines=board.lines.filter((line)=>{
      const time=Date.parse(line.eventStartTime);return time>start&&time<=end;
    });
    if(!lines.length)return this.lastContextRefresh=skipped('NO_UPCOMING_LINES');
    const researched=await collectResearch(boardSchema.parse({...board,lines}),adapter);
    const at=this.clock();
    const report={at:at.toISOString(),linesTargeted:lines.length,oddsCreditsUsed:0 as const,
      sourceRequests:researched.health?.searches??0,
      ...researched.health?.sources?{sources:researched.health.sources}:{}};
    if(researched.status==='FAILED'&&!researched.evidence.length)
      return this.lastContextRefresh={...report,status:'FAILED',reason:'CONTEXT_SOURCES_FAILED',
        evidenceAdded:0,evidenceExpiredRemoved:0};
    // A paid pull that finished meanwhile already replaced the board; its evidence wins.
    if(this.snapshot?.board!==board)return this.lastContextRefresh=skipped('BOARD_REPLACED');
    const key=(item:Evidence)=>JSON.stringify([item.entityType,item.entityId,item.eventId,item.market,item.kind]);
    const replacements=new Set(researched.evidence.map(key));
    const kept=this.baseEvidence.filter((item)=>!replacements.has(key(item)));
    const live=kept.filter((item)=>effectiveEvidenceExpiry(item)>at.getTime());
    const nextBase=mergeEvidence(live,researched.evidence);
    const combined=mergeEvidence(nextBase,this.webEvidence);
    await this.cache?.save({board,evidence:combined,researchStatus:this.researchStatus,
      lastSuccessfulRefresh:this.lastSuccessfulRefresh,secondLookAudits:{...this.secondLookAudits}});
    this.baseEvidence=nextBase;
    this.publish(board,combined,at);
    return this.lastContextRefresh={...report,status:researched.status==='OK'||researched.status==='UNCONFIGURED'
      ?'SUCCEEDED':'PARTIAL',reason:null,evidenceAdded:researched.evidence.length,
      evidenceExpiredRemoved:kept.length-live.length};
  }

  async persist():Promise<void>{return this.exclusive(()=>this.persistNow());}

  private async persistNow():Promise<void>{
    const board=this.snapshot?.board;
    if(board)await this.cache?.save({board,evidence:[...this.evidence],
      researchStatus:this.researchStatus,lastSuccessfulRefresh:this.lastSuccessfulRefresh,
      secondLookAudits:{...this.secondLookAudits}});
  }

  getBoard(): BoardResponse | null {
    if (this.snapshot && this.clock().getTime() >= this.nextDeadline) {
      // Expired evidence and started events stop ranking even without a new odds pull.
      this.publish(this.snapshot.board, this.evidence, this.clock());
    }
    return this.snapshot;
  }

  getEvidence(): readonly Evidence[] { this.getBoard(); return this.evidence; }
  /** The approved models on lines outside the board (the Underdog/Pick6 shadow run), with the board's current research. */
  scoreLines(lines: readonly PropLine[]): Analysis[] {
    const now=this.clock(),evidence=this.getEvidence();
    return lines.map((line)=>evaluateLine(line,evidence,this.models,now));
  }

  /**
   * Team identity from exact source matches. A line gets a team only when the matched team is one
   * of its own event's two sides; anything else is ignored rather than guessed.
   */
  private withIdentity(board: Board, evidence: readonly Evidence[], now: Date): Board {
    // Several sources can name a player's team or photo; the most confident one wins.
    const teams = new Map<string, { team: string; confidence: number }>();
    const photos = new Map<string, { photoUrl: string; source: string; confidence: number }>();
    for (const item of evidence) {
      if (item.entityType !== 'PLAYER' || effectiveEvidenceExpiry(item) <= now.getTime()) continue;
      const key = item.eventId + '|' + item.entityId;
      if (item.kind === 'identity:team' && item.confidence > (teams.get(key)?.confidence ?? -1))
        teams.set(key, { team: item.finding, confidence: item.confidence });
      if (item.kind === 'identity:photo' && item.sourceUrl && item.confidence > (photos.get(item.entityId)?.confidence ?? -1))
        photos.set(item.entityId, { photoUrl: item.sourceUrl, source: item.sourceName, confidence: item.confidence });
    }
    for (const [playerId, { photoUrl, source }] of photos) this.playerMedia[playerId] = { photoUrl, source };
    // A headshot from the line source fills in only where no identity source supplied one.
    for (const line of board.lines)
      if (line.playerImageUrl && !this.playerMedia[line.playerId])
        this.playerMedia[line.playerId] = { photoUrl: line.playerImageUrl, source: 'Line source' };
    let changed = false;
    const lines = board.lines.map((line) => {
      const team = teams.get(line.eventId + '|' + line.playerId)?.team;
      if (line.team || !team || (team !== line.homeTeam && team !== line.awayTeam)) return line;
      changed = true;
      return { ...line, team, opponent: (team === line.homeTeam ? line.awayTeam : line.homeTeam) ?? null };
    });
    return changed ? { ...board, lines } : board;
  }

  private publish(source: Board, evidence: readonly Evidence[], now: Date): BoardResponse {
    const board = this.withIdentity(source, evidence, now);
    const result = evaluateBoard(board, evidence, this.models, now);
    const analyses=result.analyses.map((analysis)=>{
      const audit=this.secondLookAudits[analysis.lineId];
      return audit?{...analysis,reviewStatus:'SECOND_LOOK' as const,secondLook:audit}:
        {...analysis,reviewStatus:'STANDARD' as const,secondLook:null};
    });
    const players = new Set(board.lines.map((line) => line.playerId));
    const media = Object.fromEntries(Object.entries(this.playerMedia).filter(([playerId]) => players.has(playerId)));
    this.snapshot = { board, analyses, rankedLineIds:result.rankedLineIds, builtAt: now.toISOString(),
      ...(Object.keys(media).length ? { playerMedia: media } : {}) };
    this.evidence = evidence;
    this.nextDeadline = Infinity;
    for (const line of board.lines) {
      const time = Date.parse(line.eventStartTime);
      if (time > now.getTime()) this.nextDeadline = Math.min(this.nextDeadline, time);
    }
    for (const item of evidence) {
      const time = effectiveEvidenceExpiry(item);
      if (time > now.getTime()) this.nextDeadline = Math.min(this.nextDeadline, time);
    }
    return this.snapshot;
  }

  getStatus() {
    this.getBoard();
    const now=this.clock().getTime();
    const activeEvidence=this.evidence.filter((item)=>effectiveEvidenceExpiry(item)>now &&
      Date.parse(item.retrievedAt)<=now);
    const analyses=this.snapshot?.analyses??[];
    const attempted=Object.keys(this.secondLookAudits).length;
    const upgraded=analyses.filter((item)=>item.reviewStatus==='SECOND_LOOK'&&item.direction!=='PASS').length;
    const evidenceAdded=Object.values(this.secondLookAudits)
      .reduce((total,item)=>total+item.evidenceAdded,0);
    const secondLookAnalyses=analyses.filter((item)=>item.reviewStatus==='SECOND_LOOK');
    const finalReasons=Object.fromEntries([...secondLookAnalyses.reduce((counts,item)=>{
      const key=item.direction==='PASS'?(item.reasonCode??'PASS'):'UPGRADED';
      counts.set(key,(counts.get(key)??0)+1);return counts;
    },new Map<string,number>())].sort((a,b)=>b[1]-a[1]));
    const lineById=new Map((this.snapshot?.board.lines??[]).map((line)=>[line.id,line]));
    const secondLookBySport=Object.fromEntries([...secondLookAnalyses.reduce((counts,item)=>{
      const sport=lineById.get(item.lineId)?.sport??'UNKNOWN';
      const reason=item.direction==='PASS'?(item.reasonCode??'PASS'):'UPGRADED';
      const current=counts.get(sport)??{attempted:0,upgraded:0,stillPass:0,reasons:{} as Record<string,number>};
      current.attempted++;
      if(item.direction==='PASS')current.stillPass++;else current.upgraded++;
      current.reasons[reason]=(current.reasons[reason]??0)+1;
      counts.set(sport,current);return counts;
    },new Map<string,{attempted:number;upgraded:number;stillPass:number;reasons:Record<string,number>}>())]);
    const secondLookByMarket=Object.fromEntries([...secondLookAnalyses.reduce((counts,item)=>{
      const line=lineById.get(item.lineId);
      const key=line?`${line.sport}:${line.market}`:'UNKNOWN';
      const reason=item.direction==='PASS'?(item.reasonCode??'PASS'):'UPGRADED';
      const current=counts.get(key)??{attempted:0,upgraded:0,stillPass:0,reasons:{} as Record<string,number>};
      current.attempted++;
      if(item.direction==='PASS')current.stillPass++;else current.upgraded++;
      current.reasons[reason]=(current.reasons[reason]??0)+1;
      counts.set(key,current);return counts;
    },new Map<string,{attempted:number;upgraded:number;stillPass:number;reasons:Record<string,number>}>())]
      .sort((a,b)=>b[1].attempted-a[1].attempted));
    const coverageRows=secondLookAnalyses.filter((item)=>
      item.direction==='PASS'&&item.reasonCode==='INSUFFICIENT_MODEL_COVERAGE');
    const coverageByMarket=Object.fromEntries([...coverageRows.reduce((counts,item)=>{
      const line=lineById.get(item.lineId);
      const key=line?`${line.sport}:${line.market}`:'UNKNOWN';
      const current=counts.get(key)??{count:0,confidenceTotal:0,missingFactors:{} as Record<string,number>};
      current.count++;
      current.confidenceTotal+=item.dataConfidence??0;
      for(const factor of item.opposingFactors??[]){
        const match=/^Missing attributed factor (.+)$/.exec(factor);
        if(match)current.missingFactors[match[1]]=(current.missingFactors[match[1]]??0)+1;
      }
      counts.set(key,current);return counts;
    },new Map<string,{count:number;confidenceTotal:number;missingFactors:Record<string,number>}>())]
      .map(([key,value])=>[key,{count:value.count,
        averageDataConfidence:Math.round(value.confidenceTotal/value.count*10)/10,
        missingFactors:Object.fromEntries(Object.entries(value.missingFactors)
          .sort((a,b)=>b[1]-a[1]))}])
      .sort((a,b)=>(b[1] as {count:number}).count-(a[1] as {count:number}).count));
    const fresh=activeEvidence.filter((item)=>item.id.startsWith('current:'));
    const freshKinds=Object.fromEntries([...fresh.reduce((counts,item)=>{
      counts.set(item.kind,(counts.get(item.kind)??0)+1);return counts;
    },new Map<string,number>())].sort((a,b)=>b[1]-a[1]));
    const sportByEvent=new Map((this.snapshot?.board.lines??[]).map((line)=>[line.eventId,line.sport]));
    const freshBySport=Object.fromEntries([...fresh.reduce((counts,item)=>{
      const sport=sportByEvent.get(item.eventId)??'UNKNOWN';
      counts.set(sport,(counts.get(sport)??0)+1);return counts;
    },new Map<string,number>())].sort((a,b)=>b[1]-a[1]));
    return {
      provider: this.provider?.id ?? 'unconfigured',
      providerHealth: this.provider?.getHealth?.() ?? null,
      research: this.researchStatus,
      researchHealth: this.researchHealth,
      startupRecovery:{...this.startupRecovery},
      lastContextRefresh:this.lastContextRefresh?{...this.lastContextRefresh}:null,
      evidenceFreshness:{total:this.evidence.length,active:activeEvidence.length,
        expired:this.evidence.length-activeEvidence.length},
      lastSuccessfulRefresh: this.lastSuccessfulRefresh,
      lastError: this.lastError,
      lineCount: this.getBoard()?.board.lines.length ?? 0,
      modelVersions: this.models.versions(),
      modelRequirements: this.models.requirements(),
      refreshStage: this.lastRefreshStage,
      refreshCounts: { ...this.lastRefreshCounts },
      secondLook: { attempted, upgraded, stillPass: attempted-upgraded, evidenceAdded,
        finalReasons, bySport:secondLookBySport, byMarket:secondLookByMarket,
        coverageGaps:{total:coverageRows.length,byMarket:coverageByMarket} },
      freshContext: { evidenceCount:fresh.length, byKind:freshKinds, bySport:freshBySport },
    };
  }

  async refresh():Promise<BoardResponse>{return this.exclusive(()=>this.refreshNow());}

  private async refreshNow(): Promise<BoardResponse> {
    if (!this.provider) throw new Error('ODDS_PROVIDER_UNCONFIGURED');
    let rawCount = 0;
    let normalizedCount = 0;
    this.lastRefreshCounts = { providerReturned: 0, normalized: 0, saved: 0,
      qualified: 0, exposed: 0 };
    try {
      this.lastRefreshStage = 'provider';
      const now = this.clock();
      const fetchedAt = now.toISOString();
      const raw = await this.provider.fetchPrizePicksLines();
      rawCount = raw.length;
      this.lastRefreshCounts = { ...this.lastRefreshCounts, providerReturned: rawCount };

      this.lastRefreshStage = 'normalize';
      const lines = classifyPrizePicksLineTypes(raw.map(
        (item) => propLineSchema.parse(this.provider!.normalize(item, fetchedAt))));
      normalizedCount = lines.length;
      this.lastRefreshCounts = { ...this.lastRefreshCounts, normalized: normalizedCount };
      // The board is as old as its oldest line: a source may hand over lines it captured earlier.
      const capturedAt = lines.reduce((earliest, line) => line.fetchedAt < earliest ? line.fetchedAt : earliest, fetchedAt);
      const board = boardSchema.parse({ provider: 'prizepicks', fetchedAt: capturedAt, lines });

      this.lastRefreshStage = 'research';
      const researched = await collectResearch(board, this.research);
      const secondLook = await this.runSecondLook(board, researched.evidence, this.clock());
      this.secondLookAudits=secondLook.audits;
      const researchStatus=this.combinedResearchStatus(researched.status,secondLook.status,
        secondLook.evidence.length);

      // Persist the validated, normalized board before making it visible. If persistence
      // fails, the previous board stays live rather than publishing an unprotected snapshot.
      this.lastRefreshStage = 'persist';
      await this.cache?.save({board,evidence:[...secondLook.evidence],
        researchStatus,lastSuccessfulRefresh:this.clock().toISOString(),
        secondLookAudits:{...this.secondLookAudits}});
      this.lastRefreshCounts = { ...this.lastRefreshCounts, saved: board.lines.length };

      this.lastRefreshStage = 'publish';
      const next = this.publish(board, secondLook.evidence, this.clock());
      this.baseEvidence = secondLook.evidence;
      this.webEvidence = [];
      this.researchHealth = secondLook.health ?? researched.health;
      this.researchStatus = researchStatus;
      this.lastSuccessfulRefresh = next.builtAt;
      this.lastError = null;
      this.lastRefreshStage = 'complete';
      this.lastRefreshCounts = { providerReturned: rawCount, normalized: normalizedCount,
        saved: board.lines.length, qualified: next.rankedLineIds.length,
        exposed: next.board.lines.length };
      console.info(JSON.stringify({ event: 'crowniq_board_refresh_complete',
        ...this.lastRefreshCounts }));
      return next;
    } catch (error) {
      const message = error instanceof Error && /^(ODDS_API|BOARD_CACHE)_[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'BOARD_REFRESH_FAILED';
      this.lastError = message;
      console.error(JSON.stringify({ event: 'crowniq_board_refresh_failed',
        stage: this.lastRefreshStage, error: message, providerReturned: rawCount,
        normalized: normalizedCount }));
      throw new Error(message);
    }
  }

  /** Research-only owner refresh; a context update costs no odds-provider credits. */
  async reanalyze():Promise<BoardResponse>{return this.exclusive(()=>this.reanalyzeNow());}

  private async reanalyzeNow(): Promise<BoardResponse> {
    const board = this.getBoard()?.board;
    if (!board) throw new Error('BOARD_UNAVAILABLE');
    const researched = this.research ? await collectResearch(board, this.research) : {
      status: this.researchStatus, evidence: this.baseEvidence, health: this.researchHealth,
    };
    // A temporary research-source failure must not erase the last validated evidence snapshot.
    const nextBase = researched.status === 'FAILED' && this.baseEvidence.length
      ? this.baseEvidence : researched.evidence;
    const secondLook=await this.runSecondLook(board,nextBase,this.clock());
    this.secondLookAudits={...this.secondLookAudits,...secondLook.audits};
    const combined=mergeEvidence(secondLook.evidence,this.webEvidence);
    const baseStatus=this.combinedResearchStatus(researched.status,secondLook.status,combined.length);
    const nextStatus=baseStatus === 'FAILED'
      ? combined.length ? 'PARTIAL' : 'FAILED'
      : this.webEvidence.length ? researched.health?.status === 'OK' ? baseStatus : 'PARTIAL'
        : baseStatus;
    await this.cache?.save({board,evidence:combined,researchStatus:nextStatus,
      lastSuccessfulRefresh:this.lastSuccessfulRefresh,secondLookAudits:{...this.secondLookAudits}});
    const next = this.publish(board, combined, this.clock());
    this.baseEvidence = secondLook.evidence;
    this.researchHealth = secondLook.health ?? researched.health ?? this.researchHealth;
    this.researchStatus = nextStatus;
    return next;
  }

  private combinedResearchStatus(primary:'UNCONFIGURED'|'OK'|'PARTIAL'|'FAILED',
    secondary:'UNCONFIGURED'|'OK'|'PARTIAL'|'FAILED'|null,evidenceCount:number):
    'UNCONFIGURED'|'OK'|'PARTIAL'|'FAILED' {
    if(!secondary)return primary;
    if(primary==='FAILED'&&secondary==='FAILED')return evidenceCount?'PARTIAL':'FAILED';
    if(primary==='FAILED'||secondary==='FAILED'||primary==='PARTIAL'||secondary==='PARTIAL')return 'PARTIAL';
    if(primary==='UNCONFIGURED')return secondary;
    if(secondary==='UNCONFIGURED')return primary;
    return 'OK';
  }

  private async runSecondLook(board:Board,evidence:readonly Evidence[],now:Date):Promise<{
    evidence:Evidence[];audits:Record<string,SecondLookAudit>;
    status:'UNCONFIGURED'|'OK'|'PARTIAL'|'FAILED'|null;health:ResearchHealth|null;
  }>{
    if(!this.secondLookResearch)return {evidence:[...evidence],audits:{},status:null,health:null};
    const initial=evaluateBoard(board,evidence,this.models,now);
    const eligible=new Set(initial.analyses.filter(secondLookEligible).map((item)=>item.lineId));
    if(!eligible.size)return {evidence:[...evidence],audits:{},status:null,health:null};
    const eligibleKeys=new Set(board.lines.filter((line)=>eligible.has(line.id))
      .map((line)=>[line.eventId,line.playerId,line.market].join('|')));
    const supportedKeys=new Set(researchTargetsFor(board)
      .filter((target)=>eligibleKeys.has([target.eventId,target.playerId,target.market].join('|')) &&
        (this.secondLookResearch?.supports?.(target)??true))
      .map((target)=>[target.eventId,target.playerId,target.market].join('|')));
    const lines=board.lines.filter((line)=>eligible.has(line.id) &&
      supportedKeys.has([line.eventId,line.playerId,line.market].join('|')));
    if(!lines.length)return {evidence:[...evidence],audits:{},status:null,health:null};
    const subset=boardSchema.parse({...board,lines});
    const researched=await collectResearch(subset,this.secondLookResearch);
    const merged=mergeEvidence(evidence,researched.evidence);
    const audits:Record<string,SecondLookAudit>={};
    const byId=new Map(initial.analyses.map((item)=>[item.lineId,item]));
    for(const line of lines){
      const first=byId.get(line.id)!;
      audits[line.id]={initialReasonCode:first.reasonCode,
        initialDataConfidence:first.dataConfidence??null,
        evidenceAdded:researched.evidence.filter((item)=>evidenceMatchesLine(item,line)).length,
        performedAt:now.toISOString()};
    }
    return {evidence:merged,audits,status:researched.status,health:researched.health};
  }

  applyWebEvidence(board: Board, evidence: readonly Evidence[], health: ResearchHealth): boolean {
    if (this.snapshot?.board !== board) return false; // A newer odds refresh won the race.
    this.publish(board, [...this.baseEvidence, ...evidence], this.clock());
    this.webEvidence = evidence;
    this.researchHealth = health;
    this.researchStatus = health.status === 'FAILED' && !this.baseEvidence.length
      ? 'FAILED' : this.researchStatus === 'FAILED' || health.status !== 'OK'
        ? 'PARTIAL' : 'OK';
    return true;
  }
}
