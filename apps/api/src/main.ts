import { BaseRates } from './base-rates.js';
import { StatApiContextResearch } from './stat-api-context.js';
import { FreeHistoryEvidence } from './free-history-evidence.js';
import { EspnTennisHistory, LeaguepediaHistory, OpenDotaHistory, PlayerHistory, SleeperHistory } from './player-history.js';
import { FeedbackStore } from './feedback.js';
import { ClaudeTipReader } from './claude-tips.js';
import { TipGrader, TipStore } from './tips.js';
import 'dotenv/config';
import { mergePayouts } from '@crowniq/contracts';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CompositeResearchAdapter, conservativeCorrelationPolicy, createGkrRegistry, lessAwareVersion, marketDefinitions,
  statHistoryReadyVersions, statHistoryV2Versions, statHistoryV3Versions } from '@crowniq/engine';
import type { OddsProvider } from '@crowniq/engine';
import { buildServer } from './server.js';
import { FullPrizePicksProvider } from './full-prizepicks-provider.js';
import { TheOddsApiProvider } from './the-odds-api-provider.js';
import { probeOddsApiOnce } from './edge/odds-api-probe.js';
import { EdgeLedger } from './edge/ledger.js';
import { SnapshotStore } from './edge/snapshots.js';
import { BookWeightStore } from './edge/book-weights.js';
import { DispersionStore } from './edge/dispersion-store.js';
import { NflPassingFileResearch } from './nfl-evidence-file.js';
import { JsonSelectionLedger } from './selection-ledger.js';
import { CombinedWebResearch, WebResearchAdapter, WebResearchCatalog } from './web-research.js';
import { SharpPropsFeed } from './context/sharp-props.js';
import { SlotLedger } from './scrapers/slot-ledger.js';
import { ContextFeeds, injuryReports, pinnacleLines } from './context/feeds.js';
import { ClaudeWebResearchAdapter } from './claude-web-research.js';
import { ProductLedger } from './product-ledger.js';
import { ProductGradingWorker } from './background-grading.js';
import { BoxScoreResults } from './box-score-results.js';
import { EspnGkrEvidence } from './espn-gkr-evidence.js';
import { AiPickService } from './ai-picks.js';
import { ShadowRecord } from './shadow-record.js';
import { HistoryArchive } from './history-archive.js';
import { ClaudePickResearcher } from './claude-ai-picks.js';
import { OpenAiPickResearcher } from './openai-ai-picks.js';
import { BoardCache } from './board-cache.js';
import { ApifyClient } from './scrapers/apify-client.js';
import { ScrapedLineStore } from './scrapers/line-store.js';
import { ScrapedPrizePicksProvider } from './scrapers/scraped-prizepicks-provider.js';
import { lergassy } from './scrapers/lergassy.js';
import { oddsApiSource } from './scrapers/odds-api-source.js';
import { ScraperPuller } from './scrapers/scraper-puller.js';
import { zenPrizePicks, zenUnderdog, zenPick6 } from './scrapers/zen-studio.js';
import { DailySpendBudget } from './scrapers/spend-budget.js';
import { DailyLookupBudget } from './context-refresh.js';
import { OwnerPullJobStore } from './owner-pull-job.js';
import { ProviderIdentityVerifier } from './provider-identity.js';
import { StatApiOwnerResearch } from './stat-api-owner-research.js';
import { StatApiGkrEvidence } from './stat-api-gkr-evidence.js';
import { PublicNflGkrEvidence } from './public-nfl-gkr-evidence.js';
import { OwnerResearchNotebook } from './owner-research-notebook.js';
import { HistoryBackfillService, InternalHistoryResearch, InternalHistoryStore } from './internal-history.js';
import { EspnRosterIdentitySource } from './identity/espn-rosters.js';
import { PlayerIdentityResearch } from './identity/player-identity.js';
import { SleeperNflIdentitySource } from './identity/sleeper-nfl.js';
import { JsonCache } from './identity/types.js';
import { CurrentContextResearch } from './current-context.js';

// Where the server keeps its data files. On a host, point this at a permanent disk.
const dataDir=(process.env.CROWNIQ_DATA_DIR ?? 'tmp').replace(/\/$/,'');
// CrownIQ's own archive: every game log, graded result and line it has seen, kept for verification and evidence.
const historyArchive=new HistoryArchive(`${dataDir}/archive`);
const apiKey = process.env.THE_ODDS_API_KEY;
const providerMode = process.env.ODDS_PROVIDER ?? 'auto';
if (!['auto', 'none', 'the_odds_api', 'scrapers'].includes(providerMode)) {
  throw new Error('Unknown ODDS_PROVIDER');
}
const providerName = providerMode === 'auto'
  ? apiKey ? 'the_odds_api' : 'none'
  : providerMode;
const scope = process.env.THE_ODDS_API_SCOPE ?? 'full';
if (scope !== 'full' && scope !== 'nfl_passing_yards') throw new Error('Unknown THE_ODDS_API_SCOPE');
const maxEvents = process.env.THE_ODDS_API_MAX_EVENTS
  ? Number(process.env.THE_ODDS_API_MAX_EVENTS) : undefined;
const maxCreditsPerRefresh = process.env.THE_ODDS_API_MAX_CREDITS_PER_REFRESH
  ? Number(process.env.THE_ODDS_API_MAX_CREDITS_PER_REFRESH) : undefined;
// Lines from the Apify scrapers instead of The Odds API: pulls run on their own schedule and spend cap,
// and the board reads the stored lines for free.
const nonNegativeNumber=(name:string,fallback:number)=>{
  const value=Number(process.env[name]??fallback);
  if(!Number.isFinite(value)||value<0)throw new Error(`Invalid ${name}`);
  return value;
};
const scrapedLines=providerName==='scrapers'
  ? new ScrapedLineStore(process.env.CROWNIQ_SCRAPED_LINES_FILE ?? `${dataDir}/scraped-lines.json`,undefined,historyArchive):null;
// Each source on its own Eastern-time schedule ("" turns one off), under one shared daily cap.
const hoursEt=(name:string,fallback:string)=>(process.env[name] ?? fallback).split(',').map((hour)=>hour.trim())
  .filter(Boolean).map(Number).filter((hour)=>Number.isInteger(hour)&&hour>=0&&hour<=23);
// One Apify client and one daily cap shared by the line scrapers and the display-only context feeds.
const apify=new ApifyClient(process.env.APIFY_TOKEN?.trim()||null);
// Scheduled slots already run today, saved so a restart or an overlapping deployment never repeats a paid pull.
const scraperSlots=new SlotLedger(process.env.CROWNIQ_SCRAPER_SLOTS_FILE ?? `${dataDir}/scraper-slots.json`);
const scraperBudget=new DailySpendBudget(process.env.CROWNIQ_SCRAPER_SPEND_FILE ?? `${dataDir}/scraper-spend.json`,
  nonNegativeNumber('CROWNIQ_SCRAPER_DAILY_USD',25),()=>new Date(),
  // Apify's own charges since midnight Eastern, so runs started anywhere count against the cap.
  process.env.APIFY_TOKEN?.trim()?(since)=>apify.spentSince(since):null);
// Player history for tennis and esports: free public sources (ESPN, OpenDota, Leaguepedia) plus Sleeper's recent
// performance (CS2, tennis; about a cent a run on Apify, twice a day, under the scraper cap). Scout facts, card game logs
// and the archive; no GKR score uses it.
const sleeperRunner={async run(){
  if(await scraperBudget.remaining()<0.5)return null;
  const run=await apify.runActor('solidcode/sleeper-player-props-scraper',{leagues:['cs','tennis'],maxResults:3000},
    {maxChargeUsd:0.5,timeoutSecs:600});
  await scraperBudget.record(run.usageUsd);
  return run.status==='SUCCEEDED'?await apify.datasetItems(run.datasetId):null;
}};
const playerHistory=process.env.CROWNIQ_FREE_HISTORY==='false'?null
  :new PlayerHistory([new EspnTennisHistory(),
    new SleeperHistory(process.env.CROWNIQ_SLEEPER_HISTORY==='false'?null:sleeperRunner,`${dataDir}/sleeper-history.json`),
    // Slow first load (one request a second), so last.
    new OpenDotaHistory(),new LeaguepediaHistory()],historyArchive);
playerHistory?.start();
const scraperPuller=scrapedLines?new ScraperPuller(apify,scrapedLines,scraperBudget,
  [{source:zenPrizePicks,hoursEt:hoursEt('CROWNIQ_SCRAPER_HOURS_ZEN_PRIZEPICKS','9,12,15,18')},
    {source:lergassy,hoursEt:hoursEt('CROWNIQ_SCRAPER_HOURS_LERGASSY','12')},
    {source:zenUnderdog,hoursEt:hoursEt('CROWNIQ_SCRAPER_HOURS_ZEN_UNDERDOG','9,12,15,18')},
    {source:zenPick6,hoursEt:hoursEt('CROWNIQ_SCRAPER_HOURS_ZEN_PICK6','9,12,15,18')},
    // The Odds API alongside the scrapers as a third check. It spends Odds API credits, so by default
    // it runs only when the owner pulls (CROWNIQ_SCRAPER_HOURS_ODDS_API adds a schedule).
    ...(apiKey?[{source:oddsApiSource(new FullPrizePicksProvider({apiKey,maxEvents,maxCreditsPerRefresh})),
      hoursEt:hoursEt('CROWNIQ_SCRAPER_HOURS_ODDS_API','')}]:[])],
  {maxRunUsd:nonNegativeNumber('CROWNIQ_SCRAPER_MAX_RUN_USD',5),slots:scraperSlots}):null;
// Display-only game context (never scored): injuries and Pinnacle game lines.
const contextFeeds=process.env.APIFY_TOKEN?.trim()?new ContextFeeds(apify,scraperBudget,[
  {source:injuryReports,hoursEt:hoursEt('CROWNIQ_CONTEXT_HOURS_INJURIES','8,11,14,17')},
  {source:pinnacleLines,hoursEt:hoursEt('CROWNIQ_CONTEXT_HOURS_PINNACLE','9,15')}],
process.env.CROWNIQ_CONTEXT_FEEDS_FILE ?? `${dataDir}/context-feeds.json`,undefined,scraperSlots):null;
// DraftKings, Hard Rock, FanDuel and BetRivers prop prices from SharpAPI (reference odds, +EV and Edge), refreshed hourly.
// The owner's Railway variable is named `sharp_api`; SHARPAPI_KEY also works.
// Books per request: ones the plan hasn't selected are skipped (the Hobby plan selects 5). PrizePicks and PrizePicks Flex
// list the same lines (only the payout price differs), so whichever the owner selects feeds Edge as lines, never a price.
// CROWNIQ_SHARP_BOOKS overrides the list.
const sharpProps=new SharpPropsFeed((process.env.SHARPAPI_KEY ?? process.env.sharp_api)?.trim()||null,
  process.env.CROWNIQ_SHARP_PROPS_FILE ?? `${dataDir}/sharp-props.json`,
  {books:(process.env.CROWNIQ_SHARP_BOOKS??'draftkings,hardrock,fanduel,betrivers,prizepicks,prizepicks_flex').split(',').map((book)=>book.trim()).filter(Boolean),
    maxPagesPerLeague:100});
// A bad CROWNIQ_PAYOUTS falls back to the defaults rather than stopping the server.
const payouts=mergePayouts((()=>{try{return JSON.parse(process.env.CROWNIQ_PAYOUTS??'null');}catch{return null;}})());
const evBreakEven=process.env.CROWNIQ_EV_BREAK_EVEN?Number(process.env.CROWNIQ_EV_BREAK_EVEN):undefined;
const provider: OddsProvider | null = scrapedLines ? new ScrapedPrizePicksProvider(scrapedLines)
  : providerName !== 'the_odds_api' || !apiKey ? null
  : scope === 'nfl_passing_yards'
    ? new TheOddsApiProvider({ apiKey,
      marketKeys: process.env.THE_ODDS_API_MARKETS?.split(',').map((item) => item.trim()),
      maxEvents, maxCreditsPerRefresh })
    : new FullPrizePicksProvider({ apiKey, maxEvents, maxCreditsPerRefresh });
if (providerName === 'the_odds_api' && !provider) {
  console.warn('The Odds API is selected but THE_ODDS_API_KEY is not set in this server runtime.');
}
// Web research providers: ChatGPT (OPENAI_API_KEY) and Claude (ANTHROPIC_API_KEY). `auto` runs every provider that
// has a key, side by side; findings stay display-only.
const researchProvider = process.env.RESEARCH_PROVIDER ?? 'auto';
if (!['auto', 'none', 'openai_web', 'claude_web', 'both'].includes(researchProvider)) {
  throw new Error('Unknown RESEARCH_PROVIDER');
}
const researchBudget = { maxSearches: process.env.WEB_RESEARCH_MAX_SEARCHES
  ? Number(process.env.WEB_RESEARCH_MAX_SEARCHES) : undefined,
concurrency: process.env.WEB_RESEARCH_CONCURRENCY ? Number(process.env.WEB_RESEARCH_CONCURRENCY) : undefined };
const webKey = process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY;
const claudeKey = process.env.ANTHROPIC_API_KEY;
const wantsOpenAi = ['auto', 'openai_web', 'both'].includes(researchProvider);
const wantsClaude = ['auto', 'claude_web', 'both'].includes(researchProvider);
const openAiResearch = wantsOpenAi && webKey
  ? new WebResearchAdapter({ apiKey: webKey, ...researchBudget,
    model: process.env.WEB_RESEARCH_MODEL ?? 'gpt-5.4-mini',
    catalog: new WebResearchCatalog(process.env.CROWNIQ_RESEARCH_CATALOG_FILE ??
      `${dataDir}/research-catalog.json`) }) : null;
const claudeResearch = wantsClaude && claudeKey
  ? new ClaudeWebResearchAdapter({ apiKey: claudeKey, ...researchBudget,
    model: process.env.CLAUDE_RESEARCH_MODEL ?? 'claude-opus-5-5',
    catalog: new WebResearchCatalog(process.env.CROWNIQ_CLAUDE_RESEARCH_CATALOG_FILE ??
      `${dataDir}/research-catalog-claude.json`) }) : null;
const researchProviders = [openAiResearch, claudeResearch].filter((item) => item !== null);
// AI reads (owner approved 2026-10-04): ChatGPT and Claude give MORE/LESS/PASS on lines GKR can't score, as their own
// labeled score. CROWNIQ_AI_PICKS=false turns it off; the daily caps bound what it spends.
const aiPickers = process.env.CROWNIQ_AI_PICKS === 'false' ? [] : [
  ...(webKey ? [new OpenAiPickResearcher(webKey, process.env.WEB_RESEARCH_MODEL ?? 'gpt-5.4-mini')] : []),
  ...(claudeKey ? [new ClaudePickResearcher({ apiKey: claudeKey, model: process.env.CLAUDE_RESEARCH_MODEL ?? 'claude-opus-5-5' })] : []),
];
const webResearch = researchProviders.length > 1 ? new CombinedWebResearch(researchProviders)
  : researchProviders[0] ?? null;
if (['openai_web', 'both'].includes(researchProvider) && !openAiResearch) {
  console.warn('ChatGPT web research selected but OPENAI_API_KEY is absent from this server runtime.');
}
if (['claude_web', 'both'].includes(researchProvider) && !claudeResearch) {
  console.warn('Claude web research selected but ANTHROPIC_API_KEY is absent from this server runtime.');
}
const band=process.env.CROWNIQ_AUTO_TRACK_MIN_BAND ?? 'PLAYABLE';
if(band!=='CROWN_STRONG' && band!=='PLAYABLE')throw new Error('Invalid CROWNIQ_AUTO_TRACK_MIN_BAND');
const modelPreset=process.env.GKR_MODEL_PRESET??'custom';
// stat_history_v2 = v1 plus every other Stat API stat the board offers (owner approved 2026-10-04).
if(!['custom','stat_history_v1','stat_history_v2'].includes(modelPreset))throw new Error('Invalid GKR_MODEL_PRESET');
const configuredModelVersions=(process.env.GKR_APPROVED_MODEL_VERSIONS??'')
  .split(',').map((version)=>version.trim()).filter(Boolean);
const approvedModelVersions=[...new Set(modelPreset==='stat_history_v2'
  ? [...configuredModelVersions,...statHistoryReadyVersions,...statHistoryV2Versions,
    // Stat-history set 3, CS2 and tennis from player history (owner approved 2026-10-05); GKR_SH3=false leaves it out.
    ...(process.env.GKR_SH3==='false'?[]:statHistoryV3Versions)]
  : modelPreset==='stat_history_v1' ? [...configuredModelVersions,...statHistoryReadyVersions]
    : configuredModelVersions)];
const models=createGkrRegistry(approvedModelVersions);
const knownModelVersions=new Set(marketDefinitions.flatMap((definition)=>
  [definition.version,lessAwareVersion(definition.version)]));
const unknownModelVersions=configuredModelVersions.filter((version)=>!knownModelVersions.has(version));
if(unknownModelVersions.length)console.warn('GKR_APPROVED_MODEL_VERSIONS lists unknown versions: '+unknownModelVersions.join(', '));
const approvedModelKeys=Object.entries(models.requirements())
  .filter(([,requirement])=>requirement.approved).map(([key])=>key);
const internalHistory=new InternalHistoryStore(process.env.CROWNIQ_INTERNAL_HISTORY_FILE ??
  `${dataDir}/internal-history.json`);
// Crown saves and shares need a correlation policy; 'none' keeps them fail-closed.
const correlationSetting=process.env.CROWNIQ_CROWN_CORRELATION_POLICY ?? 'conservative';
if(!['conservative','none'].includes(correlationSetting))throw new Error('Invalid CROWNIQ_CROWN_CORRELATION_POLICY');
const socialMaxSnapshotMinutes=Number(process.env.CROWNIQ_SOCIAL_MAX_SNAPSHOT_MINUTES ?? 0);
if(!Number.isFinite(socialMaxSnapshotMinutes)||socialMaxSnapshotMinutes<0)
  throw new Error('Invalid CROWNIQ_SOCIAL_MAX_SNAPSHOT_MINUTES');
const product=new ProductLedger(process.env.CROWNIQ_PRODUCT_LEDGER_FILE ??
  `${dataDir}/product-ledger.json`,band,()=>new Date(),
  correlationSetting==='conservative'?conservativeCorrelationPolicy:undefined,internalHistory,
  socialMaxSnapshotMinutes,Number(process.env.CROWNIQ_MAX_MEMBERS ?? 100),process.env.CROWNIQ_FAMILY_CODE?.trim()||null,
  // Sign-up is closed unless the code unlocks it (owner, 2026-10-05); CROWNIQ_SIGNUP_OPEN=true opens it to anyone.
  process.env.CROWNIQ_SIGNUP_OPEN==='true');
const statApiKey=process.env.STAT_API_KEY;
const ownerPublicId=process.env.CROWNIQ_OWNER_PUBLIC_ID;
const statDailyLimit=process.env.CROWNIQ_STAT_API_DAILY_RECORD_LIMIT
  ? Number(process.env.CROWNIQ_STAT_API_DAILY_RECORD_LIMIT):100_000;
const statSource=statApiKey ? new StatApiOwnerResearch(statApiKey,fetch,()=>new Date(),statDailyLimit,
  `${dataDir}/stat-api-usage.json`):null;
const ownerResearch=statSource && ownerPublicId ? statSource:null;
const historyBackfill=statSource?new HistoryBackfillService(statSource,internalHistory):null;
const ownerNotebook=ownerResearch ? new OwnerResearchNotebook(
  process.env.CROWNIQ_OWNER_RESEARCH_FILE??`${dataDir}/owner-stat-research.json`,ownerResearch,
  process.env.CROWNIQ_OWNER_RESEARCH_REFRESH_MINUTES
    ? Number(process.env.CROWNIQ_OWNER_RESEARCH_REFRESH_MINUTES):60):null;
if(statApiKey && !ownerPublicId)console.warn('STAT_API_KEY is set, but CROWNIQ_OWNER_PUBLIC_ID is missing. Private research is inaccessible.');
const statEvidenceEnabled=process.env.GKR_STAT_EVIDENCE==='true';
if(statEvidenceEnabled && !statSource)console.warn('GKR_STAT_EVIDENCE=true but STAT_API_KEY is missing.');
const statEvidence=statEvidenceEnabled && statSource ? new StatApiGkrEvidence(statSource,{
  maxPlayers:process.env.GKR_STAT_EVIDENCE_MAX_PLAYERS
    ? Number(process.env.GKR_STAT_EVIDENCE_MAX_PLAYERS):undefined,
  concurrency:process.env.GKR_STAT_EVIDENCE_CONCURRENCY
    ? Number(process.env.GKR_STAT_EVIDENCE_CONCURRENCY):undefined,
  allowedKeys:approvedModelKeys,
  skipTarget:async(target)=>internalHistory.hasModelReadyEvidence(target,5,10,.6),
  onDetail:async({target,player,detail})=>{await internalHistory.recordStatDetail(target,player,detail);},
}):null;
const currentContextEnabled=process.env.GKR_CURRENT_CONTEXT!=='false';
const currentContext=currentContextEnabled?new CurrentContextResearch({
  allowedKeys:approvedModelKeys,
  statSource:statSource??undefined,
}):null;
if(currentContextEnabled && approvedModelKeys.some((key)=>key.startsWith('NBA:')) && !statSource) {
  console.warn('NBA fresh availability is unconfigured; STAT_API_KEY is required for current NBA status.');
}
const manualEvidence=process.env.NFL_PASSING_EVIDENCE_FILE
  ? new NflPassingFileResearch(process.env.NFL_PASSING_EVIDENCE_FILE):null;
const publicNflEvidence=process.env.GKR_PUBLIC_NFL_EVIDENCE==='false'
  ? null:new PublicNflGkrEvidence();
const internalEvidence=new InternalHistoryResearch(internalHistory);
// Team and headshot for every player, every sport a source covers; identity only, never scored.
// List new identity APIs or scrapers here, most trusted first: each player tries them in order.
const identityCache=new JsonCache(fetch,()=>new Date());
const identitySources=[new SleeperNflIdentitySource(identityCache),new EspnRosterIdentitySource(identityCache)];
const playerIdentity=process.env.GKR_PLAYER_IDENTITY==='false'?null
  :new PlayerIdentityResearch(identitySources,{cache:identityCache});
const primaryEvidenceAdapters=[manualEvidence,internalEvidence,publicNflEvidence,playerIdentity]
  .filter((item):item is NonNullable<typeof item>=>!!item);
const gkrResearch=primaryEvidenceAdapters.length===0?null:primaryEvidenceAdapters.length===1
  ? primaryEvidenceAdapters[0]:new CompositeResearchAdapter(primaryEvidenceAdapters);
// NHL, soccer and college football history from ESPN's public game logs (free), for their approved models.
const espnEvidence=process.env.GKR_ESPN_EVIDENCE==='false'?null:new EspnGkrEvidence(fetch,{allowedKeys:approvedModelKeys,archive:historyArchive,
  maxPlayers:process.env.GKR_ESPN_MAX_PLAYERS?Number(process.env.GKR_ESPN_MAX_PLAYERS):undefined});
const freeHistoryEvidence=playerHistory?new FreeHistoryEvidence(playerHistory,approvedModelKeys):null;
const secondLookAdapters=[statEvidence,currentContext,espnEvidence,freeHistoryEvidence]
  .filter((item):item is NonNullable<typeof item>=>!!item);
const secondLookResearch=secondLookAdapters.length===0?null:secondLookAdapters.length===1
  ? secondLookAdapters[0]:new CompositeResearchAdapter(secondLookAdapters);
// Free scheduled context refresh: local history, player identity and the free NFL/MLB status
// feeds, every CROWNIQ_CONTEXT_REFRESH_MINUTES. Never the odds provider or web research; Stat API history only
// through statContext below. NBA status (Stat API) joins only under its own daily lookup cap.
const nonNegative=(name:string,fallback:number)=>{
  const value=Number(process.env[name]??fallback);
  if(!Number.isFinite(value)||value<0)throw new Error(`Invalid ${name}`);
  return value;
};
const boardCacheFile=process.env.CROWNIQ_BOARD_CACHE_FILE ?? `${dataDir}/board-cache.json`;
const contextIntervalMinutes=nonNegative('CROWNIQ_CONTEXT_REFRESH_MINUTES',15);
// Every game on the board: player-status findings last 30 minutes, so a game outside this window loses its status (and
// every GKR play on it) half an hour after a full refresh, or right after a restart.
const contextWindowHours=nonNegative('CROWNIQ_CONTEXT_WINDOW_HOURS',72);
const nbaDailyLookups=Math.floor(nonNegative('CROWNIQ_CONTEXT_NBA_DAILY_LOOKUPS',0));
const contextLookupBudget=statSource&&nbaDailyLookups>0
  ? new DailyLookupBudget(join(dirname(boardCacheFile),'context-lookup-budget.json'),nbaDailyLookups):null;
const tickContext=currentContextEnabled?new CurrentContextResearch({
  allowedKeys:approvedModelKeys.filter((key)=>key.startsWith('NFL:')||key.startsWith('MLB:')||
    contextLookupBudget!==null&&key.startsWith('NBA:')),
  statSource:statSource&&contextLookupBudget?{currentAvailability:async(sport,query)=>{
    if(!await contextLookupBudget.take())throw new Error('NBA_DAILY_LOOKUP_BUDGET_REACHED');
    return statSource.currentAvailability(sport,query);
  }}:undefined,
}):null;
// The paid Stat API feeds the 15-minute loop too (soonest games first, each player at most every 6 hours), so its
// history reaches GKR between board pulls. CROWNIQ_STAT_CONTEXT=false turns it off.
const statContext=statEvidence&&process.env.CROWNIQ_STAT_CONTEXT!=='false'?new StatApiContextResearch(statEvidence,{
  windowHours:nonNegative('CROWNIQ_STAT_CONTEXT_WINDOW_HOURS',36),
  cooldownHours:nonNegative('CROWNIQ_STAT_CONTEXT_COOLDOWN_HOURS',6),
  maxPlayers:Math.max(1,Math.floor(nonNegative('CROWNIQ_STAT_CONTEXT_MAX_PLAYERS',300)))}):null;
const contextAdapters=[internalEvidence,playerIdentity,tickContext,statContext,espnEvidence,freeHistoryEvidence]
  .filter((item):item is NonNullable<typeof item>=>!!item);
const contextRefresh=contextIntervalMinutes>0?{adapter:new CompositeResearchAdapter(contextAdapters),
  intervalMinutes:contextIntervalMinutes,windowHours:contextWindowHours}:null;
const googleClients=(process.env.CROWNIQ_GOOGLE_CLIENT_IDS??'').split(',').map((id)=>id.trim()).filter(Boolean);
const appleClients=(process.env.CROWNIQ_APPLE_CLIENT_IDS??'').split(',').map((id)=>id.trim()).filter(Boolean);
const identityVerifier=googleClients.length||appleClients.length
  ? new ProviderIdentityVerifier({GOOGLE:googleClients,APPLE:appleClients}):null;
// Saved picks are graded hourly: NFL from nflverse, then every sport box scores carry (MLB's official Stats API,
// ESPN's public box scores). Grading never changes a GKR score. CROWNIQ_BOX_SCORE_GRADING=false turns box scores off.
const boxScoreGrading=process.env.CROWNIQ_BOX_SCORE_GRADING!=='false';
const autoGrade=process.env.CROWNIQ_NFLVERSE_AUTO_GRADE==='true'||boxScoreGrading
  ? new ProductGradingWorker(product,process.env.NFLVERSE_MAPPING_FILE||null,undefined,undefined,
    boxScoreGrading?new BoxScoreResults(fetch,undefined,historyArchive):null) : null;
// The exported web app (npx expo export -p web), served by this server when present.
const webAppDir=process.env.CROWNIQ_WEB_DIR ?? fileURLToPath(new URL('../../mobile/dist',import.meta.url));
// A shared guest link for testers: CROWNIQ_GUEST_PASS_CODE, up to CROWNIQ_GUEST_PASS_MAX devices for
// CROWNIQ_GUEST_PASS_DAYS days each. Unset code means no guest link works.
const guestCode=process.env.CROWNIQ_GUEST_PASS_CODE?.trim();
const guestPass=guestCode&&guestCode.length>=8?{code:guestCode,
  maxGuests:Number(process.env.CROWNIQ_GUEST_PASS_MAX??4),days:Number(process.env.CROWNIQ_GUEST_PASS_DAYS??3)}:null;
if(guestCode&&!guestPass)console.warn('CROWNIQ_GUEST_PASS_CODE must be at least 8 characters; guest link is off.');
// A failed background task (a scheduled pull, a feed refresh) must never take the whole server down: log it and go on.
process.on('unhandledRejection', (reason) => {
  console.error('Background task failed:', reason instanceof Error ? reason.message : reason);
});
// CrownIQ Edge (Edge 2.0): its own ledger and odds snapshots on the data disk. EDGE_ENGINE=false turns it off.
// Goblin/Demon payout factors exist only when the owner sets them from the app (EDGE_GOBLIN_FACTOR, EDGE_DEMON_FACTOR);
// until then those lines get a hit chance but no edge.
const edgeFactor=(name:string)=>{
  const value=process.env[name];if(!value)return undefined;
  const parsed=Number(value);if(!Number.isFinite(parsed)||parsed<=0||parsed>5)throw new Error('Invalid '+name);
  return parsed;
};
const edgeAlternateFactors=Object.fromEntries(([['GOBLIN',edgeFactor('EDGE_GOBLIN_FACTOR')],['DEMON',edgeFactor('EDGE_DEMON_FACTOR')]] as const)
  .filter((entry):entry is readonly ['GOBLIN'|'DEMON',number]=>entry[1]!==undefined)) as Partial<Record<'GOBLIN'|'DEMON',number>>;
const edgeSnapshots=process.env.EDGE_ENGINE==='false'?null:(()=>{
  try{return new SnapshotStore(process.env.CROWNIQ_EDGE_SNAPSHOTS_FILE ?? `${dataDir}/edge/snapshots.sqlite`);}
  catch(error){console.error('[edge-snapshots] unavailable',error instanceof Error?error.message:error);return null;}
})();
const edgeDispersion=new DispersionStore(`${dataDir}/edge/edge-dispersion-v1.json`);
await edgeDispersion.load();
const edgeBookWeights=new BookWeightStore(`${dataDir}/edge/edge-book-weights-v1.json`);
await edgeBookWeights.load();
const edgeOptions={enabled:process.env.EDGE_ENGINE!=='false',dispersion:edgeDispersion,bookWeights:edgeBookWeights,
  ledger:new EdgeLedger(process.env.CROWNIQ_EDGE_LEDGER_FILE ?? `${dataDir}/edge/ledger.json`),
  snapshots:edgeSnapshots,alternateFactors:edgeAlternateFactors,
  boxScores:new BoxScoreResults(fetch,undefined,historyArchive),
  valuesCacheFile:`${dataDir}/edge/history-values.json`,
  // DK Pick'em publishes no payout chart; its Edge edges stay null until the owner confirms the tables in CROWNIQ_PAYOUTS.
  pick6PayoutsConfirmed:process.env.EDGE_PICK6_PAYOUTS_CONFIRMED==='true',
  alertsFile:`${dataDir}/edge/alerts.json`,staleLogFile:`${dataDir}/edge/stale-events.jsonl`};

const app = buildServer({ adminToken: process.env.ADMIN_TOKEN, playerHistory, espnHistory: espnEvidence, signupContact: process.env.CROWNIQ_SIGNUP_CONTACT?.trim() || null, guestPass, provider,
  webResearch,product,ownerPublicId,ownerResearch,ownerNotebook,internalHistory,historyBackfill,
  autoGradingEnabled:!!autoGrade,autoGradingStatus:()=>autoGrade?.status()??null,
  requireProfiles:true,identityVerifier,
  allowedWebOrigins:(process.env.CROWNIQ_ALLOWED_WEB_ORIGINS??'').split(',')
    .map((origin)=>origin.trim()).filter(Boolean),
  ownerJobStore:new OwnerPullJobStore(process.env.CROWNIQ_OWNER_JOB_FILE ?? `${dataDir}/owner-pull-job.json`),
  aiPicks:aiPickers.length?new AiPickService(aiPickers,`${dataDir}/ai-picks.json`,{
    dailyAuto:Number(process.env.CROWNIQ_AI_PICKS_DAILY ?? 120),dailyPerUser:Number(process.env.CROWNIQ_AI_PICKS_USER_DAILY ?? 15),
    perRun:Number(process.env.CROWNIQ_AI_PICKS_PER_RUN ?? 15),
    dailySecond:Number(process.env.CROWNIQ_SCOUT_SECOND_DAILY ?? 40),secondPerRun:Number(process.env.CROWNIQ_SCOUT_SECOND_PER_RUN ?? 8),
    dailyResults:Number(process.env.CROWNIQ_SCOUT_RESULTS_DAILY ?? 60),resultsPerRun:Number(process.env.CROWNIQ_SCOUT_RESULTS_PER_RUN ?? 10),
    dailyOwner:Number(process.env.CROWNIQ_SCOUT_OWNER_DAILY ?? 300),archive:historyArchive,
    extraFacts:playerHistory?(line)=>playerHistory.factsFor(line):undefined},new BoxScoreResults(fetch,undefined,historyArchive)):null,
  // The sports list costs no credits and returns the balance headers.
  oddsApiQuota:apiKey?async()=>{
    const response=await fetch(`https://api.the-odds-api.com/v4/sports?apiKey=${encodeURIComponent(apiKey)}`,
      {signal:AbortSignal.timeout(15_000)});
    const header=(name:string)=>{const value=response.headers.get(name);return value===null?null:Number(value);};
    return {status:response.status,remaining:header('x-requests-remaining'),used:header('x-requests-used')};
  }:null,
  historyArchive,
  edge:edgeOptions,
  feedback:new FeedbackStore(`${dataDir}/feedback.json`),
  tips:(()=>{const store=new TipStore(`${dataDir}/tips.json`);
    const reader=claudeKey?new ClaudeTipReader({apiKey:claudeKey,model:process.env.CROWNIQ_TIPS_MODEL??'claude-sonnet-5-5'}):null;
    return {store,reader,grader:reader?new TipGrader(store,reader):null};})(),
  shadowRecord:new ShadowRecord(`${dataDir}/shadow-record.json`,new BoxScoreResults(fetch,undefined,historyArchive)),
  baseRates:new BaseRates(`${dataDir}/base-rates.json`,new BoxScoreResults(fetch,undefined,historyArchive)),
  scrapedLines,appGkrScores:process.env.CROWNIQ_APP_GKR_SCORES==='true',appShadow:scrapedLines?{file:`${dataDir}/app-shadow.json`,boxScores:new BoxScoreResults(fetch,undefined,historyArchive)}:null,boardCache:new BoardCache(boardCacheFile),contextRefresh,contextLookupBudget,scraperPuller,contextFeeds,sharpProps,evBreakEven,payouts,
  booksHistoryFile:process.env.CROWNIQ_BOOKS_HISTORY_FILE ?? `${dataDir}/books-history.jsonl`,
  webAppDir:existsSync(webAppDir)?webAppDir:null,
  research:gkrResearch,secondLookResearch,startupResearch:internalEvidence,
  selections: process.env.CROWNIQ_SELECTIONS_FILE
    ? new JsonSelectionLedger(process.env.CROWNIQ_SELECTIONS_FILE) : null,
  nflverseMappingFile: process.env.NFLVERSE_MAPPING_FILE,
  models });
autoGrade?.start();
// Edge 2.0 data check (spec §1.1b), once per data disk.
setTimeout(()=>{void probeOddsApiOnce(apiKey,`${dataDir}/edge/odds-api-probe.json`).catch(()=>undefined);},20_000).unref();
// A first grading pass shortly after startup, so a deploy doesn't wait an hour for results.
if(autoGrade)setTimeout(()=>{void autoGrade.runOnce().catch(()=>undefined);},2*60_000).unref();
app.addHook('onClose',async()=>autoGrade?.stop());
const host = process.env.API_HOST ?? '127.0.0.1';
// Hosts such as Railway and Render hand the server its port in PORT.
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be a valid port');
}

await app.listen({ host, port });
console.log('CrownIQ API listening on ' + host + ':' + port + ' · build ' + ((process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 7) || 'unknown'));
