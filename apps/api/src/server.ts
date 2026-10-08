import type { BaseRates, Trend } from './base-rates.js';
import { registerCompression } from './compress.js';
import { passwordMatches } from './secrets.js';
import type { SecretUnlocks } from './secrets.js';
import type { ActivityLog } from './activity.js';
import { gzipSync } from 'node:zlib';
import { lineShop } from './line-shop.js';
import { sameGame } from './team-match.js';
import { bookLines } from './book-picks.js';
import type { BookFallback } from './book-picks.js';
import type { ShopEntry, ShopPick } from './line-shop.js';
import { HistoryReads } from './history-read.js';
import { fantasyApp, fantasyBlocked, isFantasyMarket } from './fantasy-history.js';
import { statApiValueFor } from './stat-api-gkr-evidence.js';
import type { HistoryRead } from './history-read.js';
import { twoMaps } from './player-history.js';
import type { PlayerHistory } from './player-history.js';
import { FeedbackStore } from './feedback.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bestBreakEven, boardResponseSchema, DEFAULT_PAYOUTS, entryBreakEvens, nflPassingResultSchema, pickAppSchema } from '@crowniq/contracts';
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
import { aiEligible, realNews } from './ai-picks.js';
import { createHash } from 'node:crypto';
import type { AiPickService, AiRead } from './ai-picks.js';
import type { BoxScoreResults } from './box-score-results.js';
import type { ScraperPuller } from './scrapers/scraper-puller.js';
import type { ContextRefreshOptions, DailyLookupBudget } from './context-refresh.js';
import type { ProviderName } from './provider-identity.js';
import { ProviderIdentityVerifier } from './provider-identity.js';
import { SHARP_SOURCE, sharpPrizePicksScraped } from './scrapers/sharp-prizepicks.js';
import type { BoardSourceReport } from './scrapers/scraped-prizepicks-provider.js';
import { StatApiOwnerError, StatApiOwnerResearch } from './stat-api-owner-research.js';
import { OwnerResearchNotebook } from './owner-research-notebook.js';
import { rankingCards, secondLookWatchlist } from './ranking-cards.js';
import { auditPrizePicksLineTypes } from './prizepicks-line-types.js';
import type { HistoryBackfillService, InternalHistorySport, InternalHistoryStore } from './internal-history.js';
import type { ProductGradingStatus } from './background-grading.js';
import type { ContextFeeds, GameLine, InjuryNote } from './context/feeds.js';
import { gameLinesFor, injuryFor, normalizedName } from './context/match.js';
import type { FairPrice, SharpPropsFeed } from './context/sharp-props.js';
import { bookFeedNote, sharpGameLines } from './context/sharp-props.js';
import { booksPicks, bookViews, DEFAULT_BREAK_EVEN, evPicks } from './context/ev.js';
import type { EvPick } from './context/ev.js';
import { bookLadder, bookPicks, sportsbookNames, sportsbooks } from './book-picks.js';
import { gameScriptFor, scriptEligible } from './shadow-record.js';
import { betaFor } from './scout-beta.js';
import type { BetaRead } from './scout-beta.js';
import type { HistoryArchive } from './history-archive.js';
import type { ShadowPick, ShadowRecord } from './shadow-record.js';
import type { BookPick, Sportsbook } from './book-picks.js';
import { serveWebApp } from './web-app.js';
import { EDGE_PLATFORMS, EdgeResultsWorker, EdgeService, searchPicks } from './edge/service.js';
import { blendPick, blendPicks, GKR_PLUS_VERSION } from './edge/blend.js';
import type { GkrSide } from './edge/blend.js';
import { canonicalMarket } from './edge/market-map.js';
import { buildSlips } from '@crowniq/edge';
import { easternDay } from './edge/routes.js';
import type { EdgePick, EdgePlatform } from '@crowniq/contracts';
import type { EdgeLedger } from './edge/ledger.js';
import type { SnapshotStore } from './edge/snapshots.js';
import type { BookWeightStore } from './edge/book-weights.js';
import type { DispersionStore } from './edge/dispersion-store.js';
import { analyzeTips, DAILY_TIP_UPLOADS, marketRead } from './tips.js';
import type { TipDraft, TipGrader, TipReader, TipStore } from './tips.js';
import { matchTip, modelRead } from './tip-models.js';
import type { TipModelRead } from './tip-models.js';
import { registerEdgeRoutes } from './edge/routes.js';
import { MovementTracker } from './edge/movement.js';
import { bookRows, pickemRows, scrapedRows } from './edge/snapshot-feed.js';

/** How far ahead the public demo shows real lines. */
const DEMO_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface ServerOptions {
  provider?: OddsProvider | null;
  /** The Odds API consensus books' fair prices from the last PrizePicks pull (step 5a), for Edge only. */
  oddsConsensus?: () => readonly FairPrice[];
  /** Folder holding the exported web app, served at every non-API path. */
  webAppDir?: string | null;
  research?: ResearchAdapter | null;
  secondLookResearch?: ResearchAdapter | null;
  webResearch?: WebResearchService | null;
  models?: ModelRegistry;
  adminToken?: string;
  /** How someone without a code reaches the owner for one (shown on the locked sign-up screen). */
  signupContact?: string | null;
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
  /** Display-only game context feeds (injuries, Pinnacle); never scored. */
  contextFeeds?: ContextFeeds | null;
  /** DraftKings and Hard Rock prop prices (SharpAPI) for reference odds and CrownIQ's own +EV; never scored. */
  sharpProps?: SharpPropsFeed | null;
  /** Break-even chance per pick for +EV (default 54.21%, PrizePicks' best Flex). */
  evBreakEven?: number;
  /** Each app's payout tables (defaults, or CROWNIQ_PAYOUTS merged over them). */
  payouts?: Payouts;
  /** Shadow records: Books picks, sportsbook-tab picks and game-script snapshots, graded in their own record. */
  shadowRecord?: ShadowRecord | null;
  /** Every standard line graded after its game, for Trends (CrownIQ's own hit rates). */
  baseRates?: BaseRates | null;
  /** Beta feedback: testers' bug reports and suggestions, and the patch notes that answer them. */
  feedback?: FeedbackStore | null;
  /** Free public history (ESPN tennis, OpenDota, Leaguepedia) for the cards' game logs. */
  playerHistory?: PlayerHistory | null;
  /** UFC fighters' fight history (UFCStats) for History Read and Edge on PrizePicks' UFC lines. */
  ufcHistory?: import('./ufc-history.js').UfcHistory | null;
  /** Soccer players' full match stats (Sofascore) for lines ESPN's logs can't read, fantasy score included. */
  soccerHistory?: import('./soccer-history.js').SoccerHistory | null;
  /** ESPN game logs (soccer, NHL, college football) for History Reads. */
  espnHistory?: { recentValues(target: import('@crowniq/engine').ResearchTarget): Promise<number[] | null>;
    recentFantasy?(target: import('@crowniq/engine').ResearchTarget, app: import('./fantasy-history.js').FantasyApp): Promise<number[] | null>;
    soccerFixtures?(target: import('@crowniq/engine').ResearchTarget): Promise<import('./soccer-history.js').Fixture[]>;
    recentGames?(target: import('@crowniq/engine').ResearchTarget): Promise<{ date: string; opponent: string | null; value: number }[] | null> } | null;
  /** CrownIQ's own archive of game logs, graded results and lines. */
  historyArchive?: HistoryArchive | null;
  /** Reads The Odds API's credit balance (a free call), for the owner. */
  oddsApiQuota?: (() => Promise<{ status: number; remaining: number | null; used: number | null }>) | null;
  /** CrownIQ Edge: a standalone probability engine with its own Top Picks, Board and Gen; never reads or changes GKR. */
  edge?: { enabled?: boolean; ledger?: EdgeLedger | null; snapshots?: SnapshotStore | null;
    /** GKR+ (owner-only): its own ledger, graded like Edge's. */
    gkrPlusLedger?: EdgeLedger | null;
    alternateFactors?: Partial<Record<'GOBLIN' | 'DEMON', number>>; alternateCurve?: Partial<Record<'GOBLIN' | 'DEMON', number>>; boxScores?: BoxScoreResults | null;
    valuesCacheFile?: string | null; pick6PayoutsConfirmed?: boolean; alertsFile?: string | null;
    staleLogFile?: string | null; dispersion?: DispersionStore | null;
    bookWeights?: BookWeightStore | null } | null;
  /** Tips from paid services, read from screenshots by Claude and graded after the games (display-only). */
  tips?: { store: TipStore; reader: TipReader | null; grader: TipGrader | null } | null;
  /** "Secrets" in the More tab: the password that unlocks GKR+ for an account, and who has unlocked it. */
  secrets?: { password: string | null; unlocks: SecretUnlocks } | null;
  /** Minutes on the app per member (owner's Member activity). */
  activity?: ActivityLog | null;
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

const serverStartedAt=new Date().toISOString();
export function buildServer(options: ServerOptions = {}) {
  const app = Fastify({ logger: false });
  registerCompression(app);
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
      path!=='/v1/version' &&
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
    // Step 0: SharpAPI's PrizePicks lines are the primary source in the line store. A failed or empty pass ingests nothing
    // as a complete pull, so lines only SharpAPI listed leave the board (fail closed) and the backups carry it.
    if(options.scrapedLines&&options.sharpProps&&!options.clock){
      const store=options.scrapedLines;
      options.sharpProps.whenPickem(async(pickem,ok)=>{
        const {lines,unmapped}=sharpPrizePicksScraped(pickem);
        const report=await store.ingest(SHARP_SOURCE,ok?lines:[],{complete:true,apps:['prizepicks']});
        console.log(`[sharp-prizepicks] ${ok?'ok':'DOWN, board on backups'}: ${lines.length} lines in, ${JSON.stringify(report)}`+
          (unmapped.size?`, unmapped ${[...unmapped].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([key,count])=>`${key}(${count})`).join(' ')}`:''));
        if(report.added||report.moved||report.removed)startOwnerBoardRefresh();
      });
    }
    options.scraperPuller?.start();
    options.tips?.grader?.start();
    options.contextFeeds?.start();
    // Keep what the books said about each board line over time, so a "books agree" factor can be measured on graded results.
    let booksHistoryAt=0;
    options.sharpProps?.whenRefreshed(async(prices,at)=>{
      const board=service.getBoard();
      if(!board||!options.booksHistoryFile)return;
      // Hourly, whatever the refresh rate, so the file grows as before.
      if(at.getTime()-booksHistoryAt<55*60_000)return;
      booksHistoryAt=at.getTime();
      const lines=new Map(board.board.lines.map((line)=>[line.id,line]));
      const rows=[...bookViews(board,prices,at)].map(([lineId,view])=>{const line=lines.get(lineId)!;
        return JSON.stringify({at:at.toISOString(),lineId,sport:line.sport,playerId:line.playerId,playerName:line.playerName,
          eventId:line.eventId,eventStartTime:line.eventStartTime,market:line.market,threshold:line.threshold,
          fairMore:view.fairMore,books:view.books.map((book)=>book.book)});});
      if(rows.length){await mkdir(dirname(options.booksHistoryFile),{recursive:true});
        await appendFile(options.booksHistoryFile,rows.join('\n')+'\n');}
    });
    // Every 15 minutes so book moves are caught while the apps lag (Edge §3); SharpAPI limits only requests per minute.
    options.sharpProps?.start(Number(process.env.CROWNIQ_SHARP_REFRESH_MINUTES??15));
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
          // GKR's book picks keep their own record; History and Value book picks are graded as kind book-history/book-value.
          for(const pick of result?.picks??[]){const line=result!.lines.get(pick.id);
            if(line)picks.push({kind:pick.by==='GKR'?`book:${book}`:pick.by==='HISTORY'?'book-history':'book-value',line,side:pick.side,strength:pick.score});}
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
        for(const analysis of board.analyses){
          const line=lines.get(analysis.lineId);
          if(!line||analysis.direction==='PASS'||analysis.score===null||!scriptEligible(line))continue;
          const script=gameScriptFor(line,games);
          if(script)picks.push({kind:'script',line,side:analysis.direction,strength:analysis.score,script});
        }
      }
      // Free History Reads on PrizePicks lines GKR doesn't play, graded in their own record.
      for(const [lineId,read] of Object.entries(await boardHistoryReads(board))){
        const line=lines.get(lineId);
        if(line&&read.direction!=='PASS'&&!read.lean)picks.push({kind:'history',line,side:read.direction,strength:read.score});
      }
      // Trends, graded in their own record.
      for(const [lineId,trend] of Object.entries(historyCache?.trends??{})){
        const line=lines.get(lineId);
        if(line&&trend.direction!=='PASS')picks.push({kind:'trend',line,side:trend.direction,strength:trend.score});
      }
      const found:Record<string,number>={};
      for(const pick of picks)found[pick.kind]=(found[pick.kind]??0)+1;
      return {found,added:await shadow.record(picks)};
    };
    const first=setTimeout(()=>{void recordShadow().catch(()=>undefined);},90_000);first.unref();
    const every=setInterval(()=>{void recordShadow().catch(()=>undefined);},15*60_000);every.unref();
    const grading=setInterval(()=>{void shadow.grade().catch(()=>undefined);},60*60_000);grading.unref();
    shadowTimers.push(first,every,grading);
  }
  // Scout second opinions on the new tabs: the sportsbooks' strongest GKR picks (one per player and stat across both
  // books). They share Scout's second-opinion caps.
  let extraSeconds:{line:PropLine;gkr:NonNullable<AiRead['gkr']>}[]=[];
  const refreshExtraSeconds=async()=>{
    const next:typeof extraSeconds=[];const seen=new Set<string>();
    const bookPicksAll=(await Promise.all(sportsbooks.map(async(book)=>{const result=await picksFor(book);
      return (result?.picks??[]).filter((pick)=>pick.gkr).map((pick)=>({pick,line:result!.lines.get(pick.id)}));}))).flat()
      .sort((a,b)=>b.pick.score-a.pick.score);
    for(const {pick,line} of bookPicksAll){
      const key=`${line?.eventId}|${line?.playerId}|${pick.market}`;
      if(!line||seen.has(key)||next.length>=6)continue;
      seen.add(key);next.push({line,gkr:{direction:pick.side,score:pick.gkr!.score,modelVersion:pick.gkr!.modelVersion}});
    }
    extraSeconds=next;
    // Scout's own picks on Underdog and Pick6 lines GKR doesn't score at the app's number.
    if(options.scrapedLines){
      const lines:PropLine[]=[];
      for(const app of otherApps){
        const board=await appBoard(options.scrapedLines,app,service.getBoard()),scores=await scoresFor(app);
        // Every app line GKR doesn't score at the app's own number (with or without a PrizePicks twin).
        const only=asBoard(board.lines.filter((line)=>!scores.has(line.id)),board.fetchedAt??now().toISOString()).board.lines;
        // A line the free History Read already picks a side on doesn't need Scout's paid research.
        const read=await historyReads.readsFor(only);
        lines.push(...only.filter((line)=>{const item=read.get(line.id);return !item||item.direction==='PASS'||item.lean;}));
      }
      extraScout=lines;
    }
  };
  let extraScout:PropLine[]=[];
  if(options.aiPicks?.configured){
    options.aiPicks.setExtraSecondOpinions(()=>extraSeconds);
    options.aiPicks.setExtraScoutLines(()=>extraScout);
    // Scout skips PrizePicks lines a free History Read already picks a side on.
    options.aiPicks.setSkipLines((line)=>{const read=historyCache?.reads[line.id];return !!read&&read.direction!=='PASS'&&!read.lean;});
    const firstExtra=setTimeout(()=>{void refreshExtraSeconds().catch(()=>undefined);},60_000);firstExtra.unref();
    const everyExtra=setInterval(()=>{void refreshExtraSeconds().catch(()=>undefined);},15*60_000);everyExtra.unref();
    shadowTimers.push(firstExtra,everyExtra);
  }
  app.addHook('onClose', async () => {for(const timer of shadowTimers)clearTimeout(timer);options.playerHistory?.stop();appShadow?.stop();options.aiPicks?.stop(); webBuild?.cancel();options.ownerNotebook?.stop();contextScheduler?.stop();
    options.scraperPuller?.stop();options.tips?.grader?.stop();options.contextFeeds?.stop();options.sharpProps?.stop(); });

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
      if(code==='MEMBERS_FULL'||code==='LIFETIME_FULL'||code==='SIGNUP_CLOSED')return reply.code(403).send({code});
      return reply.code(503).send({code:'PROFILE_STORAGE_UNAVAILABLE'});}
  });
  // Sign-up is locked until a valid code is entered (owner, 2026-10-05): what sign-up needs, and a code check.
  app.get('/v1/auth/signup',async()=>({open:options.product?.openSignup??false,contact:options.signupContact??null}));
  app.post('/v1/auth/signup-code',async(request,reply)=>{
    if(!options.product)return reply.code(503).send({code:'PROFILES_UNCONFIGURED'});
    if(limited(`signup-code:${request.ip}`))return reply.code(429).send({code:'TOO_MANY_ATTEMPTS'});
    const input=z.object({code:z.string().min(1).max(128)}).strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'CODE_REQUIRED'});
    const result=await options.product.checkCode(input.data.code);
    if(result==='LIFETIME')return {valid:true,plan:'LIFETIME'};
    return reply.code(result==='LIFETIME_FULL'?403:404).send({code:result??'CODE_INVALID'});
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
  // Beta feedback: any signed-in tester reports a bug or suggestion and sees what happened to it; everyone reads the
  // patch notes. The owner reviews in the app; admin routes do the same for the twice-daily review.
  const feedbackInput=z.object({kind:z.enum(['BUG','SUGGESTION']),text:z.string().trim().min(5).max(2000),
    screen:z.string().trim().max(80).nullable().optional()}).strict();
  app.post('/v1/feedback',async(request,reply)=>{
    const user=await currentUser(request);
    if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(!options.feedback)return reply.code(503).send({code:'FEEDBACK_UNAVAILABLE'});
    const input=feedbackInput.safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'FEEDBACK_INVALID'});
    try{return reply.code(201).send(await options.feedback.submit({accountId:user.accountId,username:user.username},
      input.data.kind,input.data.text,input.data.screen??null));}
    catch(error){return (error as Error).message==='DAILY_LIMIT'?reply.code(429).send({code:'DAILY_LIMIT'})
      :reply.code(503).send({code:'FEEDBACK_UNAVAILABLE'});}
  });
  // Tips (owner-only for now): picks from the services the owner pays for, uploaded as a screenshot or text, in their own section (display-only).
  const tipStatus=z.enum(['PENDING','WON','LOST','PUSH','VOID']);
  // Set once Edge is running: each tip's Edge and GKR+ read from the boards.
  let tipModelReads:((tips:readonly (TipDraft&{id:string})[])=>Promise<Map<string,{edge:TipModelRead|null;gkrPlus:TipModelRead|null}>>)|null=null;
  app.get('/v1/tips',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    if(!options.tips)return reply.code(503).send({code:'TIPS_UNAVAILABLE'});
    const mine=await options.tips.store.mine(user.accountId);
    // Edge's and GKR+'s reads on each prop tip, fresh on every load (the Edge tab's own pricing; nothing is pulled).
    const reads=tipModelReads?await tipModelReads(mine.tips).catch(()=>null):null;
    return {...mine,tips:mine.tips.map((tip)=>({...tip,models:reads?.get(tip.id)??null})),reading:!!options.tips.reader};
  });
  app.post('/v1/tips/upload',{bodyLimit:8_000_000},async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    if(!options.tips?.reader)return reply.code(503).send({code:'TIPS_READER_UNAVAILABLE'});
    const input=z.object({image:z.object({data:z.string().min(100).max(7_500_000).regex(/^[A-Za-z0-9+/=]+$/),
      mediaType:z.enum(['image/png','image/jpeg','image/webp','image/gif'])}).optional(),
      text:z.string().trim().min(2).max(4000).optional(),source:z.string().trim().min(1).max(60).optional()})
      .strict().refine((value)=>value.image||value.text).safeParse(request.body);
    // Every attempt is logged (size and outcome, never the picture) so a failing upload can be traced.
    const body=request.body as {image?:{data?:unknown;mediaType?:unknown};text?:unknown}|null;
    const attempt=`image ${typeof body?.image?.data==='string'?Math.round(body.image.data.length/1024)+'KB':'none'} ${String(body?.image?.mediaType??'')} text ${typeof body?.text==='string'?body.text.length:0}`;
    if(!input.success){console.warn(`[tips] upload rejected (${attempt}): ${input.error.issues.map((issue)=>`${issue.path.join('.')} ${issue.message}`).join('; ').slice(0,300)}`);
      return reply.code(400).send({code:'INVALID_TIPS_UPLOAD'});}
    console.log(`[tips] upload (${attempt})`);
    if(await options.tips.store.uploadsToday(user.accountId)>=DAILY_TIP_UPLOADS)return reply.code(429).send({code:'DAILY_LIMIT'});
    try{
      const read=await options.tips.reader.read({...input.data.image?{image:input.data.image}:{},...input.data.text?{text:input.data.text}:{},
        today:now().toISOString().slice(0,10)});
      console.log(`[tips] read ${read.tips.length} picks`);
      if(!read.tips.length)return reply.code(422).send({code:'NO_TIPS_FOUND'});
      const lines=options.contextFeeds?(await options.contextFeeds.items<GameLine>('pinnacle')).items:[];
      const from=now().getTime();
      const tips=await options.tips.store.add(user.accountId,input.data.source??read.source??'Unnamed service',read.tips,
        read.tips.map((tip)=>marketRead(tip,lines,tip.eventDate?Date.parse(tip.eventDate):from)));
      // CrownIQ's opinion runs in the background (a web search per batch); the app refreshes until it lands.
      void analyzeTips(options.tips.store,options.tips.reader,tips,now);
      return reply.code(201).send({source:tips[0]!.source,tips:tips.map(({accountId:_account,...tip})=>tip)});
    }catch(error){const message=error instanceof Error?error.message:String(error);console.warn('[tips] read failed',message);
      // The Claude account behind CrownIQ is out of credits: say so instead of "could not read".
      if(/credit balance is too low/i.test(message))return reply.code(503).send({code:'AI_CREDITS_EXHAUSTED'});
      return reply.code(502).send({code:'TIPS_READ_FAILED'});}
  });
  app.post('/v1/tips/recheck',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    if(!options.tips?.reader)return reply.code(503).send({code:'TIPS_READER_UNAVAILABLE'});
    const input=z.object({ids:z.array(z.string().uuid()).min(1).max(40)}).strict().safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'INVALID_TIPS_RECHECK'});
    const tips=await options.tips.store.startRecheck(user.accountId,input.data.ids);
    if(tips.length)void analyzeTips(options.tips.store,options.tips.reader,tips,now);
    return {rechecking:tips.length};
  });
  app.patch('/v1/tips/:id',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    if(!options.tips)return reply.code(503).send({code:'TIPS_UNAVAILABLE'});
    const id=z.string().uuid().safeParse((request.params as {id?:string}).id);
    const input=z.object({status:tipStatus.optional(),source:z.string().trim().min(1).max(60).optional()}).strict().safeParse(request.body);
    if(!id.success||!input.success)return reply.code(400).send({code:'INVALID_TIP_UPDATE'});
    return await options.tips.store.update(user.accountId,id.data,input.data)?{updated:true}:reply.code(404).send({code:'TIP_NOT_FOUND'});
  });
  app.delete('/v1/tips/:id',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    if(!options.tips)return reply.code(503).send({code:'TIPS_UNAVAILABLE'});
    const id=z.string().uuid().safeParse((request.params as {id?:string}).id);
    if(!id.success)return reply.code(400).send({code:'INVALID_TIP_ID'});
    return await options.tips.store.remove(user.accountId,id.data)?{removed:true}:reply.code(404).send({code:'TIP_NOT_FOUND'});
  });
  app.get('/v1/feedback/mine',async(request,reply)=>{
    const user=await currentUser(request);
    if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    return {items:options.feedback?await options.feedback.mine(user.accountId):[]};
  });
  app.get('/v1/updates',async()=>({updates:options.feedback?await options.feedback.updates():[]}));
  const reviewInput=z.object({status:z.enum(['NEW','PLANNED','FIXED','DECLINED']),reply:z.string().trim().max(1000).nullable().optional()}).strict();
  const updateInput=z.object({title:z.string().trim().min(3).max(120),body:z.string().trim().min(3).max(4000),
    feedbackIds:z.array(z.string().uuid()).max(100).optional()}).strict();
  const isOwner=async(request:FastifyRequest)=>{const user=await currentUser(request);
    return !!options.ownerPublicId&&user?.publicId===options.ownerPublicId;};
  // GKR+ is the owner's, plus any account unlocked with the Secrets password.
  const hasGkrPlus=async(request:FastifyRequest)=>{if(await isOwner(request))return true;
    const user=await currentUser(request);return !!user&&!!options.secrets&&await options.secrets.unlocks.has(user.accountId);};
  app.get('/v1/secrets',async(request,reply)=>{
    if(!await currentUser(request))return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    return {gkrPlus:await hasGkrPlus(request)};
  });
  app.post('/v1/secrets/unlock',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    if(limited(`secrets:${user.accountId}`))return reply.code(429).send({code:'TOO_MANY_TRIES'});
    const input=z.object({password:z.string().max(200)}).strict().safeParse(request.body);
    if(!input.success||!options.secrets)return reply.code(400).send({code:'INVALID_PASSWORD'});
    if(!passwordMatches(input.data.password,options.secrets.password))return reply.code(403).send({code:'WRONG_PASSWORD'});
    await options.secrets.unlocks.add(user.accountId,user.username??null);
    return {gkrPlus:true};
  });
  // Time on the app: one beat a minute from a signed-in member's open app; the owner sees the totals.
  app.post('/v1/activity',async(request,reply)=>{
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    const input=z.object({tab:z.string().trim().max(60).nullable().optional()}).strict().safeParse(request.body??{});
    if(!input.success)return reply.code(400).send({code:'INVALID_ACTIVITY'});
    const counted=options.activity?await options.activity.beat(user.accountId,user.username??null,input.data.tab??null):false;
    return {counted};
  });
  app.get('/v1/owner/activity',async(request,reply)=>{
    if(!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    return {members:options.activity?await options.activity.report():[]};
  });
  if(options.activity&&!options.clock){const flush=setInterval(()=>{void options.activity!.flush().catch(()=>undefined);},5*60_000);flush.unref();}
  // The owner's list of unlocked accounts, and removing one (it loses GKR+ on its next load).
  app.get('/v1/owner/secrets',async(request,reply)=>{
    if(!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    return {unlocked:options.secrets?await options.secrets.unlocks.list():[]};
  });
  app.delete('/v1/owner/secrets/:accountId',async(request,reply)=>{
    if(!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    const id=z.object({accountId:z.string().min(1).max(200)}).safeParse(request.params);
    if(!id.success||!options.secrets)return reply.code(400).send({code:'INVALID_ACCOUNT'});
    return await options.secrets.unlocks.remove(id.data.accountId)?{removed:true}:reply.code(404).send({code:'NOT_UNLOCKED'});
  });
  // "Refresh all now, skip next": every scheduled scraper and context feed pulls now (plus the sportsbook feed), and each one's
  // next scheduled run is marked done so it is skipped (no paying twice). Runs in the background; the result goes to the log.
  let refreshAll:{startedAt:string;finishedAt:string|null;skipped:string[];summary:string|null}|null=null;
  app.post('/v1/owner/refresh-all',async(request,reply)=>{
    if(!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    if(refreshAll&&!refreshAll.finishedAt)return reply.code(409).send({code:'REFRESH_RUNNING',...refreshAll});
    const job:{startedAt:string;finishedAt:string|null;skipped:string[];summary:string|null}={startedAt:now().toISOString(),finishedAt:null,skipped:[],summary:null};
    refreshAll=job;
    void (async()=>{
      try{
        const [scrapers,feeds]=await Promise.all([options.scraperPuller?.refreshAllSkipNext()??null,options.contextFeeds?.refreshAllSkipNext()??null]);
        const sharp=options.sharpProps?await options.sharpProps.refresh().catch(()=>null):null;
        job.skipped=[...scrapers?.skipped??[],...feeds?.skipped??[]];
        job.summary=JSON.stringify({scrapers:scrapers?.reports.map((report)=>({source:report.source,status:report.status,rows:report.rows}))??[],
          feeds:feeds?.reports.map((report)=>({source:report.source,status:report.status,rows:report.rows}))??[],sharpPrices:sharp?.prices??null});
      }catch(error){job.summary=`failed: ${error instanceof Error?error.message:String(error)}`;}
      finally{job.finishedAt=now().toISOString();console.log(`[refresh-all] skipped next: ${job.skipped.join(', ')||'none'} · ${job.summary}`);}
    })();
    return reply.code(202).send({started:true});
  });
  app.get('/v1/owner/refresh-all',async(request,reply)=>{
    if(!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    return refreshAll??{startedAt:null};
  });
  app.get('/v1/owner/feedback',async(request,reply)=>{
    if(!options.feedback||!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    return {items:await options.feedback.all(),summary:await options.feedback.summary()};
  });
  app.post('/v1/owner/feedback/:id',async(request,reply)=>{
    if(!options.feedback||!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    const id=z.string().uuid().safeParse((request.params as {id?:string}).id),input=reviewInput.safeParse(request.body);
    if(!id.success||!input.success)return reply.code(400).send({code:'REVIEW_INVALID'});
    try{return await options.feedback.review(id.data,input.data.status,input.data.reply??null);}
    catch{return reply.code(404).send({code:'FEEDBACK_NOT_FOUND'});}
  });
  app.post('/v1/owner/updates',async(request,reply)=>{
    if(!options.feedback||!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    const input=updateInput.safeParse(request.body);
    if(!input.success)return reply.code(400).send({code:'UPDATE_INVALID'});
    return reply.code(201).send(await options.feedback.postUpdate(input.data.title,input.data.body,input.data.feedbackIds));
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
        sideBias:edge?.sideBias()??null,
        lineSources:{prizePicksFeed:(await options.sharpProps?.status())?.prizePicksFeed??null,
          books:options.sharpProps?await options.sharpProps.status().then((sharp)=>({selectedButEmpty:sharp.selectedButEmpty??[],
            planSelects:sharp.planSelects??null,requestsLastHour:sharp.requestsLastHour??0})):null,
          board:(options.provider as {lastReport?:BoardSourceReport|null}|null|undefined)?.lastReport??null},
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
      if(code==='MEMBERS_FULL'||code==='SIGNUP_CLOSED')return reply.code(403).send({code});
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
    // Underdog and DK Pick'em take up to 8 picks; PrizePicks up to 6.
    const input=z.object({lineIds:z.array(z.string().min(1).max(300)).min(2).max(8),personal:z.literal(true).optional(),
      directions:z.record(z.string(),z.enum(['MORE','LESS'])).optional(),app:z.enum(['underdog','pick6']).optional()})
      .strict().refine((value)=>!value.personal||value.lineIds.every((id)=>value.directions?.[id]))
      .refine((value)=>!!value.app||value.lineIds.length<=6)
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
    const [injuries,pinnacle]=await Promise.all([options.contextFeeds.items<InjuryNote>('injuries'),
      options.contextFeeds.items<GameLine>('pinnacle')]);
    const game=gameLinesFor(line,pinnacle.items);
    const team=line.team;
    const teamInjuries=team?injuries.items.filter((item)=>item.league.toUpperCase()===line.league.toUpperCase()&&
      (item.teamAbbreviation?.toUpperCase()===team.toUpperCase()||normalizedName(item.team)===normalizedName(team)))
      .slice(0,8):[];
    return {injury:injuryFor(line,injuries.items),teamInjuries,game,
      markets:[],fetchedAt:{injuries:injuries.fetchedAt,pinnacle:pinnacle.fetchedAt}};
  });
  // Each app's payouts and the per-pick hit rate every entry needs to break even.
  const payouts=options.payouts??DEFAULT_PAYOUTS;
  app.get('/v1/payouts', async () => ({payouts,breakEvens:Object.fromEntries(pickAppSchema.options.map((name)=>
    [name,entryBreakEvens(payouts[name])]))}));
  // CrownIQ's own +EV: sportsbook no-vig chances against the pick'em break-even. Separate from GKR; never scored.
  // +EV on every pick'em app: the books' no-vig chance (same number, or estimated from nearby numbers) against each app's
  // easiest break-even, with the History Read on the same line alongside. ?app=prizepicks|underdog|pick6 narrows it.
  let evCache:{at:number;key:readonly unknown[];value:{fetchedAt:string|null;breakEvens:Record<string,number>;picks:EvPick[]}}|null=null;
  app.get('/v1/ev', async (request, reply) => {
    const board=service.getBoard();
    if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
    if(!options.sharpProps)return reply.code(503).send({code:'EV_UNCONFIGURED'});
    const only=z.object({app:z.enum(['prizepicks','underdog','pick6']).optional()}).parse(request.query).app;
    const {fetchedAt,prices}=await options.sharpProps.current();
    const time=now().getTime();
    if(!evCache||evCache.key[0]!==board||evCache.key[1]!==prices||time-evCache.at>5*60_000){
      const breakEvens:Record<string,number>={prizepicks:options.evBreakEven??bestBreakEven(payouts.prizepicks)?.breakEven??DEFAULT_BREAK_EVEN};
      const ppHistory=new Map(Object.entries(await boardHistoryReads(board).catch(()=>({}))));
      const picks=evPicks(board,prices,now(),breakEvens.prizepicks,{nearby:true,app:'prizepicks',history:ppHistory});
      for(const appName of options.scrapedLines?otherApps:[]){
        const appLines=(await appBoard(options.scrapedLines!,appName,null)).lines.filter((line)=>line.lineType==='REGULAR');
        const appBoardView=asBoard(appLines,fetchedAt??now().toISOString(),await scoresFor(appName));
        const breakEven=bestBreakEven(payouts[appName])?.breakEven;
        if(!breakEven)continue;
        breakEvens[appName]=breakEven;
        const reads=await historyReads.readsFor(appBoardView.board.lines).catch(()=>new Map<string,HistoryRead>());
        const multipliers=new Map(appLines.map((line)=>[line.id,line.multipliers]));
        picks.push(...evPicks(appBoardView,prices,now(),breakEven,{nearby:true,app:appName,history:reads,
          multiplier:(lineId,side)=>multipliers.get(lineId)?.[side]??null}));
      }
      evCache={at:time,key:[board,prices],value:{fetchedAt,breakEvens,picks:picks.filter((pick)=>pick.edge>0).sort((a,b)=>b.edge-a.edge)}};
    }
    const {breakEvens,picks}=evCache.value;
    const shown=only?picks.filter((pick)=>pick.app===only):picks;
    return {app:only??'all',fetchedAt,breakEven:breakEvens[only??'prizepicks']??DEFAULT_BREAK_EVEN,breakEvens,matched:shown.length,
      picks:shown.slice(0,250)};
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
  // Ask Scout on an Underdog or Pick6 line GKR can't score, within the same daily allowance as the PrizePicks board.
  app.post('/v1/apps/:app/ask/:lineId', async (request, reply) => {
    const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
    const parsed=z.object({app:z.enum(otherApps as [OtherApp,...OtherApp[]]),lineId:z.string().min(1).max(300)}).safeParse(request.params);
    if(!parsed.success)return reply.code(400).send({code:'INVALID_LINE'});
    if(!options.aiPicks)return reply.code(503).send({code:'AI_UNCONFIGURED'});
    if(!options.scrapedLines)return reply.code(503).send({code:'APP_LINES_UNAVAILABLE'});
    const board=await appBoard(options.scrapedLines,parsed.data.app,null);
    const appLine=board.lines.find((item)=>item.id===parsed.data.lineId);
    if(!appLine)return reply.code(404).send({code:'LINE_NOT_FOUND'});
    if((await scoresFor(parsed.data.app)).has(appLine.id))return reply.code(422).send({code:'GKR_SCORES_THIS_LINE'});
    const line=asBoard([appLine],board.fetchedAt??now().toISOString()).board.lines[0];
    const result=await options.aiPicks.ask(user.accountId,line,undefined,service.getEvidence(),null);
    if(!result.read)return reply.code(result.error==='DAILY_LIMIT_REACHED'?429:result.error==='AI_UNAVAILABLE'?502:422)
      .send({code:result.error});
    return {scout:{pick:result.read.pick,score:result.read.score,agreement:result.read.agreement}};
  });
  // Lines waiting on Scout: GKR can't score them and Scout hasn't read them, on PrizePicks (standard lines) and on
  // Underdog and Pick6 (any line GKR doesn't score at the app's number). Games not started yet.
  type ScoutBoard='prizepicks'|OtherApp;
  async function waitingForScout():Promise<{board:ScoutBoard;line:PropLine}[]>{
    if(!options.aiPicks)return [];
    const read=new Set((await options.aiPicks.upcoming()).map((item)=>`${item.lineId}|${item.threshold}`));
    const time=now().getTime(),open=(line:PropLine)=>Date.parse(line.eventStartTime)>time&&!read.has(`${line.id}|${line.threshold}`);
    const out:{board:ScoutBoard;line:PropLine}[]=[];
    const board=service.getBoard();
    if(board){const analyses=new Map(board.analyses.map((item)=>[item.lineId,item]));
      const reads=await boardHistoryReads(board);
      for(const line of board.board.lines)if(line.lineType==='REGULAR'&&open(line)&&aiEligible(line,analyses.get(line.id))&&
        (!reads[line.id]||reads[line.id].direction==='PASS'||reads[line.id].lean))out.push({board:'prizepicks',line});}
    if(options.scrapedLines)for(const app of otherApps){
      const appLines=await appBoard(options.scrapedLines,app,board),scores=await scoresFor(app);
      const only=appLines.lines.filter((line)=>!scores.has(line.id));
      const appRows=asBoard(only,appLines.fetchedAt??now().toISOString()).board.lines.filter(open);
      const read=await historyReads.readsFor(appRows);
      for(const line of appRows){const item=read.get(line.id);if(!item||item.direction==='PASS'||item.lean)out.push({board:app,line});}
    }
    return out;
  }
  // Owner: how many lines wait on Scout (by board and sport), and Ask all or by board and sport. Answers go straight to
  // the boards; the owner's allowance is separate from the scheduled run's.
  app.get('/v1/owner/scout-queue',async(request,reply)=>{
    if(!options.aiPicks||!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    const waiting=await waitingForScout(),boards:Record<string,{total:number;sports:Record<string,number>}>={};
    for(const {board,line} of waiting){const entry=boards[board]??={total:0,sports:{}};
      entry.total++;entry.sports[line.league]=(entry.sports[line.league]??0)+1;}
    return {total:waiting.length,boards,status:await options.aiPicks.ownerStatus()};
  });
  app.post('/v1/owner/scout-queue',async(request,reply)=>{
    if(!options.aiPicks||!await isOwner(request))return reply.code(404).send({code:'NOT_FOUND'});
    const input=z.object({board:z.enum(['all','prizepicks',...otherApps] as [string,...string[]]).default('all'),
      sport:z.string().trim().max(40).optional()}).strict().safeParse(request.body??{});
    if(!input.success)return reply.code(400).send({code:'QUEUE_INVALID'});
    const lines=(await waitingForScout()).filter((item)=>(input.data.board==='all'||item.board===input.data.board)&&
      (!input.data.sport||item.line.league===input.data.sport)).map((item)=>item.line);
    const fair=await fairMoreFor().catch(()=>new Map<string,number>());
    const queued=await options.aiPicks.enqueueOwner(lines,()=>service.getEvidence(),(lineId)=>fair.get(lineId)??null);
    return {matched:lines.length,queued,status:await options.aiPicks.ownerStatus()};
  });
  // A stamp that changes when a new GKR play or a new Scout read lands, so open apps can say "new data, refresh".
  let dataVersion:{at:number;value:string}|null=null;
  app.get('/v1/data-version',async()=>{
    const time=now().getTime();
    if(dataVersion&&time-dataVersion.at<30_000)return {version:dataVersion.value};
    const hash=createHash('sha256'),board=service.getBoard();
    for(const analysis of board?.analyses??[])if(analysis.direction!=='PASS'&&analysis.score!==null)hash.update(`g:${analysis.lineId}:${analysis.direction}|`);
    for(const read of (await options.aiPicks?.upcoming())??[])hash.update(`s:${read.lineId}:${read.threshold}:${read.pick}|`);
    for(const app of otherApps)for(const [id,score] of await scoresFor(app))hash.update(`a:${id}:${score.direction}|`);
    dataVersion={at:time,value:hash.digest('hex').slice(0,16)};
    return {version:dataVersion.value};
  });
  // History Reads: a free More/Less from each player's recent results (CrownIQ's history, then the free public
  // sources) on lines GKR doesn't play, with the books' no-vig chance blended in where there is one.
  // Soccer from Sofascore: queues both teams' recent fixtures for lookup, and reads what's already stored.
  const soccerValues=async(line:PropLine)=>{
    if(!options.soccerHistory)return null;
    const target={eventId:line.eventId,eventName:line.eventName,eventStartTime:line.eventStartTime,league:line.league,
      playerId:line.playerId,playerName:line.playerName,team:line.team,opponent:line.opponent,homeTeam:line.homeTeam??null,
      awayTeam:line.awayTeam??null,market:line.market,sport:line.sport,sourceSportKey:line.sourceSportKey??null};
    const fixtures=await options.espnHistory?.soccerFixtures?.(target).catch(()=>[])??[];
    options.soccerHistory.queue(fixtures);
    const found=await options.soccerHistory.values(line.playerName,line.market,line.eventStartTime).catch(()=>null);
    return found&&found.values.length>=5?found:null;
  };
  const historyReads=new HistoryReads(async(line)=>{
    // Fantasy score is read on PrizePicks only (owner, 2026-10-07: Underdog and DK Pick'em fantasy lines get no read).
    if(fantasyBlocked(line))return null;
    // Soccer fantasy score: PrizePicks' chart over Sofascore's full match stats (PrizePicks only).
    if(line.sport==='SOCCER'&&isFantasyMarket(line.market))return fantasyApp(line)==='prizepicks'?soccerValues(line):null;
    // UFC: each fighter's past fights from UFCStats (fantasy on PrizePicks' MMA chart, strikes, takedowns, rounds).
    if(/^(UFC|MMA)/i.test(line.league)){
      if(!options.ufcHistory)return null;
      const found=await options.ufcHistory.values(line.playerName,line.market).catch(()=>null);
      return found&&found.values.length>=4?found:null;
    }
    // Fantasy score: each app's own chart over ESPN's box scores (DK Pick'em's chart isn't confirmed: no read).
    if(isFantasyMarket(line.market)){
      const app=fantasyApp(line);
      if(line.sport==='TENNIS'){
        if(app!=='prizepicks'||!options.playerHistory?.tennisFantasy)return null;
        const found=await options.playerHistory.tennisFantasy(line.playerName).catch(()=>null);
        return found&&found.values.length>=5?found:null;
      }
      if(app==='pick6'||!options.espnHistory?.recentFantasy)return null;
      const values=await options.espnHistory.recentFantasy({eventId:line.eventId,eventName:line.eventName,eventStartTime:line.eventStartTime,
        league:line.league,playerId:line.playerId,playerName:line.playerName,team:line.team,opponent:line.opponent,
        homeTeam:line.homeTeam??null,awayTeam:line.awayTeam??null,market:line.market,sport:line.sport,
        sourceSportKey:line.sourceSportKey??null},app).catch(()=>null);
      return values&&values.length>=5?{values,source:`ESPN box scores, ${app==='underdog'?'Underdog':'PrizePicks'} fantasy scoring`}:null;
    }
    const log=options.internalHistory?await options.internalHistory.gameLog(line.sport,line.playerId,line.playerName,line.market,
      new Date(line.eventStartTime)).catch(()=>null):null;
    if(log&&log.games.length>=5)return {values:log.games.map((game)=>game.value),source:'CrownIQ history'};
    // Stats CrownIQ's history has no spec for, read from the Stat API rows it stored (MLB total bases, RBIs, runs...).
    const statValue=statApiValueFor(line.sport,line.market);
    if(statValue&&options.internalHistory){
      const values=await options.internalHistory.valuesWith(line.sport,line.playerId,line.playerName,new Date(line.eventStartTime),statValue).catch(()=>[]);
      if(values.length>=5)return {values,source:'Stat API history'};
    }
    // Soccer, NHL and college football from ESPN's public game logs.
    if(options.espnHistory){
      const values=await options.espnHistory.recentValues({eventId:line.eventId,eventName:line.eventName,eventStartTime:line.eventStartTime,
        league:line.league,playerId:line.playerId,playerName:line.playerName,team:line.team,opponent:line.opponent,
        homeTeam:line.homeTeam??null,awayTeam:line.awayTeam??null,market:line.market,sport:line.sport,
        sourceSportKey:line.sourceSportKey??null}).catch(()=>null);
      if(values&&values.length>=5)return {values,source:'ESPN game logs'};
    }
    // Soccer stats ESPN doesn't carry (tackles, passes, clearances...) or players it couldn't find: Sofascore.
    if(line.sport==='SOCCER'){const sofascore=await soccerValues(line);if(sofascore)return sofascore;}
    const free=options.playerHistory?.supports(line.sport)?await options.playerHistory.values(line.sport,line.playerName,line.market).catch(()=>null):null;
    if(!free||(free.perMap&&twoMaps(line.market)))return null;
    return {values:free.values.map((game)=>game.value),source:free.source};
  },()=>now());
  // CrownIQ Edge (Edge 2.0): its own reads of every platform, warmed in the background like the app boards.
  const movement=new MovementTracker();
  // Step 7: the tracker starts from the last saved book prices, so the first refresh after a restart can see moves
  // (it only remembered prices in memory, and every deploy reset it: stale and steam stayed at 0).
  if(options.sharpProps&&!options.clock)void options.sharpProps.current().then(({prices,fetchedAt})=>{
    if(prices.length&&fetchedAt)movement.observe(prices,Date.parse(fetchedAt));}).catch(()=>undefined);
  const edge=options.edge&&options.edge.enabled!==false?new EdgeService({board:()=>service.getBoard(),
    // SharpAPI's book prices plus the Odds API consensus books from the PrizePicks pull (step 5a; their age discounts them).
    sharp:options.sharpProps?{prices:async()=>[...(await options.sharpProps!.current()).prices,...(options.oddsConsensus?.()??[])],
      pickem:async()=>(await options.sharpProps!.pickemLines()).lines}:null,
    appBoards:options.scrapedLines??null,pick6PayoutsConfirmed:options.edge.pick6PayoutsConfirmed===true,
    history:options.internalHistory??null,values:(line)=>historyReads.valuesFor(line),ledger:options.edge.ledger??null,
    payouts:options.payouts??DEFAULT_PAYOUTS,...(options.edge.alternateFactors?{alternateFactors:options.edge.alternateFactors}:{}),
    ...(options.edge.alternateCurve?{alternateCurve:options.edge.alternateCurve}:{}),
    valuesCacheFile:options.edge.valuesCacheFile??null,movement,snapshots:options.edge.snapshots??null,
    alertsFile:options.edge.alertsFile??null,staleLogFile:options.edge.staleLogFile??null,dispersion:options.edge.dispersion??null,bookWeights:options.edge.bookWeights??null,
    injuries:options.contextFeeds?async()=>(await options.contextFeeds!.items<InjuryNote>('injuries')).items:null,
    // Pinnacle's game lines plus SharpAPI's KBO run totals and run lines (step 6), for the game environment.
    gameLines:options.contextFeeds||options.sharpProps?async()=>[
      ...(options.contextFeeds?(await options.contextFeeds.items<GameLine>('pinnacle')).items:[]),
      ...(options.sharpProps?sharpGameLines((await options.sharpProps.extras()).games.filter((game)=>game.league==='kbo')):[])]:null,
    clock:()=>now()}):null;
  const edgeWorker=edge&&options.edge?.ledger?new EdgeResultsWorker(options.edge.ledger,options.internalHistory??null,
    options.edge.boxScores??null,()=>now(),
    options.playerHistory?(sport,playerName,market)=>options.playerHistory!.values(sport,playerName,market):null):null;
  if(edge){
    // Hard Rock joined with the book change (9b): its picks stay out of Top Picks and Gen until the side-bias check clears it.
    const heldPlatforms=new Set((process.env.CROWNIQ_EDGE_HOLD??'hardrock').split(',').map((item)=>item.trim()).filter(Boolean));
    // A platform is held while its +EV picks are lopsided (step 9), and a new feed (CROWNIQ_EDGE_HOLD) until it has passed the
    // side-bias check two refreshes running.
    // A book whose SharpAPI feed is down ("book_unavailable") says so on its tabs instead of looking empty.
    const feedNote=async(platform:string)=>{
      if(platform!=='draftkings'&&platform!=='hardrock'||!options.sharpProps)return null;
      const status=await options.sharpProps.status();
      return bookFeedNote(status,platform,platform==='hardrock'?'Hard Rock':'DraftKings');
    };
    registerEdgeRoutes(app,{edge,feedNote,held:(platform)=>edge.sideBiasFlagged(platform)||(heldPlatforms.has(platform)&&!edge.sideBiasCleared(platform)),ledger:options.edge?.ledger??null,worker:edgeWorker,snapshots:options.edge?.snapshots??null,
      internalHistory:options.internalHistory??null,isOwner:(request)=>isOwner(request),now,
      health:async()=>({board:{fetchedAt:service.getBoard()?.board.fetchedAt??null},
        sharpApi:options.sharpProps?await options.sharpProps.status():null,
        scrapers:options.scraperPuller?await options.scraperPuller.status():null,
        contextFeeds:options.contextFeeds?await options.contextFeeds.status():null,
        oddsApi:options.oddsApiQuota?await options.oddsApiQuota().catch(()=>null):null})});
    // GKR+ (owner only): Edge's read blended with history at the number and GKR's side, on every platform; its own ledger.
    const gkrPlusLedger=options.edge?.gkrPlusLedger??null;
    const gkrPlusWorker=gkrPlusLedger?new EdgeResultsWorker(gkrPlusLedger,options.internalHistory??null,options.edge?.boxScores??null,()=>now(),
      options.playerHistory?(sport,playerName,market)=>options.playerHistory!.values(sport,playerName,market):null):null;
    const gkrSides=async(platform:EdgePlatform):Promise<(pick:EdgePick)=>GkrSide|null>=>{
      if(platform==='prizepicks'){
        const analyses=new Map((service.getBoard()?.analyses??[]).flatMap((item)=>item.direction!=='PASS'&&item.score!==null
          ?[[item.lineId,{direction:item.direction as 'MORE'|'LESS',score:item.score}] as const]:[]));
        return (pick)=>analyses.get(pick.lineId)??null;
      }
      if(platform==='underdog'||platform==='pick6'){
        const scores=await scoresFor(platform),prefix=platform==='underdog'?'ud':'p6';
        return (pick)=>{const score=scores.get(`${prefix}:${pick.lineId.slice(platform.length+1)}`);
          return score?{direction:score.direction,score:score.score}:null;};
      }
      // The books: GKR's side at the book's number, matched by player, stat and number.
      const picks=(await picksFor(platform).catch(()=>null))?.picks??[];
      const key=(sport:string,player:string,market:string,line:number)=>`${normalizedName(player)}|${canonicalMarket(sport,market)}|${line}`;
      const byKey=new Map(picks.filter((item)=>item.gkr).map((item)=>[key(item.sport,item.playerName,item.market,item.line),
        {direction:item.side,score:item.gkr!.score}] as const));
      return (pick)=>byKey.get(key(pick.sport,pick.playerName,pick.market,pick.threshold))??null;
    };
    const gkrPlus=async(platform:EdgePlatform)=>{
      const snapshot=await edge.snapshot(platform);
      if(!snapshot)return null;
      const picks=blendPicks(snapshot.response.picks,await gkrSides(platform));
      return {snapshot,picks};
    };
    tipModelReads=async(tips)=>{
      const out=new Map<string,{edge:TipModelRead|null;gkrPlus:TipModelRead|null}>();
      const props=tips.filter((tip)=>tip.market==='PLAYER_PROP'&&tip.line!==null);
      if(!props.length)return out;
      // PrizePicks first (most uploads are PrizePicks slips), then the other apps and books.
      for(const platform of EDGE_PLATFORMS){
        const open=props.filter((tip)=>!out.has(tip.id));
        if(!open.length)break;
        const snapshot=await edge.snapshot(platform).catch(()=>null);
        if(!snapshot)continue;
        let sides:((pick:EdgePick)=>GkrSide|null)|null=null;
        for(const tip of open){
          const pick=matchTip(tip,snapshot.byLine.values());
          if(!pick)continue;
          sides??=await gkrSides(platform).catch(()=>()=>null);
          out.set(tip.id,{edge:modelRead(tip,pick,platform),gkrPlus:modelRead(tip,blendPick(pick,sides(pick)),platform)});
        }
      }
      return out;
    };
    app.register(async(owner)=>{
      owner.addHook('preHandler',async(request,reply)=>{
        reply.header('Cache-Control','private, no-store');
        if(!await hasGkrPlus(request))return reply.code(404).send({code:'NOT_FOUND'});
      });
      owner.get('/',async(request,reply)=>{
        const query=z.object({platform:z.enum(EDGE_PLATFORMS as [EdgePlatform,...EdgePlatform[]]).default('prizepicks'),
          limit:z.coerce.number().int().min(1).max(500).default(150),day:z.enum(['all','today']).default('all'),
          q:z.string().trim().max(60).optional(),slipSport:z.string().trim().min(1).max(20).optional()}).safeParse(request.query);
        if(!query.success)return reply.code(400).send({code:'INVALID_QUERY'});
        const result=await gkrPlus(query.data.platform);
        if(!result)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
        const note=await feedNote(query.data.platform);
        if(note)return {...result.snapshot.response,picks:[],slips:[],feedNote:note,modelVersion:GKR_PLUS_VERSION};
        // A platform Edge holds (side-bias alarm, or a new feed not yet cleared) is held here too.
        if(edge.sideBiasFlagged(query.data.platform)||(heldPlatforms.has(query.data.platform)&&!edge.sideBiasCleared(query.data.platform)))
          return {...result.snapshot.response,picks:[],slips:[],counts:{...result.snapshot.response.counts,positiveEdge:0},modelVersion:GKR_PLUS_VERSION};
        const nowMs=now().getTime(),live=result.picks.filter((pick)=>Date.parse(pick.eventStartTime)>nowMs+5*60_000);
        // Player search: every line Edge read for the player, blended, plays or not.
        if(query.data.q){
          const sides=await gkrSides(query.data.platform).catch(()=>()=>null);
          const found=blendPicks(searchPicks(result.snapshot,query.data.q,nowMs,query.data.limit),sides)
            .filter((pick)=>query.data.day!=='today'||easternDay(new Date(pick.eventStartTime))===easternDay(new Date(nowMs)));
          return {...result.snapshot.response,picks:found,slips:[],modelVersion:GKR_PLUS_VERSION};
        }
        // Today only covers the whole page: picks and entries from today's games (Eastern).
        const ranked=live.filter((pick)=>pick.edge!==null&&pick.rating!=='NONE'&&
          (query.data.day!=='today'||easternDay(new Date(pick.eventStartTime))===easternDay(new Date(nowMs))));
        return {...result.snapshot.response,picks:ranked.slice(0,query.data.limit),
          // The sport chips build entries from that sport's picks only; the pick list stays whole.
          slips:buildSlips(query.data.slipSport?ranked.filter((pick)=>pick.sport===query.data.slipSport):ranked,
            result.snapshot.response.entries,{minEvents:result.snapshot.minEvents}),
          counts:{...result.snapshot.response.counts,positiveEdge:ranked.length},modelVersion:GKR_PLUS_VERSION};
      });
      owner.get('/record',async(_request,reply)=>gkrPlusLedger?{model:GKR_PLUS_VERSION,grading:gkrPlusWorker?.status()??null,
        ...await gkrPlusLedger.report()}:reply.code(503).send({code:'GKR_PLUS_UNCONFIGURED'}));
    },{prefix:'/v1/owner/gkr-plus'});
    if(!options.clock){
      // GKR+ picks are recorded every 15 minutes on every platform and graded hourly, like Edge's.
      const recordGkrPlus=()=>{void (async()=>{
        if(!gkrPlusLedger)return;
        for(const platform of EDGE_PLATFORMS){
          const result=await gkrPlus(platform).catch(()=>null);
          if(!result)continue;
          await gkrPlusLedger.record(result.picks,(lineId)=>{const line=result.snapshot.lines.get(lineId);
            return {team:line?.team??null,home:line?.homeTeam??null,away:line?.awayTeam??null};});
        }
      })().catch((error:unknown)=>console.warn('[gkr-plus] record failed',error instanceof Error?error.message:error));};
      const firstPlus=setTimeout(recordGkrPlus,4*60_000);firstPlus.unref();
      const everyPlus=setInterval(recordGkrPlus,15*60_000);everyPlus.unref();
      gkrPlusWorker?.start();
      shadowTimers.push(firstPlus,everyPlus);
    }
    if(!options.clock){
      const warm=()=>{void edge.snapshot().catch(()=>undefined);};
      const first=setTimeout(warm,60_000);first.unref();
      const every=setInterval(warm,3*60_000);every.unref();
      // Hourly health line for the logs (spec §10): snapshot rows and grading coverage.
      const healthLog=()=>{void (async()=>{
        const snap=options.edge?.snapshots?.status()??null;
        const coverage=options.edge?.ledger?(await options.edge.ledger.report()).gradingCoverage:null;
        console.log(`[edge-health] snapshots ${JSON.stringify(snap?{rows:snap.rows,lastHour:snap.lastHour,lastDay:snap.lastDay,oldest:snap.oldest}:null)}, `+
          `grading ${JSON.stringify(coverage?{finished:coverage.finished,graded:coverage.graded,rate:coverage.rate,onTimeRate:coverage.onTimeRate,
            bySport:Object.fromEntries(Object.entries(coverage.bySport).map(([sport,value])=>[sport,value.rate]))}:null)}`);
      })().catch(()=>undefined);};
      const firstHealth=setTimeout(healthLog,5*60_000);firstHealth.unref();
      const hourly=setInterval(healthLog,3600_000);hourly.unref();
      edgeWorker?.start();
      const grade=setTimeout(()=>{void edgeWorker?.runOnce().catch(()=>undefined);},5*60_000);grade.unref();
      shadowTimers.push(first,every,grade);
    }
  }
  // Edge's odds snapshots: every SharpAPI refresh, and the scraped boards every 5 minutes (only changes are kept).
  const snapshots=options.edge?.snapshots??null;
  if(snapshots&&!options.clock){
    options.sharpProps?.whenRefreshed(async(prices,at)=>{
      const moves=movement.observe(prices,at.getTime());
      if(moves)console.log(`[edge-movement] ${moves} book moves`);
      const pickem=(await options.sharpProps!.pickemLines()).lines;
      const changed=snapshots.record([...bookRows(prices,at.toISOString()),...pickemRows(pickem,at.toISOString())]);
      console.log(`[edge-snapshots] sharpapi ${prices.length} prices, ${pickem.length} PrizePicks lines, ${changed} changed`);
    });
    const tick=async()=>{
      const at=now().toISOString();
      const lines=options.scrapedLines?await options.scrapedLines.active():[];
      snapshots.record(scrapedRows(lines,at));
    };
    const first=setTimeout(()=>{void tick().catch(()=>undefined);},2*60_000);first.unref();
    const every=setInterval(()=>{void tick().catch(()=>undefined);},5*60_000);every.unref();
    const pruneNow=()=>{try{const result=snapshots.prune();console.log(`[edge-snapshots] pruned ${result.deleted} rows${result.compacted?', compacted':''}`);}
      catch(error){console.warn('[edge-snapshots] prune failed',error instanceof Error?error.message:error);}};
    const firstPrune=setTimeout(pruneNow,30_000);firstPrune.unref();
    const prune=setInterval(pruneNow,3600_000);prune.unref();
    shadowTimers.push(first,every,firstPrune,prune);
  }
  let historyCache:{at:number;board:unknown;reads:Record<string,HistoryRead>;trends?:Record<string,HistoryRead>}|null=null;
  /** A Trend in the History Read shape, flagged so the app labels it Trend. */
  const trendRead=(trend:Trend):HistoryRead=>({direction:trend.side,score:Math.round(trend.rate*100),over:0,under:0,games:trend.graded,
    average:0,books:null,text:trend.text,source:'CrownIQ’s graded lines',trend:true});
  let historyRefresh:Promise<Record<string,HistoryRead>>|null=null;
  /** The board's History Reads: the last ones at once while a fresh set builds (the first build is waited for). */
  async function boardHistoryReads(board:BoardResponse):Promise<Record<string,HistoryRead>>{
    const time=now().getTime();
    if(historyCache&&historyCache.board===board&&time-historyCache.at<10*60_000)return historyCache.reads;
    historyRefresh??=buildHistoryReads(board).finally(()=>{historyRefresh=null;});
    return historyCache?historyCache.reads:historyRefresh;
  }
  async function buildHistoryReads(board:BoardResponse):Promise<Record<string,HistoryRead>>{
    const time=now().getTime();
    const analyses=new Map(board.analyses.map((item)=>[item.lineId,item]));
    const lines=board.board.lines.filter((line)=>{const analysis=analyses.get(line.id);
      return !analysis||analysis.direction==='PASS'||analysis.score===null;});
    const fair=await fairMoreFor().catch(()=>new Map<string,number>());
    const reads=Object.fromEntries(await historyReads.readsFor(lines,(id)=>fair.get(id)??null));
    // Trends from CrownIQ's own graded lines, where no read picks a side (shown labeled Trend, graded separately).
    const trends:Record<string,HistoryRead>={};
    if(options.baseRates)for(const line of lines){
      const read=reads[line.id];
      if(read&&read.direction!=='PASS'||Date.parse(line.eventStartTime)<=time)continue;
      const trend=await options.baseRates.trendFor(line);
      if(trend)trends[line.id]=trendRead(trend);
    }
    historyCache={at:time,board,reads,trends};
    // Why GKR passes: reason codes, and the score spread of lines it did score, by sport.
    const why:Record<string,number>={},scored:Record<string,number>={};
    const missing:Record<string,number>={},evidenceKinds=new Map(service.getEvidence().map((item)=>[item.id,item.kind]));
    for(const analysis of board.analyses){
      const line=board.board.lines.find((item)=>item.id===analysis.lineId);
      const sport=line?.sport??'?';
      if(analysis.score!==null){const bucket=analysis.score>=80?'80+':analysis.score>=74?'74-79':analysis.score>=68?'68-73':'<68';
        scored[`${sport} ${bucket}`]=(scored[`${sport} ${bucket}`]??0)+1;}
      else why[`${sport} ${analysis.reasonCode??'NONE'}`]=(why[`${sport} ${analysis.reasonCode??'NONE'}`]??0)+1;
      // Missing evidence: is it the projection (research never reached the player) or a status (lineup, injury report)?
      if(analysis.reasonCode==='STALE_OR_MISSING_EVIDENCE'&&line){
        const kinds=analysis.evidenceIds.map((id)=>evidenceKinds.get(id)).filter(Boolean) as string[];
        const projection=kinds.includes(line.market.includes('fantasy')?'fantasy_scenarios':'projection:'+line.market);
        const key=`${sport} ${projection?'has projection, waiting on status':'no projection'}`;missing[key]=(missing[key]??0)+1;
      }
    }
    console.log(`[gkr-coverage] ${board.analyses.length} analyses | scored ${JSON.stringify(scored)} | unscored ${JSON.stringify(Object.entries(why).sort((a,b)=>b[1]-a[1]).slice(0,40))} | missing evidence ${JSON.stringify(Object.entries(missing).sort((a,b)=>b[1]-a[1]))}`);
    const plays=Object.values(reads).filter((read)=>read.direction!=='PASS'&&!read.lean).length;
    const leans=Object.values(reads).filter((read)=>read.lean).length;
    const bySport:Record<string,[number,number,number]>={};
    for(const line of lines){const entry=bySport[`${line.sport}`]??=[0,0,0];entry[0]++;const read=reads[line.id];
      if(read){entry[1]++;if(read.direction!=='PASS')entry[2]++;}}
    const topMarkets:Record<string,number>={};
    for(const line of lines)if(!reads[line.id])topMarkets[`${line.sport}:${line.market}`]=(topMarkets[`${line.sport}:${line.market}`]??0)+1;
    console.log(`[history-reads] ${board.board.lines.length} lines, ${lines.length} without a GKR play, ${Object.keys(reads).length} reads, ${plays} plays, ${leans} leans`+
      ` | by sport [lines, reads, plays] ${JSON.stringify(bySport)} | most lines without a read ${JSON.stringify(Object.entries(topMarkets).sort((a,b)=>b[1]-a[1]).slice(0,25))}`);
    return reads;
  }
  // Which build is running, so the app can show its version (Railway sets the commit at deploy).
  app.get('/v1/version',async()=>({commit:(process.env.RAILWAY_GIT_COMMIT_SHA??process.env.CROWNIQ_COMMIT??'').slice(0,7)||null,
    startedAt:serverStartedAt}));
  // CrownIQ's own track record: each source's graded hit rate by sport and stat, and the base rates behind Trends.
  app.get('/v1/hit-rates',async()=>({sources:{...await options.shadowRecord?.hitRates()??{},...await options.aiPicks?.hitRates()??{}},
    baseRates:await options.baseRates?.status()??null}));
  if(options.baseRates){
    const rates=options.baseRates;
    const recordLines=()=>{const board=service.getBoard();if(board)void rates.record(board.board.lines).catch(()=>undefined);};
    const first=setTimeout(recordLines,60_000);first.unref();
    const every=setInterval(recordLines,15*60_000);every.unref();
    shadowTimers.push(first,every,rates.start());
  }
  app.get('/v1/history-reads',async(_request,reply)=>{
    const board=service.getBoard();
    if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
    const reads=await boardHistoryReads(board);
    const merged={...reads};
    // A Trend fills a line where the History Read has no side.
    for(const [lineId,trend] of Object.entries(historyCache?.trends??{}))
      if(!merged[lineId]||merged[lineId].direction==='PASS')merged[lineId]=trend;
    return {reads:merged};
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
  // App boards read History and Trends for every line: built in the background and served from memory (the last one at
  // once while a fresh one builds), so the boards, Crowns and Top Picks never wait on them.
  const appBoardCache=new Map<OtherApp,{at:number;value:Awaited<ReturnType<typeof buildAppBoard>>}>();
  const appBoardRefresh=new Map<OtherApp,Promise<Awaited<ReturnType<typeof buildAppBoard>>>>();
  async function cachedAppBoard(appName:OtherApp){
    const cached=appBoardCache.get(appName);
    if(cached&&now().getTime()-cached.at<2*60_000)return cached.value;
    let run=appBoardRefresh.get(appName);
    if(!run){run=buildAppBoard(appName).then((value)=>{appBoardCache.set(appName,{at:now().getTime(),value});return value;})
      .finally(()=>appBoardRefresh.delete(appName));appBoardRefresh.set(appName,run);}
    if(cached)return cached.value;
    // Nothing built yet: wait up to 8 seconds for the full board, else send the lines now (GKR and Scout, History to follow).
    const quick=new Promise<null>((resolve)=>{const timer=setTimeout(()=>resolve(null),8000);timer.unref();});
    return (await Promise.race([run,quick]))??buildAppBoard(appName,false);
  }
  const warmAppBoards=()=>{for(const appName of otherApps)void cachedAppBoard(appName).catch(()=>undefined);};
  const warmAppsFirst=setTimeout(warmAppBoards,30_000);warmAppsFirst.unref();
  const warmApps=setInterval(warmAppBoards,3*60_000);
  warmApps.unref();shadowTimers.push(warmAppsFirst,warmApps);
  app.get('/v1/apps/:app/board',async(request,reply)=>{
    const parsed=z.object({app:z.enum(otherApps as [OtherApp,...OtherApp[]])}).safeParse(request.params);
    if(!parsed.success)return reply.code(404).send({code:'UNKNOWN_APP'});
    if(!options.scrapedLines)return reply.code(503).send({code:'APP_LINES_UNAVAILABLE'});
    return cachedAppBoard(parsed.data.app);
  });
  async function buildAppBoard(appName:OtherApp,withHistory=true){
    const started=Date.now();
    const board=await appBoard(options.scrapedLines!,appName,service.getBoard());
    const scores=await scoresFor(appName);
    // Scout's read on the line, at this number, when it has one (lines GKR can't score).
    const reads=new Map((await options.aiPicks?.upcoming()??[]).map((read)=>[`${read.lineId}|${read.threshold}`,read]));
    // One History pass for every line GKR doesn't score (eight lookups at a time), not one pass per line.
    const asLines=asBoard(board.lines,board.fetchedAt??now().toISOString()).board.lines;
    const unscored=asLines.filter((line)=>!scores.has(line.id));
    const history=withHistory?await historyReads.readsFor(unscored).catch(()=>new Map<string,HistoryRead>()):new Map<string,HistoryRead>();
    const lines=await Promise.all(board.lines.map(async(line,index)=>{
      const read=reads.get(`${line.id}|${line.threshold}`), gkr=scores.get(line.id)??null;
      let found:HistoryRead|null=gkr?null:history.get(line.id)??null;
      if(withHistory&&!gkr&&!read&&(!found||found.direction==='PASS')&&options.baseRates){
        const trend=await options.baseRates.trendFor(asLines[index]!);if(trend)found=trendRead(trend);}
      return {...line,gkr,history:found,scout:read?{pick:read.pick,score:read.score,agreement:read.agreement}:null};
    }));
    if(withHistory)console.log(`[app-board] ${appName} ${lines.length} lines, ${history.size} history reads, ${Math.round((Date.now()-started)/1000)}s`);
    return {...board,gkrScored:!!options.appGkrScores,lines};
  }
  // Line shopping: every app's number for the same player and stat, the easiest number per side, and the books' line.
  let shopCache:{at:number;board:unknown;entries:ShopEntry[]}|null=null;
  async function shopEntries():Promise<ShopEntry[]>{
    const board=service.getBoard();
    if(!board)return [];
    const time=now().getTime();
    if(shopCache&&shopCache.board===board&&time-shopCache.at<2*60_000)return shopCache.entries;
    const apps=options.scrapedLines?(await Promise.all(otherApps.map(async(app)=>(await appBoard(options.scrapedLines!,app,null)).lines))).flat():[];
    const prices=options.sharpProps?(await options.sharpProps.current().catch(()=>({prices:[]}))).prices:[];
    const picks=new Map<string,ShopPick>();
    for(const analysis of board.analyses)if(analysis.direction!=='PASS'&&analysis.score!==null&&analysis.score>=80)
      picks.set(analysis.lineId,{side:analysis.direction,by:'GKR',score:Math.round(analysis.score)});
    for(const [lineId,read] of Object.entries(historyCache?.reads??{}))if(!picks.has(lineId)&&read.direction!=='PASS'&&!read.lean&&read.score!==null)
      picks.set(lineId,{side:read.direction,by:'HISTORY',score:read.score});
    const entries=lineShop(board.board.lines,apps,prices,picks,now());
    shopCache={at:time,board,entries};
    return entries;
  }
  app.get('/v1/line-shop',async(request)=>{
    const query=z.object({lineId:z.string().max(200).optional(),limit:z.coerce.number().int().min(1).max(2000).default(800)})
      .parse(request.query);
    const entries=await shopEntries();
    if(query.lineId)return {entry:entries.find((entry)=>entry.offers.some((offer)=>offer.lineId===query.lineId))??null};
    return {count:entries.length,entries:entries.slice(0,query.limit)};
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
  // Book picks read History for every prop the book prices, which is slow the first time: the last set is served at once
  // while a fresh one builds (the very first build is waited for), and they're kept warm in the background.
  const bookRefresh=new Map<Sportsbook,Promise<Awaited<ReturnType<typeof buildBookPicks>>>>();
  async function picksFor(book:Sportsbook){
    const board=service.getBoard();
    if(!options.appGkrScores||!options.sharpProps||!board)return null;
    const {prices}=await options.sharpProps.current();
    const now=(options.clock??(()=>new Date()))(),key=[board,service.getEvidence(),prices];
    const cached=bookPickCache.get(book);
    if(cached&&now.getTime()-cached.at<2*60_000&&key.every((item,index)=>cached.key[index]===item))return cached;
    let run=bookRefresh.get(book);
    if(!run){run=buildBookPicks(book).finally(()=>bookRefresh.delete(book));bookRefresh.set(book,run);}
    return cached??run;
  }
  async function buildBookPicks(book:Sportsbook){
    const board=service.getBoard();
    if(!board||!options.sharpProps)return null;
    const {fetchedAt,prices}=await options.sharpProps.current();
    const now=(options.clock??(()=>new Date()))(),key=[board,service.getEvidence(),prices];
    const lines=new Map<string,PropLine>();
    // The same History Reads every tab uses, at the book's own number (blended with the book's no-vig chance).
    // Over-only props (DraftKings' soccer shots, no under) join too: History can read them though no fair chance exists.
    const overOnly=(await options.sharpProps.extras().catch(()=>({overOnly:[]}))).overOnly.filter((offer)=>offer.book===book);
    const candidates=bookLines(book,prices,board.board.lines,now,overOnly);
    const fairOver=new Map(candidates.flatMap((item)=>Number.isNaN(item.price.fairOver)?[]:[[item.line.id,item.price.fairOver] as const]));
    const reads=await historyReads.readsFor(candidates.map((item)=>item.line),(id)=>fairOver.get(id)??null).catch(()=>new Map<string,HistoryRead>());
    const history=new Map<string,BookFallback>();
    for(const [lineId,read] of reads)if(read.direction!=='PASS'&&!read.lean&&read.score!==null)
      history.set(lineId,{side:read.direction,score:read.score,note:`History: ${read.text} (${read.source})`});
    const picks=bookPicks(book,prices,board.board.lines,new Map(board.analyses.map((item)=>[item.lineId,item])),
      (items)=>service.scoreLines(items),now,undefined,lines,history,overOnly);
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
    return {gkr:status.gkr,beta:status.beta,betaPass:status['beta-pass'],history:status.history};
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
    const feedNote=await options.sharpProps?.status().then((status)=>bookFeedNote(status,parsed.data.book,sportsbookNames[parsed.data.book])).catch(()=>null);
    return {book:parsed.data.book,name:sportsbookNames[parsed.data.book],fetchedAt:result.fetchedAt,picks,
      ...(feedNote?{feedNote}:{})};
  });
  // Keep the book picks warm so the tabs open fast.
  const warmPicks=()=>{for(const book of sportsbooks)void picksFor(book).catch(()=>undefined);};
  const warmFirst=setTimeout(warmPicks,45_000);warmFirst.unref();
  const warmEvery=setInterval(warmPicks,3*60_000);warmEvery.unref();
  shadowTimers.push(warmFirst,warmEvery);
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
    const line=service.getBoard()?.board.lines.find((item)=>item.playerId===parsed.data.playerId&&
      item.sport===parsed.data.sport);
    const log=options.internalHistory?await options.internalHistory.gameLog(parsed.data.sport,parsed.data.playerId,
      line?.playerName??null,parsed.data.market,now()):null;
    if(log&&log.games.length)return log;
    // Tennis and esports: the last matches from free public history.
    const free=line&&options.playerHistory?.supports(parsed.data.sport)
      ?await options.playerHistory.gameLog(parsed.data.sport,parsed.data.playerId,line.playerName,parsed.data.market).catch(()=>null):null;
    if(free&&free.games.length)return free;
    // College football, NHL, soccer and WNBA: the ESPN game logs GKR and History Read already read (the page showed
    // "no games" for players GKR had 15 games on).
    const espn=line&&options.espnHistory?.recentGames?await options.espnHistory.recentGames({eventId:line.eventId,eventName:line.eventName,
      eventStartTime:line.eventStartTime,league:line.league,playerId:line.playerId,playerName:line.playerName,team:line.team,
      opponent:line.opponent,homeTeam:line.homeTeam??null,awayTeam:line.awayTeam??null,market:parsed.data.market,sport:line.sport,
      sourceSportKey:line.sourceSportKey??null}).catch(()=>null):null;
    return espn&&espn.length?{sport:line!.sport,playerId:parsed.data.playerId,playerName:line!.playerName,market:parsed.data.market,
      source:'FREE_PUBLIC_HISTORY',unit:null,games:espn}:reply.code(404).send({code:'NO_HISTORY'});
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
      return {playerHistory:await options.internalHistory?.status()??null,freeHistory:options.playerHistory?.lastRefresh??null,
        trackedDecisions:(await options.product?.listDecisions(0,1))?.total??null,
        activeAppLines:lines.length,booksHistoryRows,
        shadow:await options.shadowRecord?.status()??null,
        archive:await options.historyArchive?.status()??null};
    });
    admin.get('/members', async (_request, reply) => options.product ? options.product.membership()
      : reply.code(503).send({ code: 'PRODUCT_UNCONFIGURED' }));
    admin.get('/shadow', async (_request, reply) => options.shadowRecord ? options.shadowRecord.status()
      : reply.code(503).send({ code: 'SHADOW_UNCONFIGURED' }));
    admin.post('/shadow/record', async (_request, reply) => options.shadowRecord ? (await recordShadow()) ?? { found: {}, added: 0 }
      : reply.code(503).send({ code: 'SHADOW_UNCONFIGURED' }));
    admin.post('/shadow/grade', async (_request, reply) => options.shadowRecord ? { graded: await options.shadowRecord.grade() }
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
    admin.get('/feedback', async (_request, reply) => options.feedback
      ? { items: await options.feedback.all(), summary: await options.feedback.summary() }
      : reply.code(503).send({ code: 'FEEDBACK_UNAVAILABLE' }));
    admin.post('/feedback/:id', async (request, reply) => {
      if (!options.feedback) return reply.code(503).send({ code: 'FEEDBACK_UNAVAILABLE' });
      const id = z.string().uuid().safeParse((request.params as { id?: string }).id), input = reviewInput.safeParse(request.body);
      if (!id.success || !input.success) return reply.code(400).send({ code: 'REVIEW_INVALID' });
      try { return await options.feedback.review(id.data, input.data.status, input.data.reply ?? null); }
      catch { return reply.code(404).send({ code: 'FEEDBACK_NOT_FOUND' }); }
    });
    admin.post('/updates', async (request, reply) => {
      if (!options.feedback) return reply.code(503).send({ code: 'FEEDBACK_UNAVAILABLE' });
      const input = updateInput.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ code: 'UPDATE_INVALID' });
      return reply.code(201).send(await options.feedback.postUpdate(input.data.title, input.data.body, input.data.feedbackIds));
    });
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
      const parsed=z.object({id:z.enum(['injuries','pinnacle'])}).safeParse(request.params);
      if(!parsed.success||!options.contextFeeds)return reply.code(404).send({code:'UNKNOWN_FEED'});
      return options.contextFeeds.items(parsed.data.id);
    });
    // Pulls one context feed now; it spends from the shared daily scraper budget.
    admin.post('/context/pull', async (request, reply) => {
      if (!options.contextFeeds) return reply.code(503).send({ code: 'CONTEXT_FEEDS_UNCONFIGURED' });
      if (request.headers['x-confirm-provider-cost'] !== 'yes') return reply.code(428).send({ code: 'COST_CONFIRMATION_REQUIRED' });
      const input = z.object({ source: z.enum(['injuries', 'pinnacle']) }).safeParse(request.body);
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
    admin.post('/edge/results',async(request,reply)=>{
      if(!options.edge?.ledger)return reply.code(503).send({code:'EDGE_TRACKING_UNCONFIGURED'});
      const parsed=z.object({results:z.array(resultFactSchema).min(1).max(1000)}).strict().safeParse(request.body);
      if(!parsed.success)return reply.code(400).send({code:'INVALID_RESULTS'});
      return options.edge.ledger.grade(parsed.data.results);
    });
    // Step 7: the last 7 days of stale alerts replayed against the closing line.
    admin.get('/edge/stale',async(_request,reply)=>edge?edge.staleReplay(7):reply.code(503).send({code:'EDGE_UNAVAILABLE'}));
    // The data volume's largest files (it is small: a full volume fails every save, tips included).
    // The Board tab's own check (the app's board schema) on what /v1/board/lite serves now: any line that would fail it.
    admin.get('/board-check',async(_request,reply)=>{
      const snapshot=service.getBoard();if(!snapshot)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
      const lite=liteBoard(snapshot,now());
      const result=boardResponseSchema.safeParse(JSON.parse(JSON.stringify(lite)));
      const body=JSON.stringify(lite);
      return {ok:result.success,bytes:body.length,gzipBytes:gzipSync(body,{level:5}).length,lines:lite.board.lines.length,analyses:lite.analyses.length,
        issues:result.success?[]:result.error.issues.slice(0,10).map((issue)=>({path:issue.path.join('.'),message:issue.message}))};
    });
    admin.get('/disk',async()=>{
      const root=(process.env.CROWNIQ_DATA_DIR??'tmp').replace(/\/$/,'');
      const files=await readdir(root,{recursive:true}).catch(()=>[] as string[]);
      const sized=(await Promise.all(files.map(async(name)=>{const info=await stat(`${root}/${name}`).catch(()=>null);
        return info?.isFile()?{name,mb:Math.round(info.size/1e4)/100}:null;}))).filter((item)=>item!==null);
      sized.sort((a,b)=>b.mb-a.mb);
      return {root,files:sized.length,totalMb:Math.round(sized.reduce((sum,item)=>sum+item.mb,0)),largest:sized.slice(0,40)};
    });
    // SharpAPI: the feed's status and one probe request per book (why a book's rows stopped coming).
    admin.get('/sharp',async(_request,reply)=>options.sharpProps?{status:await options.sharpProps.status(),
      probe:await options.sharpProps.probeBooks(['hardrock','draftkings','fanduel','betmgm','betrivers','prizepicks'])}
      :reply.code(503).send({code:'SHARPAPI_UNCONFIGURED'}));
    admin.get('/edge/side-bias',async(_request,reply)=>edge?edge.sideBias():reply.code(503).send({code:'EDGE_UNAVAILABLE'}));
    admin.get('/edge/status',async(_request,reply)=>edge?{status:edge.status(),grading:edgeWorker?.status()??null,
      snapshots:options.edge?.snapshots?.status()??null}:reply.code(503).send({code:'EDGE_DISABLED'}));
    admin.post('/tracked-results',async(request,reply)=>{
      if(!options.product)return reply.code(503).send({code:'TRACKING_UNCONFIGURED'});
      const parsed=z.object({results:z.array(resultFactSchema).min(1).max(1000)}).strict().safeParse(request.body);
      if(!parsed.success)return reply.code(400).send({code:'INVALID_RESULTS'});
      await options.edge?.ledger?.grade(parsed.data.results).catch(()=>undefined);
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
