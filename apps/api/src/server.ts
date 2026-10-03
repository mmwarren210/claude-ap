import { randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { nflPassingResultSchema } from '@crowniq/contracts';
import { ModelRegistry, routeResearch, snapshotSelection } from '@crowniq/engine';
import type { OddsProvider, ResearchAdapter } from '@crowniq/engine';
import type { BoardResponse } from '@crowniq/contracts';
import { idlePullJob } from './owner-pull-job.js';
import type { OwnerPullJob, OwnerPullJobStore } from './owner-pull-job.js';
import { BoardService } from './board-service.js';
import type { SelectionLedger } from './selection-ledger.js';
import { summarizeNflPilot } from './selection-ledger.js';
import { nflverseTrackedMarkets, NflverseResultsFeed, readNflverseMappings,
  resultFromNflverse } from './nflverse-results.js';
import { WebResearchAdapter } from './web-research.js';
import { ResearchBuild } from './research-build.js';
import { ProductLedger, resultFactSchema } from './product-ledger.js';
import type { BoardCache } from './board-cache.js';
import { boardFunnel, outcomeCounts } from './board-funnel.js';
import { liteBoard } from './board-lite.js';
import { ContextRefreshScheduler } from './context-refresh.js';
import type { ScraperPuller } from './scrapers/scraper-puller.js';
import type { ContextRefreshOptions, DailyLookupBudget } from './context-refresh.js';
import type { ProviderName } from './provider-identity.js';
import { ProviderIdentityVerifier } from './provider-identity.js';
import { StatApiOwnerError, StatApiOwnerResearch } from './stat-api-owner-research.js';
import { OwnerResearchNotebook } from './owner-research-notebook.js';
import { rankingCards, secondLookWatchlist } from './ranking-cards.js';
import { auditPrizePicksLineTypes } from './prizepicks-line-types.js';
import type { HistoryBackfillService, InternalHistorySport, InternalHistoryStore } from './internal-history.js';
import type { ProductGradingStatus } from './background-grading.js';
import { serveWebApp } from './web-app.js';

export interface ServerOptions {
  provider?: OddsProvider | null;
  /** Folder holding the exported web app, served at every non-API path. */
  webAppDir?: string | null;
  research?: ResearchAdapter | null;
  secondLookResearch?: ResearchAdapter | null;
  webResearch?: WebResearchAdapter | null;
  models?: ModelRegistry;
  adminToken?: string;
  ownerPublicId?: string;
  ownerResearch?: StatApiOwnerResearch | null;
  ownerNotebook?: OwnerResearchNotebook | null;
  internalHistory?: InternalHistoryStore | null;
  historyBackfill?: HistoryBackfillService | null;
  clock?: () => Date;
  selections?: SelectionLedger | null;
  nflverseMappingFile?: string;
  nflverseFeed?: NflverseResultsFeed;
  product?: ProductLedger | null;
  boardCache?: BoardCache | null;
  autoGradingEnabled?: boolean;
  autoGradingStatus?: () => ProductGradingStatus | null;
  /** Trusted authentication integration only; never use client-provided public IDs as identity. */
  socialActor?: (request: FastifyRequest) => Promise<string | null> | string | null;
  requireProfiles?: boolean;
  /** Startup recovery is restricted to local, credit-free internal history. */
  startupResearch?: ResearchAdapter | null;
  identityVerifier?: ProviderIdentityVerifier | null;
  allowedWebOrigins?: readonly string[];
  /** Persists the paid-pull job record across restarts. */
  ownerJobStore?: OwnerPullJobStore | null;
  /** Free scheduled context refresh; never calls the odds provider. */
  contextRefresh?: ContextRefreshOptions | null;
  /** Daily cap on paid NBA status lookups made by context refresh ticks. */
  contextLookupBudget?: DailyLookupBudget | null;
  /** Scheduled Apify scraper pulls that feed the provider's line store. */
  scraperPuller?: ScraperPuller | null;
}

function authorized(request: FastifyRequest, token?: string): boolean {
  if (!token) return false;
  const supplied = request.headers.authorization;
  if (!supplied?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(supplied.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function buildServer(options: ServerOptions = {}) {
  const app = Fastify({ logger: false });
  const service = new BoardService(options.provider ?? null, options.research ?? null,
    options.models ?? new ModelRegistry(), options.clock, options.boardCache,
    options.secondLookResearch ?? null,options.startupResearch ?? null);
  const now=()=>options.clock?.()??new Date();
  const bearer=(request:FastifyRequest)=>request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7):'';
  const currentUser=(request:FastifyRequest)=>options.product?.authenticate(bearer(request))??null;
  const nonces=new Map<string,number>();
  const attempts=new Map<string,{since:number,count:number}>();
  const limited=(key:string)=>{
    const time=now().getTime(),entry=attempts.get(key);
    if(attempts.size>3000)attempts.clear();
    if(!entry || time-entry.since>=60_000){attempts.set(key,{since:time,count:1});return false;}
    entry.count++;return entry.count>8;
  };
  app.addHook('onRequest',async(request,reply)=>{
    const origin=request.headers.origin;
    if(origin && options.allowedWebOrigins?.includes(origin)){
      reply.header('Access-Control-Allow-Origin',origin).header('Vary','Origin')
        .header('Access-Control-Allow-Headers','Authorization, Content-Type')
        .header('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
    }
    if(request.method==='OPTIONS'){
      return reply.code(origin && options.allowedWebOrigins?.includes(origin)?204:403).send();
    }
    const path=request.url.split('?')[0];
    if(options.requireProfiles && path.startsWith('/v1/') &&
      !path.startsWith('/v1/admin/') && !path.startsWith('/v1/auth/') &&
      !await currentUser(request))return reply.code(401).send({code:'PROFILE_REQUIRED'});
  });
  app.addHook('onReady',async()=>{
    await service.restore();
    const savedJob=await options.ownerJobStore?.load().catch(()=>null);
    if(savedJob){
      // A RUNNING record at startup means the server stopped mid-pull: report it, never hide it.
      ownerBoardRefresh=savedJob.status==='RUNNING'
        ? {...savedJob,status:'FAILED',finishedAt:now().toISOString(),error:'INTERRUPTED_BY_RESTART',
          trackingStatus:savedJob.trackingStatus==='PENDING'?'FAILED':savedJob.trackingStatus}
        : savedJob;
      if(savedJob.status==='RUNNING')await saveJob();
    }
    // History reconstruction runs after restore without blocking Fastify startup; the first
    // context refresh follows it, then ticks repeat on the configured interval.
    void service.recoverStartupEvidence().then(()=>contextScheduler?.tick());
    contextScheduler?.start();
    // After a scraper pull changes lines, rebuild the board through the owner job (free; tracks picks).
    options.scraperPuller?.whenLinesChange(()=>startOwnerBoardRefresh());
    options.scraperPuller?.start();
    if(options.ownerNotebook && options.ownerPublicId){
      await options.ownerNotebook.load();options.ownerNotebook.start();
    }
  });
  const webBuild = options.webResearch ? new ResearchBuild(service, options.webResearch,
    options.clock,options.product ? async()=>{const board=service.getBoard();
      if(board){await service.persist();await options.product!.track(board,service.getEvidence());}} :
      async()=>service.persist()) : null;
  const contextScheduler=options.contextRefresh?new ContextRefreshScheduler(service,options.contextRefresh):null;
  app.addHook('onClose', async () => { webBuild?.cancel();options.ownerNotebook?.stop();contextScheduler?.stop();
    options.scraperPuller?.stop(); });

  // Every paid provider pull runs through this one job, so two pulls can never overlap or
  // queue back to back. The record is persisted so a restart mid-pull is reported.
  let ownerBoardRefresh:OwnerPullJob=idlePullJob();
  let pullDone:Promise<BoardResponse|null>=Promise.resolve(null);
  const saveJob=async()=>{try{await options.ownerJobStore?.save(ownerBoardRefresh);}catch{/* status stays in memory */}};
  const providerCredits=()=>{
    const health=options.provider?.getHealth?.() as {creditsRemaining?:number|null;
      coverage?:{creditsSpent?:number}|null}|undefined;
    return {remaining:health?.creditsRemaining??null,spent:health?.coverage?.creditsSpent??null};
  };
  const startOwnerBoardRefresh=()=>{
    if(ownerBoardRefresh.status==='RUNNING')return false;
    const before=providerCredits().remaining;
    ownerBoardRefresh={...idlePullJob(),status:'RUNNING',startedAt:now().toISOString(),
      trackingStatus:options.product?'PENDING':'UNCONFIGURED',refreshStage:'provider',
      counts:{...service.getStatus().refreshCounts},creditsRemaining:before};
    void saveJob();
    const credits=()=>{const after=providerCredits();
      return {creditsRemaining:after.remaining,
        creditsSpent:after.spent??(before!==null&&after.remaining!==null?before-after.remaining:null)};};
    pullDone=(async()=>{
      try{
        const snapshot=await service.refresh();
        let trackingStatus:OwnerPullJob['trackingStatus']=options.product?'OK':'UNCONFIGURED',tracked=0;
        if(options.product){try{tracked=await options.product.track(snapshot,service.getEvidence());}
          catch{trackingStatus='FAILED';}}
        // Web research has its own cost (OpenAI searches), so a pull never starts it.
        const webResearchJob=null;
        const status=service.getStatus();
        ownerBoardRefresh={...ownerBoardRefresh,status:'SUCCEEDED',finishedAt:now().toISOString(),
          error:null,trackingStatus,tracked,webResearchJob,refreshStage:status.refreshStage,
          counts:{...status.refreshCounts},...credits()};
        await saveJob();
        return snapshot;
      }catch{
        const status=service.getStatus();
        ownerBoardRefresh={...ownerBoardRefresh,status:'FAILED',finishedAt:now().toISOString(),
          error:status.lastError??'BOARD_REFRESH_FAILED',
          trackingStatus:options.product?'FAILED':'UNCONFIGURED',webResearchJob:null,
          refreshStage:status.refreshStage,counts:{...status.refreshCounts},...credits()};
        await saveJob();
        return null;
      }
    })();
    return true;
  };
  const currentJob=()=>ownerBoardRefresh.status==='RUNNING'
    ? {...ownerBoardRefresh,refreshStage:service.getStatus().refreshStage}:ownerBoardRefresh;

  // Public liveness only. Operating detail lives behind owner or admin auth.
  // Which Crown rules failed, from the ledger's error message, for a readable app message.
  const crownIssues=(error:unknown)=>{
    const message=error instanceof Error?error.message:'';
    const match=/^CROWN_CONSTRAINT_REJECTED:(.+)$/.exec(message);
    return match?match[1].split(',').filter((code)=>/^[A-Z_]+$/.test(code)):
      /^[A-Z_]+$/.test(message)?[message]:[];
  };
  app.get('/health', async () => ({ status: 'ok', boardAvailable: !!service.getBoard() }));
  const username=z.string().trim().regex(/^[A-Za-z0-9_]{3,24}$/);
  const email=z.email().max(254);
  const password=z.string().min(12).max(128);
  app.post('/v1/auth/register',async(request,reply)=>{
    if(!options.product)return reply.code(503).send({code:'PROFILES_UNCONFIGURED'});
    if(limited(`register:${request.ip}`))return reply.code(429).send({code:'TOO_MANY_ATTEMPTS'});
    const input=z.object({username,email,password}).strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'INVALID_REGISTRATION'});
    try{return reply.code(201).send(await options.product.register(input.data.email,
      input.data.password,input.data.username));}
    catch(error){const code=(error as Error).message;
      if(code==='USERNAME_TAKEN'||code==='EMAIL_TAKEN')return reply.code(409).send({code});
      return reply.code(503).send({code:'PROFILE_STORAGE_UNAVAILABLE'});}
  });
  app.post('/v1/auth/login',async(request,reply)=>{
    if(!options.product)return reply.code(503).send({code:'PROFILES_UNCONFIGURED'});
    if(limited(`login:${request.ip}`))return reply.code(429).send({code:'TOO_MANY_ATTEMPTS'});
    const input=z.object({email,password:z.string().min(1).max(128)}).strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'INVALID_LOGIN'});
    try{return await options.product.login(input.data.email,input.data.password);}
    catch{return reply.code(401).send({code:'INVALID_CREDENTIALS'});}
  });
  app.get('/v1/auth/me',async(request,reply)=>{
    const user=await currentUser(request);
    return user?{profile:{publicId:user.publicId,username:user.username,email:user.email,
      plan:user.plan}}:reply.code(401).send({code:'SIGN_IN_REQUIRED'});
  });
  // The signed-in owner can bootstrap the first real PrizePicks board from the app.
  // It is deliberately manual because a provider refresh may consume paid credits.
  app.register(async(ownerBoard)=>{
    ownerBoard.addHook('preHandler',async(request,reply)=>{
      reply.header('Cache-Control','private, no-store');
      const user=await currentUser(request);
      if(!options.ownerPublicId || user?.publicId!==options.ownerPublicId)
        return reply.code(404).send({code:'NOT_FOUND'});
    });
    ownerBoard.get('/status',async()=>{
      const snapshot=service.getBoard(),status=service.getStatus();
      return {providerConfigured:!!options.provider,boardAvailable:!!snapshot,
        lineCount:snapshot?.board.lines.length??0,rankedCount:snapshot?.rankedLineIds.length??0,
        lastError:status.lastError,refreshStage:status.refreshStage,job:currentJob()};
    });
    ownerBoard.get('/health',async()=>{
      const { providerHealth: _privateHealth, modelRequirements: _privateRequirements,
        ...ownerStatus } = service.getStatus();
      return { status: 'ok', ...ownerStatus };
    });
    ownerBoard.get('/diagnostics',async(_request,reply)=>{
      const snapshot=service.getBoard();
      if(!snapshot)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
      const status=service.getStatus(),requirements=status.modelRequirements;
      const reasons=new Map<string,number>(),sports=new Map<string,{lines:number;supported:number;
        approved:number;ranked:number}>(),markets=new Map<string,{sport:string;market:string;lines:number;
        supported:number;approved:number;ranked:number}>();
      const ranked=new Set(snapshot.rankedLineIds);
      let supported=0,approved=0;
      for(let index=0;index<snapshot.board.lines.length;index++){
        const line=snapshot.board.lines[index],analysis=snapshot.analyses[index];
        const key=`${line.sport}:${line.market.trim().toLowerCase()}`;
        const requirement=requirements[key],isSupported=!!requirement,isApproved=requirement?.approved===true;
        const reason=analysis?.direction==='PASS'?(analysis.reasonCode??'MODEL_PASS'):'PLAYABLE';
        reasons.set(reason,(reasons.get(reason)??0)+1);
        if(isSupported)supported++;if(isApproved)approved++;
        const sport=sports.get(line.sport)??{lines:0,supported:0,approved:0,ranked:0};
        sport.lines++;if(isSupported)sport.supported++;if(isApproved)sport.approved++;
        if(ranked.has(line.id))sport.ranked++;sports.set(line.sport,sport);
        const marketKey=`${line.sport}|${line.market}`;
        const market=markets.get(marketKey)??{sport:line.sport,market:line.market,lines:0,
          supported:0,approved:0,ranked:0};
        market.lines++;if(isSupported)market.supported++;if(isApproved)market.approved++;
        if(ranked.has(line.id))market.ranked++;markets.set(marketKey,market);
      }
      return {boardFetchedAt:snapshot.board.fetchedAt,builtAt:snapshot.builtAt,
        lineCount:snapshot.board.lines.length,rankedCount:snapshot.rankedLineIds.length,
        evidenceCount:service.getEvidence().length,research:status.research,providerRefreshCost:0,
        evidenceFreshness:status.evidenceFreshness,startupRecovery:status.startupRecovery,
        contextRefresh:{enabled:!!options.contextRefresh,
          intervalMinutes:options.contextRefresh?.intervalMinutes??0,last:status.lastContextRefresh,
          nbaLookupsToday:await options.contextLookupBudget?.used()??0,
          nbaDailyLimit:options.contextLookupBudget?.limit??0},
        scrapers:await options.scraperPuller?.status()??null,
        researchHealth:status.researchHealth,secondLook:status.secondLook,
        freshContext:status.freshContext,lineTypes:auditPrizePicksLineTypes(snapshot.board.lines),
        modelSupport:{supported,unsupported:snapshot.board.lines.length-supported,
          approved,unapproved:supported-approved},
        funnel:boardFunnel(snapshot,requirements,service.getEvidence()),outcomeCounts:outcomeCounts(snapshot),
        /** Deprecated: scored lines of every band appear as PLAYABLE here. Use funnel or outcomeCounts. */
        reasonCounts:Object.fromEntries([...reasons].sort((a,b)=>b[1]-a[1])),
        sports:Object.fromEntries([...sports].sort((a,b)=>b[1].lines-a[1].lines)),
        markets:[...markets.values()].sort((a,b)=>b.lines-a.lines).slice(0,100)};
    });
    ownerBoard.post('/reanalyze',async(request,reply)=>{
      const input=z.object({acknowledgeResearchCost:z.boolean().optional()}).strict().safeParse(request.body??{});
      if(!input.success)return reply.code(400).send({code:'INVALID_REANALYZE_REQUEST'});
      if((options.research||options.secondLookResearch) && input.data.acknowledgeResearchCost!==true)
        return reply.code(428).send({code:'RESEARCH_COST_CONFIRMATION_REQUIRED',
          message:'Reanalysis uses zero Odds API credits but may consume configured research-provider quota.'});
      try{
        const snapshot=await service.reanalyze();
        let tracked=0,trackingStatus='OK';
        try{tracked=await options.product?.track(snapshot,service.getEvidence())??0;}
        catch{trackingStatus='FAILED';}
        const status=service.getStatus();
        return {builtAt:snapshot.builtAt,lineCount:snapshot.board.lines.length,
          rankedCount:snapshot.rankedLineIds.length,research:status.research,
          evidenceCount:service.getEvidence().length,oddsCreditsUsed:0,tracked,trackingStatus,
          evidenceFreshness:status.evidenceFreshness,startupRecovery:status.startupRecovery,
        researchHealth:status.researchHealth,secondLook:status.secondLook,
          freshContext:status.freshContext};
      }catch{return reply.code(503).send({code:'BOARD_REANALYZE_FAILED'});}
    });
    ownerBoard.post('/refresh',async(request,reply)=>{
      if(!options.provider)return reply.code(503).send({code:'ODDS_PROVIDER_UNCONFIGURED'});
      const input=z.object({acknowledgeProviderCost:z.literal(true)}).strict().safeParse(request.body);
      if(!input.success)return reply.code(428).send({code:'PROVIDER_CREDITS_CONFIRMATION_REQUIRED',
        message:'A PrizePicks provider refresh may consume credits.'});
      // With scrapers feeding the board, the owner's paid pull runs The Odds API as the third source;
      // the board rebuilds once its lines are stored.
      if(options.scraperPuller?.hasSource('the-odds-api')){
        void options.scraperPuller.pull('the-odds-api');
        return reply.code(202).send({started:true,job:currentJob(),source:'the-odds-api'});
      }
      const started=startOwnerBoardRefresh();
      return reply.code(202).send({started,job:currentJob()});
    });
    // Paid web research (OpenAI searches) runs only when the owner asks for it.
    ownerBoard.post('/web-research',async(request,reply)=>{
      if(!webBuild||!options.webResearch)return reply.code(503).send({code:'WEB_RESEARCH_UNCONFIGURED'});
      const input=z.object({acknowledgeResearchCost:z.literal(true)}).strict().safeParse(request.body);
      if(!input.success)return reply.code(428).send({code:'RESEARCH_COST_CONFIRMATION_REQUIRED',
        message:'Web research uses OpenAI web searches, up to the configured maximum per run.'});
      const snapshot=service.getBoard();
      if(!snapshot)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
      if(webBuild.getStatus()?.status==='RUNNING')
        return reply.code(409).send({code:'WEB_RESEARCH_RUNNING',job:webBuild.getStatus()});
      return reply.code(202).send({job:webBuild.start(snapshot.board),
        maxSearches:options.webResearch.maxSearchesPerRun});
    });
    // First-board recovery from the Board tab. It can only spend credits when no board exists.
    // Run the line scraper now (spends Apify credit, within the daily cap). The board rebuilds after.
    ownerBoard.post('/scrapers/pull',async(request,reply)=>{
      if(!options.scraperPuller)return reply.code(503).send({code:'SCRAPERS_UNCONFIGURED'});
      const input=z.object({acknowledgeScraperCost:z.literal(true),source:z.string().min(1).optional()})
        .strict().safeParse(request.body);
      if(!input.success)return reply.code(428).send({code:'SCRAPER_COST_CONFIRMATION_REQUIRED',
        message:'A scraper pull spends Apify credit.'});
      void (input.data.source?options.scraperPuller.pull(input.data.source):options.scraperPuller.pullAll());
      return reply.code(202).send({started:true});
    });
    ownerBoard.post('/bootstrap',async(request,reply)=>{
      if(!options.provider)return reply.code(503).send({code:'ODDS_PROVIDER_UNCONFIGURED'});
      const input=z.object({acknowledgeProviderCost:z.literal(true)}).strict().safeParse(request.body);
      if(!input.success)return reply.code(428).send({code:'PROVIDER_CREDITS_CONFIRMATION_REQUIRED',
        message:'A PrizePicks provider refresh may consume credits.'});
      if(service.getBoard())return reply.code(409).send({code:'BOARD_EXISTS'});
      const started=startOwnerBoardRefresh();
      return reply.code(202).send({started,job:currentJob()});
    });
  },{prefix:'/v1/owner/board'});

  // A private research surface for exactly one server-configured profile. It is
  // intentionally disconnected from BoardService, GKR routing and the public API.
  app.register(async(owner)=>{
    owner.addHook('preHandler',async(request,reply)=>{
      reply.header('Cache-Control','private, no-store');
      const user=await currentUser(request);
      if(!options.ownerPublicId || user?.publicId!==options.ownerPublicId)
        return reply.code(404).send({code:'NOT_FOUND'});
    });
    owner.get('/status',async()=>({...options.ownerResearch?.status()??{
      configured:false,supportedSports:['NFL','NBA','MLB','PGA'],publicBoardImpact:'NONE'},
      notebook:options.ownerNotebook?.status()??null}));
    owner.get('/search',async(request,reply)=>{
      if(!options.ownerResearch)return reply.code(503).send({code:'STAT_API_UNCONFIGURED'});
      const query=z.object({sport:z.enum(['NFL','NBA','MLB','PGA']),q:z.string().trim().min(2).max(80)})
        .strict().safeParse(request.query);
      if(!query.success)return reply.code(400).send({code:'INVALID_PLAYER_QUERY'});
      try{return await options.ownerResearch.search(query.data.sport,query.data.q);}
      catch(error){return reply.code(error instanceof StatApiOwnerError?error.status:502)
        .send({code:error instanceof StatApiOwnerError?error.code:'STAT_API_UNAVAILABLE'});}
    });
    owner.get('/player/:sport/:id',async(request,reply)=>{
      if(!options.ownerResearch)return reply.code(503).send({code:'STAT_API_UNCONFIGURED'});
      const path=z.object({sport:z.enum(['NFL','NBA','MLB','PGA']),id:z.coerce.number().int().positive()
        .safe()}).safeParse(request.params);
      const query=z.object({table:z.enum(['game_player_stats','game_player_batter_stats',
        'game_player_pitching_stats','player_rounds','player_season_stats'])})
        .strict().safeParse(request.query);
      if(!path.success||!query.success)return reply.code(400).send({code:'INVALID_RESEARCH_LOOKUP'});
      try{return await options.ownerResearch.inspect(path.data.sport,path.data.id,query.data.table);}
      catch(error){return reply.code(error instanceof StatApiOwnerError?error.status:502)
        .send({code:error instanceof StatApiOwnerError?error.code:'STAT_API_UNAVAILABLE'});}
    });
    owner.get('/notebook',async(request,reply)=>{
      if(!options.ownerNotebook)return reply.code(503).send({code:'STAT_API_UNCONFIGURED'});
      return options.ownerNotebook.export();
    });
    owner.get('/export',async(request,reply)=>{
      if(!options.ownerNotebook)return reply.code(503).send({code:'STAT_API_UNCONFIGURED'});
      return reply.header('Content-Disposition',
        'attachment; filename="crowniq-owner-research.json"').send(options.ownerNotebook.export());
    });
    owner.post('/watch',async(request,reply)=>{
      if(!options.ownerNotebook)return reply.code(503).send({code:'STAT_API_UNCONFIGURED'});
      const input=z.object({sport:z.enum(['NFL','NBA','MLB','PGA']),
        playerId:z.number().int().positive().safe(),table:z.enum(['game_player_stats',
          'game_player_batter_stats','game_player_pitching_stats','player_rounds',
          'player_season_stats'])}).strict().safeParse(request.body);
      if(!input.success)return reply.code(400).send({code:'INVALID_RESEARCH_LOOKUP'});
      try{return await options.ownerNotebook.watch(input.data.sport,input.data.playerId,input.data.table);}
      catch(error){return reply.code(error instanceof StatApiOwnerError?error.status:502)
        .send({code:error instanceof StatApiOwnerError?error.code:'STAT_API_UNAVAILABLE'});}
    });
    owner.post('/unwatch',async(request,reply)=>{
      if(!options.ownerNotebook)return reply.code(503).send({code:'STAT_API_UNCONFIGURED'});
      const input=z.object({key:z.string().min(1).max(120)}).strict().safeParse(request.body);
      if(!input.success)return reply.code(400).send({code:'INVALID_RESEARCH_LOOKUP'});
      try{return await options.ownerNotebook.unwatch(input.data.key);}
      catch(error){return reply.code(error instanceof StatApiOwnerError?error.status:502)
        .send({code:error instanceof StatApiOwnerError?error.code:'STAT_API_UNAVAILABLE'});}
    });
    owner.put('/import',async(request,reply)=>{
      if(!options.ownerNotebook)return reply.code(503).send({code:'STAT_API_UNCONFIGURED'});
      try{return await options.ownerNotebook.importAnnotations(request.body);}
      catch(error){return reply.code(error instanceof StatApiOwnerError?error.status:502)
        .send({code:error instanceof StatApiOwnerError?error.code:'STAT_API_UNAVAILABLE'});}
    });
    owner.post('/refresh',async(request,reply)=>{
      if(!options.ownerNotebook)return reply.code(503).send({code:'STAT_API_UNCONFIGURED'});
      const input=z.object({acknowledgeRecords:z.literal(true)}).strict().safeParse(request.body);
      if(!input.success)return reply.code(400).send({code:'RESEARCH_RECORD_ACK_REQUIRED'});
      if(options.ownerNotebook.status().running)return reply.code(409).send({code:'RESEARCH_REFRESH_RUNNING'});
      void options.ownerNotebook.refreshAll().catch(()=>undefined);
      return reply.code(202).send({started:true});
    });
  },{prefix:'/v1/owner/research'});
  app.register(async(history)=>{
    history.addHook('preHandler',async(request,reply)=>{
      reply.header('Cache-Control','private, no-store');
      const user=await currentUser(request);
      if(!options.ownerPublicId || user?.publicId!==options.ownerPublicId)
        return reply.code(404).send({code:'NOT_FOUND'});
    });
    history.get('/status',async()=>{
      const store=await options.internalHistory?.status()??{rows:0,bySport:{},bySource:{},oldest:null,newest:null};
      return {store,backfill:options.historyBackfill?.status()??null,
        statApi:options.ownerResearch?.status()??{configured:false}};
    });
    history.get('/learning',async(_request,reply)=>{
      if(!options.product)return reply.code(503).send({code:'TRACKING_UNCONFIGURED'});
      const eligible=new Set(nflverseTrackedMarkets),pending=[];
      for(let offset=0;;offset+=500){
        const page=await options.product.listDecisions(offset,500);
        pending.push(...page.decisions.filter((item)=>item.grade==='PENDING'&&item.sport==='NFL'&&
          eligible.has(item.market)));
        if(offset+500>=page.total)break;
      }
      let mappingStatus:'MISSING'|'VALID'|'INVALID'='MISSING',mappedPending=0;
      if(options.nflverseMappingFile){
        try{
          const mappings=await readNflverseMappings(options.nflverseMappingFile);
          const mapped=new Set(mappings.map((item)=>JSON.stringify([item.eventId,item.playerId])));
          mappedPending=pending.filter((item)=>mapped.has(JSON.stringify([item.eventId,item.playerId]))).length;
          mappingStatus='VALID';
        }catch{mappingStatus='INVALID';}
      }
      return {...await options.product.learningSummary(),autoGrading:{
        enabled:options.autoGradingEnabled===true,
        automaticResolution:true,
        mappingConfigured:mappingStatus==='VALID',
        mappingStatus,
        pendingEligible:pending.length,
        manualMappedPending:mappedPending,
        autoResolvePending:pending.length-mappedPending,
        worker:options.autoGradingStatus?.()??null,
        source:'nflverse',
        markets:nflverseTrackedMarkets,
      }};
    });
    history.post('/backfill',async(request,reply)=>{
      if(!options.historyBackfill)return reply.code(503).send({code:'STAT_API_UNCONFIGURED'});
      const input=z.object({sports:z.array(z.enum(['NFL','NBA','MLB'])).min(1).max(3),
        maxPlayersPerSport:z.number().int().min(1).max(100).default(25),
        acknowledgeResearchCost:z.literal(true)}).strict().safeParse(request.body);
      if(!input.success)return reply.code(400).send({code:'INVALID_HISTORY_BACKFILL_REQUEST'});
      const board=service.getBoard();
      if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
      const targets=board.board.lines.map((line)=>({eventId:line.eventId,eventName:line.eventName,
        eventStartTime:line.eventStartTime,league:line.league,playerId:line.playerId,
        playerName:line.playerName,team:line.team,opponent:line.opponent,market:line.market,
        sport:line.sport}));
      const started=options.historyBackfill.start(targets,
        input.data.sports as InternalHistorySport[],input.data.maxPlayersPerSport);
      if(!started)return reply.code(409).send({code:'HISTORY_BACKFILL_RUNNING',
        job:options.historyBackfill.status()});
      return reply.code(202).send({started:true,oddsCreditsUsed:0,
        sports:input.data.sports,maxPlayersPerSport:input.data.maxPlayersPerSport,
        job:options.historyBackfill.status()});
    });
  },{prefix:'/v1/owner/history'});

  app.post('/v1/auth/logout',async(request,reply)=>{
    if(options.product && bearer(request))await options.product.logout(bearer(request));
    return {signedOut:true};
  });
  app.get('/v1/auth/nonce',async(_request,reply)=>{
    if(!options.identityVerifier)return reply.code(503).send({code:'PROVIDERS_UNCONFIGURED'});
    for(const [key,expiry] of nonces)if(expiry<now().getTime())nonces.delete(key);
    if(nonces.size>3000)nonces.clear();
    const nonce=randomBytes(24).toString('base64url');nonces.set(nonce,now().getTime()+300_000);
    return {nonce,expiresInSeconds:300};
  });
  app.post('/v1/auth/provider',async(request,reply)=>{
    if(!options.product||!options.identityVerifier)return reply.code(503).send({code:'PROVIDERS_UNCONFIGURED'});
    if(limited(`provider:${request.ip}`))return reply.code(429).send({code:'TOO_MANY_ATTEMPTS'});
    const input=z.object({provider:z.enum(['GOOGLE','APPLE']),idToken:z.string().min(20).max(16000),
      nonce:z.string().min(20).max(100),username:username.optional()}).strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'INVALID_PROVIDER_LOGIN'});
    if((nonces.get(input.data.nonce)??0)<=now().getTime())
      return reply.code(401).send({code:'INVALID_NONCE'});
    try {const identity=await options.identityVerifier.verify(input.data.provider,
      input.data.idToken,input.data.nonce);
      if(!nonces.delete(input.data.nonce))return reply.code(401).send({code:'INVALID_NONCE'});
      return await options.product.loginWithProvider(input.data.provider,identity.subject,
        identity.email,input.data.username);
    }catch(error){const code=(error as Error).message;
      if(['USERNAME_REQUIRED','USERNAME_TAKEN','ACCOUNT_LINK_REQUIRED'].includes(code))
        return reply.code(409).send({code});
      return reply.code(401).send({code:'PROVIDER_LOGIN_REJECTED'});}
  });
  app.post('/v1/auth/link',async(request,reply)=>{
    const user=await currentUser(request);
    if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(!options.product||!options.identityVerifier)return reply.code(503).send({code:'PROVIDERS_UNCONFIGURED'});
    const input=z.object({provider:z.enum(['GOOGLE','APPLE']),idToken:z.string().min(20).max(16000),
      nonce:z.string().min(20).max(100)}).strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'INVALID_PROVIDER_LINK'});
    if((nonces.get(input.data.nonce)??0)<=now().getTime())
      return reply.code(401).send({code:'INVALID_NONCE'});
    try {const identity=await options.identityVerifier.verify(input.data.provider as ProviderName,
      input.data.idToken,input.data.nonce);
      if(!nonces.delete(input.data.nonce))return reply.code(401).send({code:'INVALID_NONCE'});
      return await options.product.linkProvider(user.accountId,input.data.provider,identity.subject);
    }catch{return reply.code(422).send({code:'PROVIDER_LINK_REJECTED'});}
  });
  app.get('/v1/me/picks',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    const query=z.object({offset:z.coerce.number().int().nonnegative().default(0),
      limit:z.coerce.number().int().min(1).max(50).default(30)}).safeParse(request.query);
    if(!query.success)return reply.code(400).send({code:'INVALID_QUERY'});
    return options.product!.userPicks(user.accountId,query.data.offset,query.data.limit);
  });
  app.post('/v1/me/picks',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    const input=z.object({lineId:z.string().min(1).max(300)}).strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'INVALID_PICK'});
    const board=service.getBoard();if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
    try{return reply.code(201).send(await options.product!.saveUserPick(user.accountId,
      input.data.lineId,board,service.getEvidence()));}
    catch{return reply.code(422).send({code:'INVALID_OR_STALE_PICK'});}
  });
  app.delete('/v1/me/picks/:id',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    const input=z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).safeParse(request.params);
    if(!input.success)return reply.code(400).send({code:'INVALID_PICK_ID'});
    try {await options.product!.removeUserPick(user.accountId,input.data.id);return {removed:true};}
    catch{return reply.code(404).send({code:'PICK_NOT_FOUND'});}
  });
  app.get('/v1/me/crowns',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    return options.product!.userCrowns(user.accountId);
  });
  app.post('/v1/me/crowns',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    const input=z.object({lineIds:z.array(z.string().min(1).max(300)).min(2).max(6)})
      .strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'INVALID_CROWN'});
    const board=service.getBoard();if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
    try{return reply.code(201).send(await options.product!.savePrivateCrown(user.accountId,
      input.data.lineIds,board,service.getEvidence()));}
    catch(error){return reply.code(422).send({code:'CROWN_VALIDATION_FAILED',issues:crownIssues(error)});}
  });
  app.delete('/v1/me/crowns/:id',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    const input=z.object({id:z.string().uuid()}).safeParse(request.params);
    if(!input.success)return reply.code(400).send({code:'INVALID_CROWN_ID'});
    try{await options.product!.removeUserCrown(user.accountId,input.data.id);return {removed:true};}
    catch{return reply.code(404).send({code:'CROWN_NOT_FOUND'});}
  });
  app.get('/v1/board', async (_request, reply) => {
    const snapshot = service.getBoard();
    return snapshot ?? reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
  });
  // The Board list: upcoming games only, with slim PASS analyses. Free, like /v1/board.
  app.get('/v1/board/lite', async (_request, reply) => {
    const snapshot = service.getBoard();
    return snapshot ? liteBoard(snapshot, now()) : reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
  });
  app.get('/v1/rankings', async (_request, reply) => {
    const snapshot = service.getBoard();
    if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
    const watchlist=secondLookWatchlist(snapshot);
    return {
      builtAt: snapshot.builtAt,
      rankedLineIds: snapshot.rankedLineIds,
      analyses: snapshot.analyses.filter((analysis) => snapshot.rankedLineIds.includes(analysis.lineId)),
      rankings: rankingCards(snapshot),
      watchlistLineIds: watchlist.lineIds,
      watchlist: watchlist.cards,
    };
  });
  app.get('/v1/board/summary', async (_request, reply) => {
    const snapshot=service.getBoard();
    if(!snapshot)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
    const status=service.getStatus();
    return {boardFetchedAt:snapshot.board.fetchedAt,builtAt:snapshot.builtAt,
      rankedCount:snapshot.rankedLineIds.length,researchStatus:status.research,
      secondLook:status.secondLook,freshContext:status.freshContext,
      gradingStatus:!options.product?'TRACKING_UNCONFIGURED':options.autoGradingEnabled
        ? 'NFL_AUTO_GRADING':'AWAITING_VERIFIED_RESULTS',
      providerRefreshCost:0};
  });
  // Recent logged games for one player and market, from CrownIQ's internal history.
  // Values come from attributed stat rows only; nothing is filled in or inferred.
  app.get('/v1/players/:sport/:playerId/:market/games', async(request,reply)=>{
    const parsed=z.object({sport:z.string().min(1).max(20),playerId:z.string().min(1).max(200),
      market:z.string().min(1).max(80)}).safeParse(request.params);
    if(!parsed.success)return reply.code(400).send({code:'INVALID_GAME_LOG_REQUEST'});
    if(!options.internalHistory)return reply.code(404).send({code:'NO_HISTORY'});
    const line=service.getBoard()?.board.lines.find((item)=>item.playerId===parsed.data.playerId&&
      item.sport===parsed.data.sport);
    const log=await options.internalHistory.gameLog(parsed.data.sport,parsed.data.playerId,
      line?.playerName??null,parsed.data.market,now());
    return log&&log.games.length?log:reply.code(404).send({code:'NO_HISTORY'});
  });
  app.get('/v1/history/:sport/:playerId/:market', async(request,reply)=>{
    if(!options.product)return reply.code(503).send({code:'TRACKING_UNCONFIGURED'});
    const parsed=z.object({sport:z.string().min(1),playerId:z.string().min(1),
      market:z.string().min(1)}).safeParse(request.params);
    if(!parsed.success)return reply.code(400).send({code:'INVALID_HISTORY_REQUEST'});
    return options.product.history(parsed.data.sport,parsed.data.playerId,parsed.data.market);
  });
  const actor=async(request:FastifyRequest)=> options.socialActor
    ? options.socialActor(request) : (await currentUser(request))?.accountId??null;
  app.get('/v1/social/top-users',async(_request,reply)=>options.product
    ? options.product.topUsers() : reply.code(503).send({code:'SOCIAL_UNCONFIGURED'}));
  app.get('/v1/social/recent-crowns',async(_request,reply)=>options.product
    ? {crowns:await options.product.recentTopCrowns()} : reply.code(503).send({code:'SOCIAL_UNCONFIGURED'}));
  app.get('/v1/social/following-crowns',async(request,reply)=>{
    if(!options.product)return reply.code(503).send({code:'SOCIAL_UNCONFIGURED'});
    const actorKey=await actor(request);
    if(!actorKey)return reply.code(401).send({code:'SOCIAL_AUTH_REQUIRED'});
    return {crowns:await options.product.followingCrowns(actorKey)};
  });
  app.get('/v1/social/user/:publicId',async(request,reply)=>{
    if(!options.product)return reply.code(503).send({code:'SOCIAL_UNCONFIGURED'});
    const parsed=z.object({publicId:z.string().uuid()}).safeParse(request.params);
    if(!parsed.success)return reply.code(400).send({code:'INVALID_PUBLIC_ID'});
    const actorKey=await actor(request);
    const viewer=actorKey?await options.product.profileForActor(actorKey):null;
    return await options.product.profile(parsed.data.publicId,viewer?.publicId) ??
      reply.code(404).send({code:'PROFILE_NOT_FOUND'});
  });
  app.get('/v1/social/user/:publicId/crowns',async(request,reply)=>{
    if(!options.product)return reply.code(503).send({code:'SOCIAL_UNCONFIGURED'});
    const parsed=z.object({publicId:z.string().uuid(),offset:z.coerce.number().int().nonnegative().default(0),
      limit:z.coerce.number().int().min(1).max(30).default(10)}).safeParse({...request.params as object,...request.query as object});
    if(!parsed.success)return reply.code(400).send({code:'INVALID_CROWNS_QUERY'});
    return await options.product.crownsFor(parsed.data.publicId,parsed.data.offset,parsed.data.limit) ??
      reply.code(404).send({code:'PROFILE_NOT_FOUND'});
  });
  app.get('/v1/social/crowns/:id',async(request,reply)=>{
    if(!options.product)return reply.code(503).send({code:'SOCIAL_UNCONFIGURED'});
    const parsed=z.object({id:z.string().uuid()}).safeParse(request.params);
    if(!parsed.success)return reply.code(400).send({code:'INVALID_CROWN_ID'});
    return await options.product.crown(parsed.data.id) ?? reply.code(404).send({code:'CROWN_NOT_FOUND'});
  });
  app.get('/v1/social/crowns/:id/import-preview',async(request,reply)=>{
    if(!options.product)return reply.code(503).send({code:'SOCIAL_UNCONFIGURED'});
    const parsed=z.object({id:z.string().uuid()}).safeParse(request.params),board=service.getBoard();
    if(!parsed.success)return reply.code(400).send({code:'INVALID_CROWN_ID'});
    if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
    return await options.product.importPreview(parsed.data.id,board) ??
      reply.code(404).send({code:'CROWN_NOT_FOUND'});
  });
  app.register(async(social)=>{
    social.addHook('preHandler',async(request,reply)=>{
      if(!options.product || (!options.socialActor && !options.requireProfiles))
        return reply.code(503).send({code:'SOCIAL_IDENTITY_UNCONFIGURED'});
      if(!await actor(request))return reply.code(401).send({code:'SOCIAL_AUTH_REQUIRED'});
    });
    social.post('/profile',async(request,reply)=>{
      const parsed=z.object({displayName:username}).strict().safeParse(request.body);
      if(!parsed.success)return reply.code(400).send({code:'INVALID_PROFILE'});
      try{return await options.product!.upsertProfile((await actor(request))!,parsed.data.displayName);}
      catch{return reply.code(409).send({code:'USERNAME_TAKEN'});}
    });
    social.post('/follow/:publicId',async(request,reply)=>{
      const parsed=z.object({publicId:z.string().uuid()}).safeParse(request.params);
      if(!parsed.success)return reply.code(400).send({code:'INVALID_PUBLIC_ID'});
      try{return await options.product!.follow((await actor(request))!,parsed.data.publicId,true);}
      catch{return reply.code(422).send({code:'FOLLOW_REJECTED'});}
    });
    social.delete('/follow/:publicId',async(request,reply)=>{
      const parsed=z.object({publicId:z.string().uuid()}).safeParse(request.params);
      if(!parsed.success)return reply.code(400).send({code:'INVALID_PUBLIC_ID'});
      try{return await options.product!.follow((await actor(request))!,parsed.data.publicId,false);}
      catch{return reply.code(422).send({code:'UNFOLLOW_REJECTED'});}
    });
    social.post('/crowns',async(request,reply)=>{
      const parsed=z.object({lineIds:z.array(z.string().min(1)).min(2).max(6)}).strict().safeParse(request.body);
      if(!parsed.success)return reply.code(400).send({code:'INVALID_CROWN'});
      const board=service.getBoard();if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
      try{return reply.code(201).send(await options.product!.share((await actor(request))!,
        parsed.data.lineIds,board,service.getEvidence()));}
      catch(error){return reply.code(422).send({code:'CROWN_SHARE_REJECTED',issues:crownIssues(error)});}
    });
    social.delete('/crowns/:id',async(request,reply)=>{
      const parsed=z.object({id:z.string().uuid()}).safeParse(request.params);
      if(!parsed.success)return reply.code(400).send({code:'INVALID_CROWN_ID'});
      try{await options.product!.unshare((await actor(request))!,parsed.data.id);return {unshared:true};}
      catch{return reply.code(404).send({code:'CROWN_NOT_FOUND'});}
    });
  },{prefix:'/v1/social'});

  app.register(async (admin) => {
    admin.addHook('preHandler', async (request, reply) => {
      if (!options.adminToken) return reply.code(503).send({ code: 'ADMIN_UNCONFIGURED' });
      if (!authorized(request, options.adminToken)) return reply.code(401).send({ code: 'UNAUTHORIZED' });
    });
    admin.get('/status', async () => service.getStatus());
    admin.get('/evidence', async () => ({ evidence: service.getEvidence(),
      research: service.getStatus().research }));
    admin.get('/research/route/:lineId', async (request, reply) => {
      const path = z.object({ lineId: z.string().min(1) }).safeParse(request.params);
      if (!path.success) return reply.code(400).send({ code: 'INVALID_LINE_ID' });
      const snapshot = service.getBoard();
      if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
      const line = snapshot.board.lines.find((item) => item.id === path.data.lineId);
      if (!line) return reply.code(404).send({ code: 'LINE_NOT_FOUND' });
      return { route: routeResearch(line, service.getEvidence(),
        (options.clock ?? (() => new Date()))()),
        analysis: snapshot.analyses.find((item) => item.lineId === line.id) ?? null };
    });
    admin.get('/research/status', async (_request, reply) => webBuild
      ? { job: webBuild.getStatus(), catalog: options.webResearch!.getCatalogSummary() }
      : reply.code(503).send({ code: 'WEB_RESEARCH_UNCONFIGURED' }));
    admin.get('/research/catalog', async (request, reply) => {
      if (!options.webResearch) return reply.code(503).send({ code: 'WEB_RESEARCH_UNCONFIGURED' });
      const query = z.object({ offset: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(250).default(100),
        sport: z.string().optional() }).safeParse(request.query);
      if (!query.success) return reply.code(400).send({ code: 'INVALID_CATALOG_QUERY' });
      try { return await options.webResearch.getCatalog(query.data.offset,
        query.data.limit, query.data.sport); }
      catch { return reply.code(503).send({ code: 'RESEARCH_CATALOG_UNAVAILABLE' }); }
    });
    admin.post('/research/start', async (_request, reply) => {
      if (!webBuild) return reply.code(503).send({ code: 'WEB_RESEARCH_UNCONFIGURED' });
      const snapshot = service.getBoard();
      if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
      return reply.code(202).send({ job: webBuild.start(snapshot.board) });
    });
    admin.post('/research/cancel', async (_request, reply) => webBuild
      ? { job: webBuild.cancel() }
      : reply.code(503).send({ code: 'WEB_RESEARCH_UNCONFIGURED' }));
    // Admin pulls share the owner job: same cost confirmation, same single-pull lock.
    const adminPull=async(request:FastifyRequest,reply:FastifyReply)=>{
      if(request.headers['x-confirm-provider-cost']!=='yes')return reply.code(428).send({
        code:'PROVIDER_CREDITS_CONFIRMATION_REQUIRED',message:'A provider refresh may consume credits.'});
      if(!options.provider)return reply.code(503).send({code:'ODDS_PROVIDER_UNCONFIGURED'});
      if(!startOwnerBoardRefresh())return reply.code(409).send({code:'PULL_RUNNING',job:currentJob()});
      const snapshot=await pullDone;
      if(!snapshot)return reply.code(502).send({code:'BOARD_REFRESH_FAILED'});
      return {builtAt:snapshot.builtAt,lineCount:snapshot.board.lines.length,
        rankedCount:snapshot.rankedLineIds.length,research:service.getStatus().research,
        webResearchJob:ownerBoardRefresh.webResearchJob,tracked:ownerBoardRefresh.tracked,
        trackingStatus:ownerBoardRefresh.trackingStatus,creditsSpent:ownerBoardRefresh.creditsSpent,
        creditsRemaining:ownerBoardRefresh.creditsRemaining};
    };
    admin.post('/refresh',adminPull);
    admin.post('/reanalyze', async (request, reply) => {
      const input=z.object({acknowledgeResearchCost:z.boolean().optional()}).strict()
        .safeParse(request.body??{});
      if(!input.success)return reply.code(400).send({code:'INVALID_REANALYZE_REQUEST'});
      if((options.research||options.secondLookResearch) && input.data.acknowledgeResearchCost!==true)
        return reply.code(428).send({code:'RESEARCH_COST_CONFIRMATION_REQUIRED',
          message:'Reanalysis uses zero Odds API credits but may consume configured research-provider quota.'});
      try {
        const snapshot = await service.reanalyze();
        let tracked=0,trackingStatus='OK';
        try {tracked=await options.product?.track(snapshot,service.getEvidence())??0;}
        catch {trackingStatus='FAILED';}
        return { builtAt: snapshot.builtAt, rankedCount: snapshot.rankedLineIds.length,
          research: service.getStatus().research, oddsCreditsUsed: 0,tracked,trackingStatus };
      } catch { return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' }); }
    });
    admin.post('/force-provider-refresh',adminPull);
    admin.get('/tracked-decisions',async(request,reply)=>{
      if(!options.product)return reply.code(503).send({code:'TRACKING_UNCONFIGURED'});
      const parsed=z.object({offset:z.coerce.number().int().nonnegative().default(0),
        limit:z.coerce.number().int().min(1).max(250).default(100)}).safeParse(request.query);
      if(!parsed.success)return reply.code(400).send({code:'INVALID_QUERY'});
      return options.product.listDecisions(parsed.data.offset,parsed.data.limit);
    });
    admin.post('/tracked-results',async(request,reply)=>{
      if(!options.product)return reply.code(503).send({code:'TRACKING_UNCONFIGURED'});
      const parsed=z.object({results:z.array(resultFactSchema).min(1).max(1000)}).strict().safeParse(request.body);
      if(!parsed.success)return reply.code(400).send({code:'INVALID_RESULTS'});
      try{return await options.product.grade(parsed.data.results);}
      catch{return reply.code(422).send({code:'RESULT_GRADE_REJECTED'});}
    });
    admin.get('/selections', async (_request, reply) => options.selections
      ? options.selections.list() : reply.code(503).send({ code: 'SELECTION_STORAGE_UNCONFIGURED' }));
    admin.get('/performance', async (_request, reply) => options.selections
      ? { groups: summarizeNflPilot(await options.selections.list()) }
      : reply.code(503).send({ code: 'SELECTION_STORAGE_UNCONFIGURED' }));
    admin.post('/selections', async (request, reply) => {
      if (!options.selections) return reply.code(503).send({ code: 'SELECTION_STORAGE_UNCONFIGURED' });
      const body = z.object({ lineId: z.string().min(1) }).strict().safeParse(request.body);
      if (!body.success) return reply.code(400).send({ code: 'INVALID_SELECTION' });
      const snapshot = service.getBoard();
      if (!snapshot) return reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
      const line = snapshot.board.lines.find((item) => item.id === body.data.lineId);
      const analysis = snapshot.analyses.find((item) => item.lineId === body.data.lineId);
      if (!line || !analysis || line.sport !== 'NFL' ||
        !['passing_yards', 'player_pass_attempts'].includes(line.market)) {
        return reply.code(422).send({ code: 'UNSUPPORTED_PILOT_SELECTION' });
      }
      try {
        const selected = snapshotSelection(line, analysis, service.getEvidence(),
          (options.clock ?? (() => new Date()))());
        await options.selections.save(selected);
        return reply.code(201).send(selected);
      } catch { return reply.code(422).send({ code: 'INELIGIBLE_OR_DUPLICATE_SELECTION' }); }
    });
    admin.post('/results', async (request, reply) => {
      if (!options.selections) return reply.code(503).send({ code: 'SELECTION_STORAGE_UNCONFIGURED' });
      const payload = z.object({ results: z.array(nflPassingResultSchema).min(1).max(1000) })
        .strict().safeParse(request.body);
      if (!payload.success) return reply.code(400).send({ code: 'INVALID_RESULTS' });
      try { return await options.selections.grade(payload.data.results,
        (options.clock ?? (() => new Date()))()); }
      catch { return reply.code(422).send({ code: 'RESULT_GRADE_REJECTED' }); }
    });
    admin.post('/grade/nflverse', async (_request, reply) => {
      if (!options.selections || !options.nflverseMappingFile) {
        return reply.code(503).send({ code: 'GRADING_UNCONFIGURED' });
      }
      try {
        const pending = (await options.selections.list()).filter((item) => item.grade === 'PENDING' &&
          item.line.sport === 'NFL' && ['passing_yards', 'player_pass_attempts'].includes(item.line.market));
        const mappings = await readNflverseMappings(options.nflverseMappingFile);
        const byIdentity = new Map(mappings.map((row) => [
          JSON.stringify([row.eventId, row.playerId]), row]));
        const paired = pending.flatMap((item) => {
          const mapping = byIdentity.get(JSON.stringify([item.line.eventId, item.line.playerId]));
          return mapping ? [{ item, mapping }] : [];
        });
        const now = (options.clock ?? (() => new Date()))();
        const seasons = [...new Set(paired.filter(({ mapping }) =>
          Date.parse(mapping.completedAt) <= now.getTime()).map(({ mapping }) => mapping.season))];
        const feed = options.nflverseFeed ?? new NflverseResultsFeed();
        const stats = new Map(await Promise.all(seasons.map(async (season) => [season,
          await feed.fetchSeason(season)] as const)));
        const results = paired.flatMap(({ item, mapping }) => {
          const rows = stats.get(mapping.season);
          const result = rows ? resultFromNflverse(item, mapping, rows, now) : null;
          return result ? [result] : [];
        });
        // More than one saved threshold for a player/market shares one result record.
        const unique = [...new Map(results.map((item) => [JSON.stringify([
          item.eventId, item.playerId, item.market]), item])).values()];
        const graded = await options.selections.grade(unique, now);
        return { ...graded, pending: pending.length - graded.graded,
          unmapped: pending.length - paired.length, source: 'nflverse' };
      } catch { return reply.code(502).send({ code: 'NFLVERSE_GRADING_FAILED' }); }
    });
  }, { prefix: '/v1/admin' });

  if (options.webAppDir) serveWebApp(app, options.webAppDir);
  return app;
}
