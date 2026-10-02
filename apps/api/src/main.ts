import 'dotenv/config';
import { dirname, join } from 'node:path';
import { CompositeResearchAdapter, conservativeCorrelationPolicy, createGkrRegistry, lessAwareVersion, marketDefinitions,
  statHistoryReadyVersions } from '@crowniq/engine';
import { buildServer } from './server.js';
import { FullPrizePicksProvider } from './full-prizepicks-provider.js';
import { TheOddsApiProvider } from './the-odds-api-provider.js';
import { NflPassingFileResearch } from './nfl-evidence-file.js';
import { JsonSelectionLedger } from './selection-ledger.js';
import { WebResearchAdapter, WebResearchCatalog } from './web-research.js';
import { ProductLedger } from './product-ledger.js';
import { ProductGradingWorker } from './background-grading.js';
import { BoardCache } from './board-cache.js';
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

const apiKey = process.env.THE_ODDS_API_KEY;
const providerMode = process.env.ODDS_PROVIDER ?? 'auto';
if (!['auto', 'none', 'the_odds_api'].includes(providerMode)) {
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
const provider = providerName !== 'the_odds_api' || !apiKey ? null
  : scope === 'nfl_passing_yards'
    ? new TheOddsApiProvider({ apiKey,
      marketKeys: process.env.THE_ODDS_API_MARKETS?.split(',').map((item) => item.trim()),
      maxEvents, maxCreditsPerRefresh })
    : new FullPrizePicksProvider({ apiKey, maxEvents, maxCreditsPerRefresh });
if (providerName === 'the_odds_api' && !provider) {
  console.warn('The Odds API is selected but THE_ODDS_API_KEY is not set in this server runtime.');
}
const researchProvider = process.env.RESEARCH_PROVIDER ?? 'auto';
if (!['auto', 'none', 'openai_web'].includes(researchProvider)) {
  throw new Error('Unknown RESEARCH_PROVIDER');
}
const webKey = process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY;
const webResearch = researchProvider !== 'none' && webKey
  ? new WebResearchAdapter({ apiKey: webKey,
    model: process.env.WEB_RESEARCH_MODEL ?? 'gpt-5.4-mini',
    maxSearches: process.env.WEB_RESEARCH_MAX_SEARCHES
      ? Number(process.env.WEB_RESEARCH_MAX_SEARCHES) : undefined,
    concurrency: process.env.WEB_RESEARCH_CONCURRENCY
      ? Number(process.env.WEB_RESEARCH_CONCURRENCY) : undefined,
    catalog: new WebResearchCatalog(process.env.CROWNIQ_RESEARCH_CATALOG_FILE ??
      'tmp/research-catalog.json') }) : null;
if (researchProvider === 'openai_web' && !webResearch) {
  console.warn('Web research selected but OPENAI_API_KEY is absent from this server runtime.');
}
const band=process.env.CROWNIQ_AUTO_TRACK_MIN_BAND ?? 'CROWN_STRONG';
if(band!=='CROWN_STRONG' && band!=='PLAYABLE')throw new Error('Invalid CROWNIQ_AUTO_TRACK_MIN_BAND');
const modelPreset=process.env.GKR_MODEL_PRESET??'custom';
if(!['custom','stat_history_v1'].includes(modelPreset))throw new Error('Invalid GKR_MODEL_PRESET');
const configuredModelVersions=(process.env.GKR_APPROVED_MODEL_VERSIONS??'')
  .split(',').map((version)=>version.trim()).filter(Boolean);
const approvedModelVersions=[...new Set(modelPreset==='stat_history_v1'
  ? [...configuredModelVersions,...statHistoryReadyVersions]
  : configuredModelVersions)];
const models=createGkrRegistry(approvedModelVersions);
const knownModelVersions=new Set(marketDefinitions.flatMap((definition)=>
  [definition.version,lessAwareVersion(definition.version)]));
const unknownModelVersions=configuredModelVersions.filter((version)=>!knownModelVersions.has(version));
if(unknownModelVersions.length)console.warn('GKR_APPROVED_MODEL_VERSIONS lists unknown versions: '+unknownModelVersions.join(', '));
const approvedModelKeys=Object.entries(models.requirements())
  .filter(([,requirement])=>requirement.approved).map(([key])=>key);
const internalHistory=new InternalHistoryStore(process.env.CROWNIQ_INTERNAL_HISTORY_FILE ??
  'tmp/internal-history.json');
// Crown saves and shares need a correlation policy; 'none' keeps them fail-closed.
const correlationSetting=process.env.CROWNIQ_CROWN_CORRELATION_POLICY ?? 'conservative';
if(!['conservative','none'].includes(correlationSetting))throw new Error('Invalid CROWNIQ_CROWN_CORRELATION_POLICY');
const product=new ProductLedger(process.env.CROWNIQ_PRODUCT_LEDGER_FILE ??
  'tmp/product-ledger.json',band,()=>new Date(),
  correlationSetting==='conservative'?conservativeCorrelationPolicy:undefined,internalHistory);
const statApiKey=process.env.STAT_API_KEY;
const ownerPublicId=process.env.CROWNIQ_OWNER_PUBLIC_ID;
const statDailyLimit=process.env.CROWNIQ_STAT_API_DAILY_RECORD_LIMIT
  ? Number(process.env.CROWNIQ_STAT_API_DAILY_RECORD_LIMIT):100_000;
const statSource=statApiKey ? new StatApiOwnerResearch(statApiKey,fetch,()=>new Date(),statDailyLimit):null;
const ownerResearch=statSource && ownerPublicId ? statSource:null;
const historyBackfill=statSource?new HistoryBackfillService(statSource,internalHistory):null;
const ownerNotebook=ownerResearch ? new OwnerResearchNotebook(
  process.env.CROWNIQ_OWNER_RESEARCH_FILE??'tmp/owner-stat-research.json',ownerResearch,
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
const secondLookAdapters=[statEvidence,currentContext]
  .filter((item):item is NonNullable<typeof item>=>!!item);
const secondLookResearch=secondLookAdapters.length===0?null:secondLookAdapters.length===1
  ? secondLookAdapters[0]:new CompositeResearchAdapter(secondLookAdapters);
// Free scheduled context refresh: local history, player identity and the free NFL/MLB status
// feeds, every CROWNIQ_CONTEXT_REFRESH_MINUTES. Never the odds provider, web research or
// StatApiGkrEvidence. NBA status (Stat API) joins only under its own daily lookup cap.
const nonNegative=(name:string,fallback:number)=>{
  const value=Number(process.env[name]??fallback);
  if(!Number.isFinite(value)||value<0)throw new Error(`Invalid ${name}`);
  return value;
};
const boardCacheFile=process.env.CROWNIQ_BOARD_CACHE_FILE ?? 'tmp/board-cache.json';
const contextIntervalMinutes=nonNegative('CROWNIQ_CONTEXT_REFRESH_MINUTES',15);
const contextWindowHours=nonNegative('CROWNIQ_CONTEXT_WINDOW_HOURS',8);
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
const contextAdapters=[internalEvidence,playerIdentity,tickContext]
  .filter((item):item is NonNullable<typeof item>=>!!item);
const contextRefresh=contextIntervalMinutes>0?{adapter:new CompositeResearchAdapter(contextAdapters),
  intervalMinutes:contextIntervalMinutes,windowHours:contextWindowHours}:null;
const googleClients=(process.env.CROWNIQ_GOOGLE_CLIENT_IDS??'').split(',').map((id)=>id.trim()).filter(Boolean);
const appleClients=(process.env.CROWNIQ_APPLE_CLIENT_IDS??'').split(',').map((id)=>id.trim()).filter(Boolean);
const identityVerifier=googleClients.length||appleClients.length
  ? new ProviderIdentityVerifier({GOOGLE:googleClients,APPLE:appleClients}):null;
const autoGrade=process.env.CROWNIQ_NFLVERSE_AUTO_GRADE==='true'
  ? new ProductGradingWorker(product,process.env.NFLVERSE_MAPPING_FILE||null) : null;
const app = buildServer({ adminToken: process.env.ADMIN_TOKEN, provider,
  webResearch,product,ownerPublicId,ownerResearch,ownerNotebook,internalHistory,historyBackfill,
  autoGradingEnabled:!!autoGrade,autoGradingStatus:()=>autoGrade?.status()??null,
  requireProfiles:true,identityVerifier,
  allowedWebOrigins:(process.env.CROWNIQ_ALLOWED_WEB_ORIGINS??'').split(',')
    .map((origin)=>origin.trim()).filter(Boolean),
  ownerJobStore:new OwnerPullJobStore(process.env.CROWNIQ_OWNER_JOB_FILE ?? 'tmp/owner-pull-job.json'),
  boardCache:new BoardCache(boardCacheFile),contextRefresh,contextLookupBudget,
  research:gkrResearch,secondLookResearch,startupResearch:internalEvidence,
  selections: process.env.CROWNIQ_SELECTIONS_FILE
    ? new JsonSelectionLedger(process.env.CROWNIQ_SELECTIONS_FILE) : null,
  nflverseMappingFile: process.env.NFLVERSE_MAPPING_FILE,
  models });
autoGrade?.start();
app.addHook('onClose',async()=>autoGrade?.stop());
const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number(process.env.API_PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be a valid port');
}

await app.listen({ host, port });
console.log('CrownIQ API listening on ' + host + ':' + port);
