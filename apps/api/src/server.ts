import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bestBreakEven, DEFAULT_PAYOUTS, entryBreakEvens, nflPassingResultSchema, pickAppSchema } from '@crowniq/contracts';
import { ModelRegistry, routeResearch, snapshotSelection } from '@crowniq/engine';
import type { OddsProvider, ResearchAdapter } from '@crowniq/engine';
import type { BoardResponse, Payouts, PropLine } from '@crowniq/contracts';
import { idlePullJob } from './owner-pull-job.js';
import type { OwnerPullJob, OwnerPullJobStore } from './owner-pull-job.js';
import { BoardService } from './board-service.js';
import type { SelectionLedger } from './selection-ledger.js';
import { summarizeNflPilot } from './selection-ledger.js';
import { nflverseTrackedMarkets, NflverseResultsFeed, readNflverseMappings,
  resultFromNflverse } from './nflverse-results.js';
import type { WebResearchService } from './web-research.js';
import { ResearchBuild } from './research-build.js';
import { ProductLedger, resultFactSchema } from './product-ledger.js';
import type { GuestPass } from './product-ledger.js';
import type { BoardCache } from './board-cache.js';
import { boardFunnel, outcomeCounts } from './board-funnel.js';
import { liteBoard, windowBoard } from './board-lite.js';
import { ContextRefreshScheduler } from './context-refresh.js';
import { appBoard, appCoverage, appScores, asBoard, otherApps, portLegs } from './app-boards.js';
import type { AppScore } from './app-boards.js';
import type { OtherApp } from './app-boards.js';
import type { ScrapedLineStore } from './scrapers/line-store.js';
import { AppShadowScorer } from './app-shadow.js';
import { realNews } from './ai-picks.js';
import type { AiPickService, AiRead } from './ai-picks.js';
import type { BoxScoreResults } from './box-score-results.js';
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
import type { ContextFeeds, GameLine, InjuryNote, MarketOdds } from './context/feeds.js';
import { gameLinesFor, injuryFor, marketsFor, normalizedName } from './context/match.js';
import type { SharpPropsFeed } from './context/sharp-props.js';
import { booksPicks, bookViews, DEFAULT_BREAK_EVEN, evPicks } from './context/ev.js';
import { bookLadder, bookPicks, sportsbookNames, sportsbooks } from './book-picks.js';
import { marketLine, marketPicks, marketQuestion } from './market-picks.js';
import { gameScriptFor, scriptEligible } from './shadow-record.js';
import { betaFor } from './scout-beta.js';
import type { BetaRead } from './scout-beta.js';
import type { LiveMarkets } from './market-live.js';
import type { MarketRecord } from './market-record.js';
import type { HistoryArchive } from './history-archive.js';
import type { ShadowPick, ShadowRecord } from './shadow-record.js';
import type { MarketPlatform } from './market-picks.js';
import type { BookPick, Sportsbook } from './book-picks.js';
import { serveWebApp } from './web-app.js';

/** How far ahead the public demo shows real lines. */
const DEMO_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface ServerOptions {
  provider?: OddsProvider | null;
  /** Folder holding the exported web app, served at every non-API path. */
  webAppDir?: string | null;
  research?: ResearchAdapter | null;
  secondLookResearch?: ResearchAdapter | null;
  webResearch?: WebResearchService | null;
  models?: ModelRegistry;
  adminToken?: string;
  /** A shared guest link (`/?guest=<code>`); unset means no guest link works. */
  guestPass?: GuestPass | null;
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
  /** Scraped pick'em lines (Underdog, Pick6 boards). */
  scrapedLines?: ScrapedLineStore | null;
  /** Underdog/Pick6 shadow scoring (Phase 1 of docs/PROPOSAL_APP_SCORING.md): where its record is kept, and its grader. */
  appShadow?: { file: string | null; boxScores: BoxScoreResults | null } | null;
  /** GKR scores on Underdog/Pick6 lines (owner approved 2026-10-04; CROWNIQ_APP_GKR_SCORES). */
  appGkrScores?: boolean;
  /** AI reads (ChatGPT + Claude) on lines GKR can't score; their own score, never GKR's. */
  aiPicks?: AiPickService | null;
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
  /** Display-only game context feeds (injuries, Pinnacle, Kalshi, Polymarket); never scored. */
  contextFeeds?: ContextFeeds | null;
  /** DraftKings and Hard Rock prop prices (SharpAPI) for reference odds and CrownIQ's own +EV; never scored. */
  sharpProps?: SharpPropsFeed | null;
  /** Break-even chance per pick for +EV (default 54.21%, PrizePicks' best Flex). */
  evBreakEven?: number;
  /** Each app's payout tables (defaults, or CROWNIQ_PAYOUTS merged over them). */
  payouts?: Payouts;
  /** Shadow records: Books picks, sportsbook-tab picks and game-script snapshots, graded in their own record. */
  shadowRecord?: ShadowRecord | null;
  /** Kalshi and Polymarket picks, graded from final scores. */
  marketRecord?: MarketRecord | null;
  /** CrownIQ's own archive of game logs, graded results and lines. */
  historyArchive?: HistoryArchive | null;
  /** Reads The Odds API's credit balance (a free call), for the owner. */
  oddsApiQuota?: (() => Promise<{ status: number; remaining: number | null; used: number | null }>) | null;
  /** Live Kalshi and Polymarket prices from their free public APIs. */
  liveMarkets?: LiveMarkets | null;
  /** JSON-lines history of the books' view of board lines, one row per line per refresh. */
  booksHistoryFile?: string | null;
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
      !path.startsWith('/v1/admin/') && !path.startsWith('/v1/auth/') && !path.startsWith('/v1/demo/') &&
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
    options.contextFeeds?.start();
    // Keep what the books said about each board line over time, so a "books agree" factor can be measured on graded results.
    options.sharpProps?.whenRefreshed(async(prices,at)=>{
      const board=service.getBoard();
      if(!board||!options.booksHistoryFile)return;
      const lines=new Map(board.board.lines.map((line)=>[line.id,line]));
      const rows=[...bookViews(board,prices,at)].map(([lineId,view])=>{const line=lines.get(lineId)!;
        return JSON.stringify({at:at.toISOString(),lineId,sport:line.sport,playerId:line.playerId,playerName:line.playerName,
          eventId:line.eventId,eventStartTime:line.eventStartTime,market:line.market,threshold:line.threshold,
          fairMore:view.fairMore,books:view.books.map((book)=>book.book)});});
      if(rows.length){await mkdir(dirname(options.booksHistoryFile),{recursive:true});
        await appendFile(options.booksHistoryFile,rows.join('\n')+'\n');}
    });
    options.sharpProps?.start(60);
    appShadow?.start();
    // The scheduled AI run reads the books' fair prices through the same cache as the routes.
    let latestFair=new Map<string,number>();
    const refreshFair=()=>{void fairMoreFor().then((views)=>{latestFair=views;}).catch(()=>undefined);};
    if(options.aiPicks?.configured){refreshFair();const every=setInterval(refreshFair,10*60_000);every.unref();}
    options.aiPicks?.start(()=>service.getBoard(),()=>service.getEvidence(),(lineId)=>latestFair.get(lineId)??null);
    if(options.ownerNotebook && options.ownerPublicId){
      await options.ownerNotebook.load();options.ownerNotebook.start();
    }
  });
  const webBuild = options.webResearch ? new ResearchBuild(service, options.webResearch,
    options.clock,options.product ? async()=>{const board=service.getBoard();
      if(board){await service.persist();await options.product!.track(board,service.getEvidence());}} :
      async()=>service.persist()) : null;
  const contextScheduler=options.contextRefresh?new ContextRefreshScheduler(service,options.contextRefresh):null;
  // Shadow only: app plays are recorded and graded under shadow versions, never shown or added to GKR's record.
  const appShadow=options.appShadow&&options.scrapedLines?new AppShadowScorer(options.scrapedLines,service,
    options.appShadow.file,options.appShadow.boxScores,options.product?async(since,minScore)=>{
      let graded=0,wins=0;
      for(let offset=0;;offset+=500){
        const page=await options.product!.listDecisions(offset,500);
        for(const item of page.decisions)if(item.lineScore>=minScore&&item.eventStartTime>=since&&
          (item.grade==='WIN'||item.grade==='LOSS')){graded++;if(item.grade==='WIN')wins++;}
        if(offset+500>=page.total)break;
      }
      return {graded,wins};
    }:null,options.clock):null;
  // Shadow records: Books picks, the sportsbook tabs' picks and game-script snapshots, saved every 15 minutes and graded
  // hourly in their own record (never GKR's).
  const shadowTimers:NodeJS.Timeout[]=[];
  let recordShadow:()=>Promise<{found:Record<string,number>;added:number}|null>=async()=>null;
  if(options.shadowRecord){
    const shadow=options.shadowRecord;
    recordShadow=async()=>{
      const board=service.getBoard();
      if(!board)return null;
      const picks:ShadowPick[]=[];
      const lines=new Map(board.board.lines.map((line)=>[line.id,line]));
      if(options.sharpProps){
        const {prices}=await options.sharpProps.current();
        for(const [lineId,pick] of booksPicks(board,bookViews(board,prices,now())))
          picks.push({kind:'books',line:lines.get(lineId)!,side:pick.side,strength:pick.fair});
        for(const book of sportsbooks){
          const result=await picksFor(book);
          for(const pick of result?.picks??[]){const line=result!.lines.get(pick.id);
            if(line)picks.push({kind:`book:${book}`,line,side:pick.side,strength:pick.gkr.score});}
        }
      }
      // GKR and GKR Beta on the same plays, so their records compare fairly.
      // Saved once Scout has read the line, so the Beta entry reflects Scout's research.
      for(const [lineId,beta] of await betaReads(board)){
        const line=lines.get(lineId)!;
        if(!beta.scouted)continue;
        picks.push({kind:'gkr',line,side:beta.gkr.direction,strength:beta.gkr.score});
        if(beta.direction==='PASS')picks.push({kind:'beta-pass',line,side:beta.gkr.direction,strength:beta.gkr.score});
        else picks.push({kind:'beta',line,side:beta.direction,strength:beta.score});
      }
      if(options.contextFeeds){
        const games=(await options.contextFeeds.items<GameLine>('pinnacle')).items;
        const markets=[...(await marketItems('kalshi')).items,...(await marketItems('polymarket')).items];
        for(const analysis of board.analyses){
          const line=lines.get(analysis.lineId);
          if(!line||analysis.direction==='PASS'||analysis.score===null||!scriptEligible(line))continue;
          const script=gameScriptFor(line,games,markets);
          if(script)picks.push({kind:'script',line,side:analysis.direction,strength:analysis.score,script});
        }
      }
      // Kalshi and Polymarket picks go to their own record.
      if(options.marketRecord){
        const market=(await Promise.all((['kalshi','polymarket'] as const).map(async(platform)=>(await marketPicksFor(platform))?.picks??[]))).flat();
        await options.marketRecord.record(market);
      }
      const found:Record<string,number>={};
      for(const pick of picks)found[pick.kind]=(found[pick.kind]??0)+1;
      return {found,added:await shadow.record(picks)};
    };
    const first=setTimeout(()=>{void recordShadow().catch(()=>undefined);},90_000);first.unref();
    const every=setInterval(()=>{void recordShadow().catch(()=>undefined);},15*60_000);every.unref();
    const grading=setInterval(()=>{void shadow.grade().catch(()=>undefined);
      void options.marketRecord?.grade().catch(()=>undefined);},60*60_000);grading.unref();
    shadowTimers.push(first,every,grading);
  }
  // Scout second opinions on the new tabs: the sportsbooks' strongest GKR picks (one per player and stat across both
  // books), then each market's biggest edges. They share Scout's second-opinion caps.
  let extraSeconds:{line:PropLine;gkr:NonNullable<AiRead['gkr']>;question?:ReturnType<typeof marketQuestion>}[]=[];
  const refreshExtraSeconds=async()=>{
    const next:typeof extraSeconds=[];const seen=new Set<string>();
    const bookPicksAll=(await Promise.all(sportsbooks.map(async(book)=>{const result=await picksFor(book);
      return (result?.picks??[]).map((pick)=>({pick,line:result!.lines.get(pick.id)}));}))).flat()
      .sort((a,b)=>b.pick.gkr.score-a.pick.gkr.score);
    for(const {pick,line} of bookPicksAll){
      const key=`${line?.eventId}|${line?.playerId}|${pick.market}`;
      if(!line||seen.has(key)||next.length>=6)continue;
      seen.add(key);next.push({line,gkr:{direction:pick.side,score:pick.gkr.score,modelVersion:pick.gkr.modelVersion}});
    }
    for(const platform of ['kalshi','polymarket'] as const){
      const result=await marketPicksFor(platform);
      for(const pick of (result?.picks??[]).slice(0,3)){const line=marketLine(pick,now());
        if(line)next.push({line,gkr:{direction:'MORE',score:null,modelVersion:'market-edge'},question:marketQuestion(pick,line)});}
    }
    extraSeconds=next;
    // Scout's own picks on Underdog and Pick6 lines for players PrizePicks doesn't list (GKR has no research for them).
    if(options.scrapedLines){
      const lines:PropLine[]=[];
      for(const app of otherApps){
        const board=await appBoard(options.scrapedLines,app,service.getBoard()),scores=await scoresFor(app);
        const only=board.lines.filter((line)=>!line.prizePicks&&!scores.has(line.id));
        if(only.length)lines.push(...asBoard(only,board.fetchedAt??now().toISOString()).board.lines);
      }
      extraScout=lines;
    }
  };
  let extraScout:PropLine[]=[];
  if(options.aiPicks?.configured){
    options.aiPicks.setExtraSecondOpinions(()=>extraSeconds);
    options.aiPicks.setExtraScoutLines(()=>extraScout);
    const firstExtra=setTimeout(()=>{void refreshExtraSeconds().catch(()=>undefined);},60_000);firstExtra.unref();
    const everyExtra=setInterval(()=>{void refreshExtraSeconds().catch(()=>undefined);},15*60_000);everyExtra.unref();
    shadowTimers.push(firstExtra,everyExtra);
  }
  options.liveMarkets?.start();
  app.addHook('onClose', async () => {for(const timer of shadowTimers)clearTimeout(timer);options.liveMarkets?.stop();appShadow?.stop();options.aiPicks?.stop(); webBuild?.cancel();options.ownerNotebook?.stop();contextScheduler?.stop();
    options.scraperPuller?.stop();options.contextFeeds?.stop();options.sharpProps?.stop(); });

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
      if(code==='MEMBERS_FULL'||code==='LIFETIME_FULL')return reply.code(403).send({code});
      return reply.code(503).send({code:'PROFILE_STORAGE_UNAVAILABLE'});}
  });
  app.post('/v1/auth/login',async(request,reply)=>{
    if(!options.product)return reply.code(503).send({code:'PROFILES_UNCONFIGURED'});
    if(limited(`login:${request.ip}`))return reply.code(429).send({code:'TOO_MANY_ATTEMPTS'});
    // `login` is the email or the username; older apps send `email`.
    const entered=z.string().trim().min(1).max(254);
    const input=z.object({login:entered.optional(),email:entered.optional(),password:z.string().min(1).max(128)})
      .strict().refine((value)=>!!(value.login??value.email)).safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'INVALID_LOGIN'});
    try{return await options.product.login((input.data.login??input.data.email)!,input.data.password);}
    catch{return reply.code(401).send({code:'INVALID_CREDENTIALS'});}
  });
  app.post('/v1/auth/guest',async(request,reply)=>{
    if(!options.product||!options.guestPass)return reply.code(404).send({code:'GUEST_PASS_INVALID'});
    if(limited(`guest:${request.ip}`))return reply.code(429).send({code:'TOO_MANY_ATTEMPTS'});
    const input=z.object({code:z.string().trim().min(1).max(100),deviceId:z.string().min(16).max(100)})
      .strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'GUEST_PASS_INVALID'});
    try{return await options.product.guestLogin(options.guestPass,input.data.code,input.data.deviceId);}
    catch(error){const code=(error as Error).message;
      if(code==='GUEST_PASS_FULL'||code==='GUEST_PASS_EXPIRED')return reply.code(403).send({code});
      if(code==='GUEST_PASS_INVALID'||code==='ACCOUNT_SUSPENDED')return reply.code(404).send({code:'GUEST_PASS_INVALID'});
      return reply.code(503).send({code:'PROFILE_STORAGE_UNAVAILABLE'});}
  });
  app.get('/v1/auth/me',async(request,reply)=>{
    const user=await currentUser(request);
    return user?{profile:{publicId:user.publicId,username:user.username,email:user.email,
      plan:user.plan,...user.mustChangePassword?{mustChangePassword:true}:{}}}:reply.code(401).send({code:'SIGN_IN_REQUIRED'});
  });
  // Forgot password: the member enters the one-time code the owner gave them and a new password.
  app.post('/v1/auth/reset',async(request,reply)=>{
    if(!options.product)return reply.code(503).send({code:'PROFILES_UNCONFIGURED'});
    if(limited(`reset:${request.ip}`))return reply.code(429).send({code:'TOO_MANY_ATTEMPTS'});
    const input=z.object({login:z.string().trim().min(1).max(254),code:z.string().trim().min(8).max(20),newPassword:password})
      .strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'INVALID_RESET'});
    try{return await options.product.resetPassword(input.data.login,input.data.code,input.data.newPassword);}
    catch(error){const code=(error as Error).message;
      if(code==='RESET_INVALID')return reply.code(403).send({code});
      if(code==='PASSWORD_NOT_NEW')return reply.code(409).send({code});
      return reply.code(503).send({code:'PROFILE_STORAGE_UNAVAILABLE'});}
  });
  // The owner makes a one-time reset code for a member who forgot their password (no email service yet).
  app.post('/v1/owner/members/reset-code',async(request,reply)=>{
    const user=await currentUser(request);
    if(!options.product||!options.ownerPublicId||user?.publicId!==options.ownerPublicId)return reply.code(404).send({code:'NOT_FOUND'});
    const input=z.object({login:z.string().trim().min(1).max(254)}).strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'LOGIN_REQUIRED'});
    try{return await options.product.createResetCode(input.data.login);}
    catch(error){return (error as Error).message==='ACCOUNT_NOT_FOUND'?reply.code(404).send({code:'ACCOUNT_NOT_FOUND'})
      :reply.code(503).send({code:'PROFILE_STORAGE_UNAVAILABLE'});}
  });
  // The owner's member list, and revoking or restoring any account's access.
  app.get('/v1/owner/members',async(request,reply)=>{
    const user=await currentUser(request);
    if(!options.product||!options.ownerPublicId||user?.publicId!==options.ownerPublicId)return reply.code(404).send({code:'NOT_FOUND'});
    return {members:await options.product.members(),seats:await options.product.membership()};
  });
  app.post('/v1/owner/members/access',async(request,reply)=>{
    const user=await currentUser(request);
    if(!options.product||!options.ownerPublicId||user?.publicId!==options.ownerPublicId)return reply.code(404).send({code:'NOT_FOUND'});
    const input=z.object({publicId:z.string().uuid(),access:z.enum(['REVOKE','RESTORE'])}).strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'MEMBER_REQUIRED'});
    try{return await options.product.setAccess(input.data.publicId,input.data.access==='REVOKE',options.ownerPublicId);}
    catch(error){const code=(error as Error).message;
      return code==='ACCOUNT_NOT_FOUND'?reply.code(404).send({code}):code==='CANNOT_REVOKE_OWNER'||code==='MEMBERS_FULL'
        ?reply.code(409).send({code}):reply.code(503).send({code:'PROFILE_STORAGE_UNAVAILABLE'});}
  });
  // Delete account: removes the member's account and personal data (App Store and Google Play require it).
  app.post('/v1/auth/delete',async(request,reply)=>{
    const user=await currentUser(request);
    if(!user||!options.product)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(limited(`delete:${request.ip}`))return reply.code(429).send({code:'TOO_MANY_ATTEMPTS'});
    const input=z.object({confirmation:z.string().min(1).max(128)}).strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'CONFIRMATION_REQUIRED'});
    try{await options.product.deleteAccount(user.accountId,input.data.confirmation);return {deleted:true};}
    catch(error){const code=(error as Error).message;
      if(code==='INVALID_CREDENTIALS'||code==='CONFIRMATION_REQUIRED')return reply.code(403).send({code});
      return reply.code(503).send({code:'PROFILE_STORAGE_UNAVAILABLE'});}
  });
  app.post('/v1/auth/password',async(request,reply)=>{
    const user=await currentUser(request);
    if(!user||!options.product)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(limited(`password:${request.ip}`))return reply.code(429).send({code:'TOO_MANY_ATTEMPTS'});
    const input=z.object({currentPassword:z.string().min(1).max(128),newPassword:password}).strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'INVALID_PASSWORD'});
    try{await options.product.changePassword(user.accountId,input.data.currentPassword,input.data.newPassword);return {ok:true};}
    catch(error){const code=(error as Error).message;
      if(code==='INVALID_CREDENTIALS')return reply.code(403).send({code});
      if(code==='PASSWORD_NOT_NEW'||code==='NO_PASSWORD')return reply.code(409).send({code});
      return reply.code(503).send({code:'PROFILE_STORAGE_UNAVAILABLE'});}
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
        contextFeeds:await options.contextFeeds?.status()??null,
        sharpProps:await options.sharpProps?.status()??null,
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
      if(code==='MEMBERS_FULL')return reply.code(403).send({code});
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
    // `personal` Crowns hold the user's own calls (one side per line in `directions`) and skip GKR's rules.
    const input=z.object({lineIds:z.array(z.string().min(1).max(300)).min(2).max(6),personal:z.literal(true).optional(),
      directions:z.record(z.string(),z.enum(['MORE','LESS'])).optional(),app:z.enum(['underdog','pick6']).optional()})
      .strict().refine((value)=>!value.personal||value.lineIds.every((id)=>value.directions?.[id]))
      .safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'INVALID_CROWN'});
    // An Underdog or Pick6 slip: the user's own picks on that app's lines, graded with Your Picks.
    if(input.data.app){
      if(!options.scrapedLines||!input.data.directions)return reply.code(400).send({code:'INVALID_CROWN'});
      const appLines=await appBoard(options.scrapedLines,input.data.app,null);
      try{return reply.code(201).send({...await options.product!.savePersonalCrown(user.accountId,
        input.data.lineIds.map((lineId)=>({lineId,direction:input.data.directions![lineId]!})),
        asBoard(appLines.lines,appLines.fetchedAt??new Date().toISOString(),await scoresFor(input.data.app)),input.data.app),
        personal:true,app:input.data.app});}
      catch(error){return reply.code(422).send({code:'CROWN_VALIDATION_FAILED',issues:crownIssues(error)});}
    }
    const board=service.getBoard();if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
    const personal=()=>options.product!.savePersonalCrown(user.accountId,input.data.lineIds.map((lineId)=>({lineId,
      direction:input.data.directions?.[lineId]??board.analyses.find((item)=>item.lineId===lineId)?.direction as 'MORE'|'LESS'})),
      board);
    if(input.data.personal){
      try{return reply.code(201).send({...await personal(),personal:true});}
      catch(error){return reply.code(422).send({code:'CROWN_VALIDATION_FAILED',issues:crownIssues(error)});}
    }
    try{return reply.code(201).send({...await options.product!.savePrivateCrown(user.accountId,input.data.lineIds,board,
      service.getEvidence()),personal:false});}
    catch(error){
      // A Crown that misses GKR's rules (a leg under the Crown minimum, a stale score) is still the user's Crown:
      // it is kept and graded as their own picks, separate from GKR's record.
      const belowGkr=crownIssues(error);
      try{return reply.code(201).send({...await personal(),personal:true,belowGkr});}
      catch(fallback){return reply.code(422).send({code:'CROWN_VALIDATION_FAILED',issues:crownIssues(fallback)});}
    }
  });
  app.delete('/v1/me/crowns/:id',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    const input=z.object({id:z.string().uuid()}).safeParse(request.params);
    if(!input.success)return reply.code(400).send({code:'INVALID_CROWN_ID'});
    try{await options.product!.removeUserCrown(user.accountId,input.data.id);return {removed:true};}
    catch{return reply.code(404).send({code:'CROWN_NOT_FOUND'});}
  });
  // Display-only game context for one board line: injury, game lines and prediction-market odds. Never scored.
  app.get('/v1/context/line/:lineId', async (request, reply) => {
    const parsed=z.object({lineId:z.string().min(1).max(300)}).safeParse(request.params);
    if(!parsed.success)return reply.code(400).send({code:'INVALID_LINE'});
    const line=service.getBoard()?.board.lines.find((item)=>item.id===parsed.data.lineId);
    if(!line)return reply.code(404).send({code:'LINE_NOT_FOUND'});
    if(!options.contextFeeds)return {injury:null,teamInjuries:[],game:[],markets:[]};
    const [injuries,pinnacle,kalshi,polymarket]=await Promise.all([options.contextFeeds.items<InjuryNote>('injuries'),
      options.contextFeeds.items<GameLine>('pinnacle'),options.contextFeeds.items<MarketOdds>('kalshi'),
      options.contextFeeds.items<MarketOdds>('polymarket')]);
    const game=gameLinesFor(line,pinnacle.items);
    const team=line.team;
    const teamInjuries=team?injuries.items.filter((item)=>item.league.toUpperCase()===line.league.toUpperCase()&&
      (item.teamAbbreviation?.toUpperCase()===team.toUpperCase()||normalizedName(item.team)===normalizedName(team)))
      .slice(0,8):[];
    return {injury:injuryFor(line,injuries.items),teamInjuries,game,
      markets:marketsFor(line,[...kalshi.items,...polymarket.items],game),
      fetchedAt:{injuries:injuries.fetchedAt,pinnacle:pinnacle.fetchedAt,kalshi:kalshi.fetchedAt,polymarket:polymarket.fetchedAt}};
  });
  // Each app's payouts and the per-pick hit rate every entry needs to break even.
  const payouts=options.payouts??DEFAULT_PAYOUTS;
  app.get('/v1/payouts', async () => ({payouts,breakEvens:Object.fromEntries(pickAppSchema.options.map((name)=>
    [name,entryBreakEvens(payouts[name])]))}));
  // CrownIQ's own +EV: sportsbook no-vig chances against the pick'em break-even. Separate from GKR; never scored.
  app.get('/v1/ev', async (_request, reply) => {
    const board=service.getBoard();
    if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
    if(!options.sharpProps)return reply.code(503).send({code:'EV_UNCONFIGURED'});
    const {fetchedAt,prices}=await options.sharpProps.current();
    const breakEven=options.evBreakEven??bestBreakEven(payouts.prizepicks)?.breakEven??DEFAULT_BREAK_EVEN;
    const picks=evPicks(board,prices,now(),breakEven);
    return {app:'prizepicks',fetchedAt,breakEven,matched:picks.length,
      picks:picks.filter((pick)=>pick.edge>0).slice(0,150)};
  });
  // The sportsbooks' no-vig chance for each standard board line they price (for "Books agree" badges). Never scored.
  // The books' no-vig chance of MORE per board line, for the AI reads (refreshed with the SharpAPI prices).
  let fairCache:{at:number;board:unknown;views:Map<string,number>}|null=null;
  async function fairMoreFor(){
    const board=service.getBoard();
    if(!board||!options.sharpProps)return new Map<string,number>();
    if(fairCache&&fairCache.board===board&&now().getTime()-fairCache.at<10*60_000)return fairCache.views;
    const {prices}=await options.sharpProps.current();
    const views=new Map([...bookViews(board,prices,now())].map(([lineId,view])=>[lineId,view.fairMore]));
    fairCache={at:now().getTime(),board,views};
    return views;
  }
  const aiView=(read:AiRead)=>({pick:read.pick,score:read.score,agreement:read.agreement,researchedAt:read.researchedAt,
    kind:read.kind??'scout',gkr:read.gkr?{direction:read.gkr.direction,score:read.gkr.score}:null,
    providers:read.providers.map((item)=>({provider:item.provider,pick:item.pick,confidence:item.confidence,summary:item.summary,
      reasons:item.reasons,lateNews:realNews(item.lateNews??'')}))});
  // AI reads for the current board: lines GKR couldn't score that ChatGPT and Claude researched.
  app.get('/v1/ai-picks', async (_request, reply) => {
    const board=service.getBoard();
    if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
    if(!options.aiPicks)return {configured:false,reads:{}};
    const reads=await options.aiPicks.current(board);
    return {configured:options.aiPicks.configured,reads:Object.fromEntries([...reads].map(([lineId,read])=>[lineId,aiView(read)]))};
  });
  // Ask AI: research one line GKR can't score, now, within the user's daily allowance.
  app.post('/v1/ai-picks/:lineId', async (request, reply) => {
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    const parsed=z.object({lineId:z.string().min(1).max(300)}).safeParse(request.params);
    if(!parsed.success)return reply.code(400).send({code:'INVALID_LINE'});
    const board=service.getBoard(),line=board?.board.lines.find((item)=>item.id===parsed.data.lineId);
    if(!board||!line)return reply.code(404).send({code:'LINE_NOT_FOUND'});
    if(!options.aiPicks)return reply.code(503).send({code:'AI_UNCONFIGURED'});
    const result=await options.aiPicks.ask(user.accountId,line,board.analyses.find((item)=>item.lineId===line.id),
      service.getEvidence(),(await fairMoreFor()).get(line.id)??null);
    if(!result.read)return reply.code(result.error==='DAILY_LIMIT_REACHED'?429:result.error==='AI_UNAVAILABLE'?502:422)
      .send({code:result.error});
    return {read:aiView(result.read)};
  });
  app.get('/v1/books', async (_request, reply) => {
    const board=service.getBoard();
    if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
    if(!options.sharpProps)return {fetchedAt:null,lines:{}};
    const {fetchedAt,prices}=await options.sharpProps.current();
    const views=bookViews(board,prices,now());
    return {fetchedAt,lines:Object.fromEntries(views),picks:Object.fromEntries(booksPicks(board,views))};
  });
  // Underdog and Pick6 lines. GKR does not score them; the same PrizePicks line and its GKR score ride along for reference.
  app.get('/v1/apps/:app/board',async(request,reply)=>{
    const parsed=z.object({app:z.enum(otherApps as [OtherApp,...OtherApp[]])}).safeParse(request.params);
    if(!parsed.success)return reply.code(404).send({code:'UNKNOWN_APP'});
    if(!options.scrapedLines)return reply.code(503).send({code:'APP_LINES_UNAVAILABLE'});
    const board=await appBoard(options.scrapedLines,parsed.data.app,service.getBoard());
    const scores=await scoresFor(parsed.data.app);
    // Scout's read on the line, at this number, when it has one (lines GKR can't score).
    const reads=new Map((await options.aiPicks?.upcoming()??[]).map((read)=>[`${read.lineId}|${read.threshold}`,read]));
    return {...board,gkrScored:!!options.appGkrScores,
      lines:board.lines.map((line)=>{const read=reads.get(`${line.id}|${line.threshold}`);
        return {...line,gkr:scores.get(line.id)??null,
          scout:read?{pick:read.pick,score:read.score,agreement:read.agreement}:null};})};
  });
  // App scores are rebuilt at most every 2 minutes, or sooner when the PrizePicks board or its research changes.
  const appScoreCache=new Map<OtherApp,{at:number;key:readonly unknown[];scores:Map<string,AppScore>}>();
  async function scoresFor(app:OtherApp):Promise<Map<string,AppScore>>{
    const board=service.getBoard();
    if(!options.appGkrScores||!options.scrapedLines||!board)return new Map();
    const now=(options.clock??(()=>new Date()))(),key=[board,service.getEvidence()];
    const cached=appScoreCache.get(app);
    if(cached&&now.getTime()-cached.at<2*60_000&&cached.key[0]===key[0]&&cached.key[1]===key[1])return cached.scores;
    const {lines}=await appBoard(options.scrapedLines,app,null);
    const scores=appScores(lines,board.board.lines,(items)=>service.scoreLines(items),now);
    appScoreCache.set(app,{at:now.getTime(),key,scores});
    return scores;
  }
  // Sportsbook picks: GKR's side on each DraftKings or Hard Rock prop at the book's number (no PASS lines), rebuilt at
  // most every 2 minutes or when the board, its research or the book prices change.
  const bookPickCache=new Map<Sportsbook,{at:number;key:readonly unknown[];picks:BookPick[];fetchedAt:string|null;
    lines:Map<string,PropLine>}>();
  async function picksFor(book:Sportsbook){
    const board=service.getBoard();
    if(!options.appGkrScores||!options.sharpProps||!board)return null;
    const {fetchedAt,prices}=await options.sharpProps.current();
    const now=(options.clock??(()=>new Date()))(),key=[board,service.getEvidence(),prices];
    const cached=bookPickCache.get(book);
    if(cached&&now.getTime()-cached.at<2*60_000&&key.every((item,index)=>cached.key[index]===item))return cached;
    const lines=new Map<string,PropLine>();
    const picks=bookPicks(book,prices,board.board.lines,new Map(board.analyses.map((item)=>[item.lineId,item])),
      (items)=>service.scoreLines(items),now,undefined,lines);
    const entry={at:now.getTime(),key,picks,fetchedAt,lines};
    bookPickCache.set(book,entry);
    return entry;
  }
  // The sportsbooks' other numbers for one board line's player and stat (Hard Rock's alternate ladder), for GKR's side.
  // GKR Beta for lifetime members: each GKR play with Scout's research folded in (scout-beta.ts). Others keep GKR.
  async function betaReads(board:BoardResponse){
    const out=new Map<string,BetaRead>();
    const lines=new Map(board.board.lines.map((line)=>[line.id,line]));
    for(const analysis of board.analyses){
      const line=lines.get(analysis.lineId);
      if(!line||analysis.direction==='PASS'||analysis.score===null)continue;
      const read=options.aiPicks?await options.aiPicks.readFor(line):null;
      const beta=betaFor(analysis,read&&read.kind==='second'?read:null);
      if(beta)out.set(analysis.lineId,beta);
    }
    return out;
  }
  app.get('/v1/beta',async(request,reply)=>{
    const user=await currentUser(request);
    if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(user.plan!=='LIFETIME')return reply.code(403).send({code:'BETA_LIFETIME_ONLY'});
    const board=service.getBoard();
    if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
    return {builtAt:board.builtAt,lines:Object.fromEntries(await betaReads(board))};
  });
  // GKR Beta's record against GKR on the same graded picks, for lifetime members.
  app.get('/v1/beta/record',async(request,reply)=>{
    const user=await currentUser(request);
    if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(user.plan!=='LIFETIME')return reply.code(403).send({code:'BETA_LIFETIME_ONLY'});
    if(!options.shadowRecord)return reply.code(503).send({code:'SHADOW_UNCONFIGURED'});
    const status=await options.shadowRecord.status() as Record<string,unknown>;
    return {gkr:status.gkr,beta:status.beta,betaPass:status['beta-pass']};
  });
  app.get('/v1/books/ladder/:lineId',async(request,reply)=>{
    const {lineId}=request.params as {lineId:string};
    const board=service.getBoard();
    if(!board||!options.sharpProps||!options.appGkrScores)return reply.code(503).send({code:'LADDER_UNAVAILABLE'});
    const line=board.board.lines.find((item)=>item.id===lineId);
    if(!line)return reply.code(404).send({code:'LINE_NOT_FOUND'});
    const analysis=board.analyses.find((item)=>item.lineId===lineId);
    const side=analysis&&analysis.direction!=='PASS'?analysis.direction:null;
    if(!side||Date.parse(line.eventStartTime)<=now().getTime())return {side,rows:[]};
    const {fetchedAt,prices}=await options.sharpProps.current();
    return {side,fetchedAt,rows:bookLadder(line,side,prices,(items)=>service.scoreLines(items))};
  });
  app.get('/v1/books/:book/picks',async(request,reply)=>{
    const parsed=z.object({book:z.enum(sportsbooks)}).safeParse(request.params);
    if(!parsed.success)return reply.code(404).send({code:'UNKNOWN_BOOK'});
    const result=await picksFor(parsed.data.book);
    if(!result)return reply.code(503).send({code:'BOOK_PICKS_UNAVAILABLE'});
    const picks=await Promise.all(result.picks.map(async(pick)=>{const line=result.lines.get(pick.id);
      const read=line&&options.aiPicks?await options.aiPicks.readFor(line):null;
      return {...pick,scout:read?aiView(read):null};}));
    return {book:parsed.data.book,name:sportsbookNames[parsed.data.book],fetchedAt:result.fetchedAt,picks};
  });
  // Prediction-market picks: Kalshi or Polymarket game markets priced below Pinnacle's no-vig chance. Display only.
  /** A platform's prices: live from its free API when fresh, else the daily Apify feed. */
  async function marketItems(platform:MarketPlatform):Promise<{fetchedAt:string|null;items:MarketOdds[];live:boolean}>{
    const live=await options.liveMarkets?.items(platform);
    if(live)return {...live,live:true};
    const feed=options.contextFeeds?await options.contextFeeds.items<MarketOdds>(platform):{fetchedAt:null,items:[]};
    return {...feed,live:false};
  }
  async function marketPicksFor(platform:MarketPlatform){
    if(!options.contextFeeds)return null;
    const [markets,games]=await Promise.all([marketItems(platform),options.contextFeeds.items<GameLine>('pinnacle')]);
    // Pinnacle is pulled twice a day; a market compared with Pinnacle prices more than 6 hours old would show edges that
    // are only Pinnacle being out of date, so no picks then.
    const pinnacleStale=!games.fetchedAt||now().getTime()-Date.parse(games.fetchedAt)>6*3600_000;
    return {fetchedAt:markets.fetchedAt,live:markets.live,pinnacleAt:games.fetchedAt,pinnacleStale,
      picks:pinnacleStale?[]:marketPicks(platform,markets.items,games.items,now())};
  }
  app.get('/v1/markets/:platform/record',async(request,reply)=>{
    const parsed=z.object({platform:z.enum(['kalshi','polymarket'])}).safeParse(request.params);
    if(!parsed.success)return reply.code(404).send({code:'UNKNOWN_PLATFORM'});
    return options.marketRecord?options.marketRecord.status(parsed.data.platform):reply.code(503).send({code:'MARKET_RECORD_UNCONFIGURED'});
  });
  app.get('/v1/markets/:platform/picks',async(request,reply)=>{
    const parsed=z.object({platform:z.enum(['kalshi','polymarket'])}).safeParse(request.params);
    if(!parsed.success)return reply.code(404).send({code:'UNKNOWN_PLATFORM'});
    const result=await marketPicksFor(parsed.data.platform);
    if(!result)return reply.code(503).send({code:'MARKET_PICKS_UNAVAILABLE'});
    const picks=await Promise.all(result.picks.map(async(pick)=>{const line=marketLine(pick,now());
      const read=line&&options.aiPicks?await options.aiPicks.readFor(line):null;
      return {...pick,scout:read?aiView(read):null};}));
    return {platform:parsed.data.platform,...result,picks};
  });
  // Carry PrizePicks picks over to Underdog or Pick6: each pick's line on that app and how its number compares.
  app.post('/v1/apps/:app/port',async(request,reply)=>{
    const parsed=z.object({app:z.enum(otherApps as [OtherApp,...OtherApp[]])}).safeParse(request.params);
    if(!parsed.success)return reply.code(404).send({code:'UNKNOWN_APP'});
    const body=z.object({legs:z.array(z.object({lineId:z.string().min(1).max(300),direction:z.enum(['MORE','LESS'])}).strict())
      .min(1).max(6)}).strict().safeParse(request.body);
    if(!body.success)return reply.code(400).send({code:'INVALID_LEGS'});
    const board=service.getBoard();
    if(!options.scrapedLines||!board)return reply.code(503).send({code:'APP_LINES_UNAVAILABLE'});
    return {app:parsed.data.app,legs:await portLegs(options.scrapedLines,parsed.data.app,board,body.data.legs)};
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
  const rankings=(snapshot:BoardResponse)=>{
    const watchlist=secondLookWatchlist(snapshot);
    return {
      builtAt: snapshot.builtAt,
      rankedLineIds: snapshot.rankedLineIds,
      analyses: snapshot.analyses.filter((analysis) => snapshot.rankedLineIds.includes(analysis.lineId)),
      rankings: rankingCards(snapshot),
      watchlistLineIds: watchlist.lineIds,
      watchlist: watchlist.cards,
    };
  };
  app.get('/v1/rankings', async (_request, reply) => {
    const snapshot = service.getBoard();
    return snapshot ? rankings(snapshot) : reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
  });
  // The public demo (no profile): the saved board's real lines for games in the next three days, read-only.
  const demoWindow=()=>{
    const snapshot=service.getBoard(), from=now();
    return snapshot ? windowBoard(snapshot, from, new Date(from.getTime() + DEMO_WINDOW_MS)) : null;
  };
  app.get('/v1/demo/board', async (_request, reply) => {
    const snapshot = demoWindow();
    return snapshot ? liteBoard(snapshot, now()) : reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
  });
  app.get('/v1/demo/rankings', async (_request, reply) => {
    const snapshot = demoWindow();
    return snapshot ? rankings(snapshot) : reply.code(503).send({ code: 'BOARD_UNAVAILABLE' });
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
  const gameLog=async(request:FastifyRequest,reply:FastifyReply)=>{
    const parsed=z.object({sport:z.string().min(1).max(20),playerId:z.string().min(1).max(200),
      market:z.string().min(1).max(80)}).safeParse(request.params);
    if(!parsed.success)return reply.code(400).send({code:'INVALID_GAME_LOG_REQUEST'});
    if(!options.internalHistory)return reply.code(404).send({code:'NO_HISTORY'});
    const line=service.getBoard()?.board.lines.find((item)=>item.playerId===parsed.data.playerId&&
      item.sport===parsed.data.sport);
    const log=await options.internalHistory.gameLog(parsed.data.sport,parsed.data.playerId,
      line?.playerName??null,parsed.data.market,now());
    return log&&log.games.length?log:reply.code(404).send({code:'NO_HISTORY'});
  };
  app.get('/v1/players/:sport/:playerId/:market/games', gameLog);
  app.get('/v1/demo/players/:sport/:playerId/:market/games', gameLog);
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
    admin.get('/odds-api', async (_request, reply) => options.oddsApiQuota ? options.oddsApiQuota()
      : reply.code(503).send({ code: 'ODDS_API_KEY_MISSING' }));
    // What CrownIQ has stored for itself: player game history, graded decisions, line history and the side records.
    admin.get('/history', async () => {
      const lines=options.scrapedLines?await options.scrapedLines.active():[];
      let booksHistoryRows=0;
      try{if(options.booksHistoryFile)booksHistoryRows=(await readFile(options.booksHistoryFile,'utf8')).split('\n').filter(Boolean).length;}catch{/* none yet */}
      return {playerHistory:await options.internalHistory?.status()??null,
        trackedDecisions:(await options.product?.listDecisions(0,1))?.total??null,
        activeAppLines:lines.length,booksHistoryRows,
        shadow:await options.shadowRecord?.status()??null,markets:await options.marketRecord?.status()??null,
        archive:await options.historyArchive?.status()??null};
    });
    admin.get('/members', async (_request, reply) => options.product ? options.product.membership()
      : reply.code(503).send({ code: 'PRODUCT_UNCONFIGURED' }));
    admin.get('/live-markets', async (_request, reply) => options.liveMarkets ? options.liveMarkets.status()
      : reply.code(503).send({ code: 'LIVE_MARKETS_UNCONFIGURED' }));
    admin.post('/live-markets/refresh', async (_request, reply) => options.liveMarkets ? options.liveMarkets.refresh()
      : reply.code(503).send({ code: 'LIVE_MARKETS_UNCONFIGURED' }));
    admin.get('/shadow', async (_request, reply) => options.shadowRecord ? options.shadowRecord.status()
      : reply.code(503).send({ code: 'SHADOW_UNCONFIGURED' }));
    admin.post('/shadow/record', async (_request, reply) => options.shadowRecord ? (await recordShadow()) ?? { found: {}, added: 0 }
      : reply.code(503).send({ code: 'SHADOW_UNCONFIGURED' }));
    admin.get('/market-record', async (_request, reply) => options.marketRecord
      ? { kalshi: await options.marketRecord.status('kalshi'), polymarket: await options.marketRecord.status('polymarket') }
      : reply.code(503).send({ code: 'MARKET_RECORD_UNCONFIGURED' }));
    admin.post('/shadow/grade', async (_request, reply) => options.shadowRecord ? { graded: await options.shadowRecord.grade(),
      markets: await options.marketRecord?.grade() ?? 0 }
      : reply.code(503).send({ code: 'SHADOW_UNCONFIGURED' }));
    admin.get('/book-picks/:book', async (request, reply) => {
      const parsed=z.object({book:z.enum(sportsbooks)}).safeParse(request.params);
      if(!parsed.success)return reply.code(404).send({code:'UNKNOWN_BOOK'});
      const result=await picksFor(parsed.data.book),board=service.getBoard();
      if(!result||!board||!options.sharpProps)return reply.code(503).send({code:'BOOK_PICKS_UNAVAILABLE'});
      // Where the book's lines drop out (no PrizePicks match, or GKR passes), for the owner.
      const counts:Record<string,number>={};
      bookPicks(parsed.data.book,(await options.sharpProps.current()).prices,board.board.lines,
        new Map(board.analyses.map((item)=>[item.lineId,item])),(items)=>service.scoreLines(items),now(),counts);
      return {fetchedAt:result.fetchedAt,counts,picks:result.picks};
    });
    admin.get('/grading', async () => ({ worker: options.autoGradingStatus?.() ?? null }));
    admin.get('/ai-picks', async (_request, reply) => options.aiPicks ? options.aiPicks.status()
      : reply.code(503).send({ code: 'AI_UNCONFIGURED' }));
    admin.get('/ai-picks/recent', async (_request, reply) => options.aiPicks ? { reads: await options.aiPicks.recent() }
      : reply.code(503).send({ code: 'AI_UNCONFIGURED' }));
    admin.post('/ai-picks/run', async (_request, reply) => {
      const board=service.getBoard();
      if(!options.aiPicks||!board)return reply.code(503).send({ code: 'AI_UNCONFIGURED' });
      const fair=await fairMoreFor();
      return options.aiPicks.runOnce(board,service.getEvidence(),(lineId)=>fair.get(lineId)??null);
    });
    // The Underdog/Pick6 shadow run: plays, graded record at 80+, and the go-live bars.
    admin.get('/app-shadow', async (_request, reply) => appShadow ? appShadow.summary()
      : reply.code(503).send({ code: 'APP_SHADOW_OFF' }));
    admin.post('/app-shadow/run', async (_request, reply) => appShadow
      ? { scored: await appShadow.score(), graded: await appShadow.grade() } : reply.code(503).send({ code: 'APP_SHADOW_OFF' }));
    admin.get('/stat-columns', async (request, reply) => {
      const query=z.object({sport:z.enum(['NFL','NBA','MLB','PGA']),table:z.string().regex(/^[a-z_]+$/),
        player:z.coerce.number().int().positive()}).safeParse(request.query);
      if(!query.success)return reply.code(400).send({code:'INVALID_QUERY'});
      if(!options.ownerResearch)return reply.code(503).send({code:'STAT_API_UNCONFIGURED'});
      try{return await options.ownerResearch.columns(query.data.sport,query.data.table,query.data.player);}
      catch(error){return reply.code(502).send({code:error instanceof Error?error.message:'STAT_API_FAILED'});}
    });
    // What the Stat API returns for a player name (ids, names, team ids, and whether the scan was cut short).
    admin.get('/stat-search', async (request, reply) => {
      const query=z.object({sport:z.enum(['NFL','NBA','MLB','PGA']),q:z.string().min(2).max(80),
        scope:z.enum(['active','all']).default('active')}).safeParse(request.query);
      if(!query.success)return reply.code(400).send({code:'INVALID_QUERY'});
      if(!options.ownerResearch)return reply.code(503).send({code:'STAT_API_UNCONFIGURED'});
      try{return query.data.scope==='all'&&query.data.sport!=='NBA'
        ? await options.ownerResearch.searchAnyStatus(query.data.sport,query.data.q)
        : await options.ownerResearch.search(query.data.sport,query.data.q);}
      catch(error){return reply.code(502).send({code:error instanceof Error?error.message:'STAT_API_FAILED'});}
    });
    // What the Underdog and Pick6 pulls hold: line counts per app, league and stat label.
    admin.get('/app-lines', async (_request, reply) => {
      if(!options.scrapedLines)return reply.code(503).send({code:'APP_LINES_UNAVAILABLE'});
      const summary:Record<string,Record<string,number>>={};
      for(const app of ['prizepicks',...otherApps] as const)for(const line of await options.scrapedLines.active(app)){
        const key=`${app} ${line.league}`;summary[key]??={};
        summary[key][line.stat]=(summary[key][line.stat]??0)+1;
      }
      const coverage=Object.fromEntries(await Promise.all(otherApps.map(async(app)=>
        [app,await appCoverage(options.scrapedLines!,app,service.getBoard())] as const)));
      return {coverage,labels:summary};
    });
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
    // One source pull now (an Apify scraper spends Apify credit, The Odds API its own credits); waits for the result.
    admin.post('/scrapers/pull', async (request, reply) => {
      if(!options.scraperPuller)return reply.code(503).send({code:'SCRAPERS_UNCONFIGURED'});
      if(request.headers['x-confirm-provider-cost']!=='yes')return reply.code(428).send({code:'PROVIDER_CREDITS_CONFIRMATION_REQUIRED'});
      const input=z.object({source:z.string().min(1)}).strict().safeParse(request.body);
      if(!input.success)return reply.code(400).send({code:'SOURCE_REQUIRED'});
      return options.scraperPuller.pull(input.data.source);
    });
    admin.post('/scrapers/restore', async (request, reply) => {
      const input=z.object({since:z.iso.datetime()}).strict().safeParse(request.body);
      if(!input.success||!options.scrapedLines)return reply.code(400).send({code:'SINCE_REQUIRED'});
      return {restored:await options.scrapedLines.restoreRemoved(new Date(input.data.since))};
    });
    admin.get('/scrapers', async (_request, reply) => options.scraperPuller
      ? options.scraperPuller.status() : reply.code(503).send({ code: 'SCRAPERS_UNCONFIGURED' }));
    admin.post('/sharp-props/refresh', async (_request, reply) => options.sharpProps
      ? options.sharpProps.refresh() : reply.code(503).send({ code: 'EV_UNCONFIGURED' }));
    admin.get('/context', async (_request, reply) => options.contextFeeds
      ? { feeds: await options.contextFeeds.status(), sharpProps: await options.sharpProps?.status() ?? null } : reply.code(503).send({ code: 'CONTEXT_FEEDS_UNCONFIGURED' }));
    // One context feed's saved items (read-only), for the owner to check what a feed holds.
    admin.get('/context/:id/items', async (request, reply) => {
      const parsed=z.object({id:z.enum(['injuries','pinnacle','kalshi','polymarket'])}).safeParse(request.params);
      if(!parsed.success||!options.contextFeeds)return reply.code(404).send({code:'UNKNOWN_FEED'});
      return options.contextFeeds.items(parsed.data.id);
    });
    // Pulls one context feed now; it spends from the shared daily scraper budget.
    admin.post('/context/pull', async (request, reply) => {
      if (!options.contextFeeds) return reply.code(503).send({ code: 'CONTEXT_FEEDS_UNCONFIGURED' });
      if (request.headers['x-confirm-provider-cost'] !== 'yes') return reply.code(428).send({ code: 'COST_CONFIRMATION_REQUIRED' });
      const input = z.object({ source: z.enum(['injuries', 'pinnacle', 'kalshi', 'polymarket']) }).safeParse(request.body);
      if (!input.success) return reply.code(400).send({ code: 'INVALID_CONTEXT_SOURCE' });
      return options.contextFeeds.pull(input.data.source);
    });
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
