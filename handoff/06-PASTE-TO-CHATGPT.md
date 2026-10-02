# Fix 06: Apply fixes 03, 04 and 05 (rebased onto crowniq-ai main 9a77b06)

## Audit of what is already done (checked 2026-10-02)
- Fix 01 (paid-pull safeguards) is merged as PR #6, and fix 02 (health lockdown) as PR #7. Both match the handoff. Two differences, both fine:
  - `saveJob` now writes through a queue, so job records are saved in order. This is an improvement.
  - The explanatory comments were dropped.
- Typecheck passes and 134/134 tests pass on main.
- Fixes 03, 04 and 05 are **not** applied. The original `03` patch no longer applies cleanly, because removing those comments shifted its context. `05` depends on `03`.

## Prompt for ChatGPT
Apply `06-fixes-03-05-rebased.patch` to `main` (it was built against commit 9a77b06) on a new branch, then open a PR. It contains, unchanged in substance:
- **03:** web findings are display-only (`contextEvidenceIds`), and web research starts only through `POST /v1/owner/board/web-research` with `acknowledgeResearchCost: true`.
- **04:** `GET /v1/players/:sport/:playerId/:market/games`, which returns up to 15 logged games, deduped by game day.
- **05:** Crowns save again. This adds team identity from `identity:team` evidence matched to the event's sides, `homeTeam`/`awayTeam` on lines, `playerMedia` on the board, and `conservativeCorrelationPolicy` (`CROWNIQ_CROWN_CORRELATION_POLICY`, default `conservative`).

### Done when
- `git apply --check` passes on main. Verified.
- `npm run typecheck` passes, and `npm test` passes 141/141 (93 api, 6 contracts, 42 engine). Verified on a copy of main with the patch applied.
- The PR description lists the three fixes above.

## The patch (save as 06-fixes-03-05-rebased.patch and run `git apply 06-fixes-03-05-rebased.patch`)

```diff
diff --git a/.env.example b/.env.example
index ad17884..cfffc87 100644
--- a/.env.example
+++ b/.env.example
@@ -51,6 +51,8 @@ CROWNIQ_SELECTIONS_FILE=
 CROWNIQ_BOARD_CACHE_FILE=tmp/board-cache.json
 # Last paid-pull job record (status, credits spent); reports pulls interrupted by a restart.
 CROWNIQ_OWNER_JOB_FILE=tmp/owner-pull-job.json
+# Crown correlation rules for saving and sharing Crowns: conservative (default) or none (saves stay disabled).
+CROWNIQ_CROWN_CORRELATION_POLICY=conservative
 CROWNIQ_PRODUCT_LEDGER_FILE=tmp/product-ledger.json
 # Durable CrownIQ-owned historical observations. Seed backfills and live graded outcomes stay separate.
 CROWNIQ_INTERNAL_HISTORY_FILE=tmp/internal-history.json
diff --git a/README.md b/README.md
index 73c14cf..67c31bd 100644
--- a/README.md
+++ b/README.md
@@ -42,6 +42,8 @@ curl http://127.0.0.1:3000/health
 
 Every paid pull, from the app or a terminal, runs as one server job: a second request while one is running gets `409 PULL_RUNNING` (admin) or `started: false` (owner). Admin pulls require the `x-confirm-provider-cost: yes` header and return `428` without it. The job record, including Odds API credits spent and remaining, is saved to `CROWNIQ_OWNER_JOB_FILE` (default `tmp/owner-pull-job.json`); if the server stops mid-pull, the next start reports the job as failed with `INTERRUPTED_BY_RESTART`.
 
+Crowns are checked against `CROWNIQ_CROWN_CORRELATION_POLICY` (default `conservative`: at most two legs from one game, and no quarterback paired with his own team's receiver in the same direction) plus the existing same-player, same-team and minimum-score rules. A Crown also needs every leg's team confirmed: the server sets a line's team only when an exact source match (Sleeper for NFL, the MLB Stats API boxscore) names one of that game's two sides, and the same match supplies the player's photo link. A rejected save returns the failed rule codes in `issues`.
+
 After a restart, CrownIQ restores the saved board immediately and rebuilds expired historical evidence in the background from its local internal-history store. Startup recovery uses no Odds API or external research calls; it preserves the original board fetch time and never extends expired availability, lineup or other current facts. Owner Board Analysis reports active/expired evidence and recovery status, with a diagnostics reload control. Rankings reloads after saved-board reanalysis, on tab focus and every minute while visible, with retry controls for failed reads.
 
 For an existing saved board, the signed-in owner can use **Settings → Owner Board Analysis** (or `GET /v1/owner/board/diagnostics`) to inspect board age, support/approval/pass-reason counts, evidence, Second Look and fresh-context health without dumping thousands of lines. The screen's **Reanalyze saved board** action calls `POST /v1/owner/board/reanalyze` with explicit research-cost acknowledgement. It reevaluates the saved board with **zero Odds API credits**; a configured research source such as Stat API may consume its own quota. After success the mobile app rereads the saved board. This action never calls the paid odds-provider refresh. Failed optional research does not erase the last validated evidence snapshot.
diff --git a/apps/api/src/board-service.ts b/apps/api/src/board-service.ts
index fb6a595..f091ba1 100644
--- a/apps/api/src/board-service.ts
+++ b/apps/api/src/board-service.ts
@@ -1,5 +1,5 @@
 import { boardSchema, propLineSchema } from '@crowniq/contracts';
-import type { Analysis, Board, BoardResponse, Evidence, PropLine, SecondLookAudit } from '@crowniq/contracts';
+import type { Analysis, Board, BoardResponse, Evidence, PlayerMedia, PropLine, SecondLookAudit } from '@crowniq/contracts';
 import { collectResearch, effectiveEvidenceExpiry, evaluateBoard, ModelRegistry, researchTargetsFor } from '@crowniq/engine';
 import type { OddsProvider, ResearchAdapter, ResearchHealth } from '@crowniq/engine';
 import { classifyPrizePicksLineTypes, normalizeCachedPrizePicksLines } from './prizepicks-line-types.js';
@@ -39,6 +39,7 @@ export class BoardService {
   private webEvidence: readonly Evidence[] = [];
   private evidence: readonly Evidence[] = [];
   private secondLookAudits: Record<string,SecondLookAudit> = {};
+  private playerMedia: Record<string,PlayerMedia> = {};
   private nextDeadline = Infinity;
   private startupRecovery = {status:'NOT_NEEDED' as 'NOT_NEEDED'|'UNCONFIGURED'|'RUNNING'|'SUCCEEDED'|'PARTIAL'|'FAILED',
     evidenceAdded:0,oddsCreditsUsed:0 as const,error:null as string|null};
@@ -136,14 +137,40 @@ export class BoardService {
 
   getEvidence(): readonly Evidence[] { this.getBoard(); return this.evidence; }
 
-  private publish(board: Board, evidence: readonly Evidence[], now: Date): BoardResponse {
+  /**
+   * Team identity from exact source matches. A line gets a team only when the matched team is one
+   * of its own event's two sides; anything else is ignored rather than guessed.
+   */
+  private withIdentity(board: Board, evidence: readonly Evidence[], now: Date): Board {
+    const teams = new Map<string, string>();
+    for (const item of evidence) {
+      if (item.entityType !== 'PLAYER' || effectiveEvidenceExpiry(item) <= now.getTime()) continue;
+      if (item.kind === 'identity:team') teams.set(item.eventId + '|' + item.entityId, item.finding);
+      if (item.kind === 'identity:photo' && item.sourceUrl)
+        this.playerMedia[item.entityId] = { photoUrl: item.sourceUrl, source: item.sourceName };
+    }
+    let changed = false;
+    const lines = board.lines.map((line) => {
+      const team = teams.get(line.eventId + '|' + line.playerId);
+      if (line.team || !team || (team !== line.homeTeam && team !== line.awayTeam)) return line;
+      changed = true;
+      return { ...line, team, opponent: (team === line.homeTeam ? line.awayTeam : line.homeTeam) ?? null };
+    });
+    return changed ? { ...board, lines } : board;
+  }
+
+  private publish(source: Board, evidence: readonly Evidence[], now: Date): BoardResponse {
+    const board = this.withIdentity(source, evidence, now);
     const result = evaluateBoard(board, evidence, this.models, now);
     const analyses=result.analyses.map((analysis)=>{
       const audit=this.secondLookAudits[analysis.lineId];
       return audit?{...analysis,reviewStatus:'SECOND_LOOK' as const,secondLook:audit}:
         {...analysis,reviewStatus:'STANDARD' as const,secondLook:null};
     });
-    this.snapshot = { board, analyses, rankedLineIds:result.rankedLineIds, builtAt: now.toISOString() };
+    const players = new Set(board.lines.map((line) => line.playerId));
+    const media = Object.fromEntries(Object.entries(this.playerMedia).filter(([playerId]) => players.has(playerId)));
+    this.snapshot = { board, analyses, rankedLineIds:result.rankedLineIds, builtAt: now.toISOString(),
+      ...(Object.keys(media).length ? { playerMedia: media } : {}) };
     this.evidence = evidence;
     this.nextDeadline = Infinity;
     for (const line of board.lines) {
diff --git a/apps/api/src/current-context.ts b/apps/api/src/current-context.ts
index 52b602f..67b3b82 100644
--- a/apps/api/src/current-context.ts
+++ b/apps/api/src/current-context.ts
@@ -10,6 +10,17 @@ type CacheEntry={until:number;value:unknown};
 const MLB_BASE='https://statsapi.mlb.com/api/v1';
 const MLB_FEED_BASE='https://statsapi.mlb.com/api/v1.1';
 const SLEEPER_NFL_PLAYERS='https://api.sleeper.app/v1/players/nfl';
+/** Sleeper team codes to the full names the odds feed uses for NFL events. */
+export const NFL_TEAMS:Readonly<Record<string,string>>={ARI:'Arizona Cardinals',ATL:'Atlanta Falcons',
+  BAL:'Baltimore Ravens',BUF:'Buffalo Bills',CAR:'Carolina Panthers',CHI:'Chicago Bears',CIN:'Cincinnati Bengals',
+  CLE:'Cleveland Browns',DAL:'Dallas Cowboys',DEN:'Denver Broncos',DET:'Detroit Lions',GB:'Green Bay Packers',
+  HOU:'Houston Texans',IND:'Indianapolis Colts',JAX:'Jacksonville Jaguars',KC:'Kansas City Chiefs',
+  LV:'Las Vegas Raiders',LAC:'Los Angeles Chargers',LAR:'Los Angeles Rams',MIA:'Miami Dolphins',
+  MIN:'Minnesota Vikings',NE:'New England Patriots',NO:'New Orleans Saints',NYG:'New York Giants',
+  NYJ:'New York Jets',PHI:'Philadelphia Eagles',PIT:'Pittsburgh Steelers',SF:'San Francisco 49ers',
+  SEA:'Seattle Seahawks',TB:'Tampa Bay Buccaneers',TEN:'Tennessee Titans',WAS:'Washington Commanders'};
+const sleeperPhoto=(id:string)=>`https://sleepercdn.com/content/nfl/players/${encodeURIComponent(id)}.jpg`;
+const mlbPhoto=(id:number)=>`https://img.mlbstatic.com/mlb-photos/image/upload/w_213,q_auto:best/v1/people/${id}/headshot/67/current`;
 const MLB_MARKETS=new Set(['batter_hits_runs_rbis','batter_hits','batter_walks',
   'batter_home_runs','pitcher_strikeouts']);
 const NFL_MARKETS=new Set(['passing_yards','player_pass_attempts','player_pass_completions',
@@ -225,22 +236,29 @@ export class CurrentContextResearch implements ResearchAdapter{
     if(!targets.length)return[] as Evidence[];
     const raw=await this.json(SLEEPER_NFL_PLAYERS,15*60_000,undefined,counters);
     const root=object(raw);if(!root)throw new Error('CURRENT_NFL_STATUS_INVALID');
-    const byName=new Map<string,SleeperPlayer[]>();
-    for(const value of Object.values(root)){
+    const byName=new Map<string,{id:string;player:SleeperPlayer}[]>();
+    for(const [id,value] of Object.entries(root)){
       const player=object(value) as SleeperPlayer|null;if(!player)continue;
       const full=(player.full_name??[player.first_name,player.last_name].filter(Boolean).join(' ')).trim();
       if(!full)continue;const key=normalizeName(full);
-      byName.set(key,[...(byName.get(key)??[]),player]);
+      byName.set(key,[...(byName.get(key)??[]),{id,player}]);
     }
     const out:Evidence[]=[];
     for(const target of targets){
       let matches=byName.get(normalizeName(target.playerName))??[];
-      if(target.team){
-        const exact=matches.filter((item)=>normalizeName(item.team??'')===normalizeName(target.team!));
-        if(exact.length)matches=exact;
+      // Prefer players on one of this game's two teams; this separates players who share a name.
+      const sides=[target.homeTeam,target.awayTeam].filter((side):side is string=>!!side);
+      if(sides.length){
+        const inGame=matches.filter((item)=>sides.includes(NFL_TEAMS[(item.player.team??'').toUpperCase()]??''));
+        if(inGame.length)matches=inGame;
       }
       if(matches.length!==1)continue;
-      const player=matches[0],status=(player.status??'').trim().toLowerCase(),
+      const team=NFL_TEAMS[(matches[0].player.team??'').toUpperCase()];
+      if(team&&sides.includes(team))out.push(this.evidence(target,'identity:team',1,team,
+        'Sleeper public NFL player feed',SLEEPER_NFL_PLAYERS,'PUBLIC','MEDIUM',.8,30*60_000));
+      out.push(this.evidence(target,'identity:photo',1,'Player headshot',
+        'Sleeper player photos',sleeperPhoto(matches[0].id),'PUBLIC','MEDIUM',.8,30*60_000));
+      const player=matches[0].player,status=(player.status??'').trim().toLowerCase(),
         injury=(player.injury_status??'').trim();
       const available=(status===''||status==='active')&&!injury;
       out.push(this.evidence(target,'status:player_available',available?1:0,
@@ -258,7 +276,7 @@ export class CurrentContextResearch implements ResearchAdapter{
   }
 
   private async mlb(targets:readonly ResearchTarget[],counters:{searches:number;cacheHits:number}){
-    const out:Evidence[]=[];const diagnostics:MlbDiagnostics={groups:0,gameMatchedTargets:0,
+    const out:Evidence[]=[],identity:Evidence[]=[];const diagnostics:MlbDiagnostics={groups:0,gameMatchedTargets:0,
       boxscoreMatchedTargets:0,playerMatchedTargets:0,batterTargets:0,lineupPostedTargets:0,
       starterContextTargets:0,evidenceTargets:0,sourceFailures:0,failedGroups:0};
     if(!targets.length)return {evidence:out,diagnostics};
@@ -314,6 +332,11 @@ export class CurrentContextResearch implements ResearchAdapter{
             number(object(object(value)?.person)?.id)===playerId)?'home':null;
         if(!side)continue;
         const mine=side==='away'?away:home,other=side==='away'?'home':'away';
+        // The boxscore side is exact, so the team is the matching side of this event.
+        const team=side==='away'?target.awayTeam:target.homeTeam;
+        if(team)identity.push(this.evidence(target,'identity:team',1,team,'MLB Stats API',sourceUrl,'OFFICIAL','HIGH',.95,30*60_000));
+        identity.push(this.evidence(target,'identity:photo',1,'Player headshot','MLB player photos',mlbPhoto(playerId),
+          'OFFICIAL','HIGH',.95,30*60_000));
         if(target.market==='pitcher_strikeouts'){
           const starter=probableId(side);
           if(starter){
@@ -343,7 +366,8 @@ export class CurrentContextResearch implements ResearchAdapter{
         if(out.length>beforeCount)diagnostics.evidenceTargets++;
       }
     }
-    return {evidence:out,diagnostics};
+    // Identity is kept out of the context diagnostics, which count status findings only.
+    return {evidence:[...out,...identity],diagnostics};
   }
   private async nba(targets:readonly ResearchTarget[]){
     const diagnostics:NbaDiagnostics={lookups:0,identityMatched:0,availabilityResolved:0,failures:0};
diff --git a/apps/api/src/full-prizepicks-provider.ts b/apps/api/src/full-prizepicks-provider.ts
index ad0d7c5..f54799b 100644
--- a/apps/api/src/full-prizepicks-provider.ts
+++ b/apps/api/src/full-prizepicks-provider.ts
@@ -238,6 +238,7 @@ export class FullPrizePicksProvider implements OddsProvider<RawSelection> {
       eventStartTime: event.commence_time,
       playerId: sport.key + ':' + hash(outcome.description.trim().toLowerCase()),
       playerName: outcome.description.trim(), team: null, opponent: null,
+      homeTeam: event.home_team ?? null, awayTeam: event.away_team ?? null,
       market: normalizePrizePicksMarketKey(normalizedSport,marketKey),
       threshold: outcome.point, availableDirections: [direction], lineType, fetchedAt,
       ...(multiplier == null ? {} : { payoutMultiplier: multiplier }),
diff --git a/apps/api/src/internal-history.ts b/apps/api/src/internal-history.ts
index 438c86a..2e1b796 100644
--- a/apps/api/src/internal-history.ts
+++ b/apps/api/src/internal-history.ts
@@ -196,6 +196,21 @@ export class InternalHistoryStore {
       return result;
     });
   }
+  /** Up to 15 most recent pre-`before` values for one player and market, newest first. */
+  async gameLog(sport:string,playerId:string,playerName:string|null,market:string,before:Date){
+    const spec=internalHistorySpecs[sport as InternalHistorySport]?.[market];
+    if(!spec)return null;
+    const rows=await this.rowsFor({sport:sport as InternalHistorySport,playerId,playerName:playerName??'',
+      eventStartTime:before.toISOString(),eventId:'game-log',eventName:'game-log',league:sport,
+      team:null,opponent:null,market},40);
+    // One value per game day: a graded result and a stat row for the same game count once.
+    const seen=new Set<string>();
+    const games=rows.flatMap((row)=>{const value=spec.value(row),date=row.occurredAt.slice(0,10);
+      if(value===null||!Number.isFinite(value)||seen.has(date))return [];
+      seen.add(date);return [{date,opponent:null,value}];}).slice(0,15);
+    return {sport,playerId,playerName:playerName??rows[0]?.playerName??playerId,market,
+      source:'CROWNIQ_INTERNAL_HISTORY' as const,unit:spec.unit,games};
+  }
   async hasMinimumSamples(target:ResearchTarget,minSamples=5,recentSamples=10):Promise<boolean>{
     const spec=internalHistorySpecs[target.sport as InternalHistorySport]?.[target.market];
     if(!spec)return false;
diff --git a/apps/api/src/main.ts b/apps/api/src/main.ts
index fd00fa2..f294057 100644
--- a/apps/api/src/main.ts
+++ b/apps/api/src/main.ts
@@ -1,5 +1,5 @@
 import 'dotenv/config';
-import { CompositeResearchAdapter, createGkrRegistry, statHistoryReadyVersions } from '@crowniq/engine';
+import { CompositeResearchAdapter, conservativeCorrelationPolicy, createGkrRegistry, statHistoryReadyVersions } from '@crowniq/engine';
 import { buildServer } from './server.js';
 import { FullPrizePicksProvider } from './full-prizepicks-provider.js';
 import { TheOddsApiProvider } from './the-odds-api-provider.js';
@@ -72,8 +72,12 @@ const approvedModelKeys=Object.entries(models.requirements())
   .filter(([,requirement])=>requirement.approved).map(([key])=>key);
 const internalHistory=new InternalHistoryStore(process.env.CROWNIQ_INTERNAL_HISTORY_FILE ??
   'tmp/internal-history.json');
+// Crown saves and shares need a correlation policy; 'none' keeps them fail-closed.
+const correlationSetting=process.env.CROWNIQ_CROWN_CORRELATION_POLICY ?? 'conservative';
+if(!['conservative','none'].includes(correlationSetting))throw new Error('Invalid CROWNIQ_CROWN_CORRELATION_POLICY');
 const product=new ProductLedger(process.env.CROWNIQ_PRODUCT_LEDGER_FILE ??
-  'tmp/product-ledger.json',band,()=>new Date(),undefined,internalHistory);
+  'tmp/product-ledger.json',band,()=>new Date(),
+  correlationSetting==='conservative'?conservativeCorrelationPolicy:undefined,internalHistory);
 const statApiKey=process.env.STAT_API_KEY;
 const ownerPublicId=process.env.CROWNIQ_OWNER_PUBLIC_ID;
 const statDailyLimit=process.env.CROWNIQ_STAT_API_DAILY_RECORD_LIMIT
diff --git a/apps/api/src/server.ts b/apps/api/src/server.ts
index 08e44a3..66b3a65 100644
--- a/apps/api/src/server.ts
+++ b/apps/api/src/server.ts
@@ -149,7 +149,8 @@ export function buildServer(options: ServerOptions = {}) {
         let trackingStatus:OwnerPullJob['trackingStatus']=options.product?'OK':'UNCONFIGURED',tracked=0;
         if(options.product){try{tracked=await options.product.track(snapshot,service.getEvidence());}
           catch{trackingStatus='FAILED';}}
-        const webResearchJob=webBuild?.start(snapshot.board).id??null;
+        // Web research has its own cost (OpenAI searches), so a pull never starts it.
+        const webResearchJob=null;
         const status=service.getStatus();
         ownerBoardRefresh={...ownerBoardRefresh,status:'SUCCEEDED',finishedAt:now().toISOString(),
           error:null,trackingStatus,tracked,webResearchJob,refreshStage:status.refreshStage,
@@ -172,6 +173,13 @@ export function buildServer(options: ServerOptions = {}) {
     ? {...ownerBoardRefresh,refreshStage:service.getStatus().refreshStage}:ownerBoardRefresh;
 
   // Public liveness only. Operating detail lives behind owner or admin auth.
+  // Which Crown rules failed, from the ledger's error message, for a readable app message.
+  const crownIssues=(error:unknown)=>{
+    const message=error instanceof Error?error.message:'';
+    const match=/^CROWN_CONSTRAINT_REJECTED:(.+)$/.exec(message);
+    return match?match[1].split(',').filter((code)=>/^[A-Z_]+$/.test(code)):
+      /^[A-Z_]+$/.test(message)?[message]:[];
+  };
   app.get('/health', async () => ({ status: 'ok', boardAvailable: !!service.getBoard() }));
   const username=z.string().trim().regex(/^[A-Za-z0-9_]{3,24}$/);
   const email=z.email().max(254);
@@ -285,6 +293,19 @@ export function buildServer(options: ServerOptions = {}) {
       const started=startOwnerBoardRefresh();
       return reply.code(202).send({started,job:currentJob()});
     });
+    // Paid web research (OpenAI searches) runs only when the owner asks for it.
+    ownerBoard.post('/web-research',async(request,reply)=>{
+      if(!webBuild||!options.webResearch)return reply.code(503).send({code:'WEB_RESEARCH_UNCONFIGURED'});
+      const input=z.object({acknowledgeResearchCost:z.literal(true)}).strict().safeParse(request.body);
+      if(!input.success)return reply.code(428).send({code:'RESEARCH_COST_CONFIRMATION_REQUIRED',
+        message:'Web research uses OpenAI web searches, up to the configured maximum per run.'});
+      const snapshot=service.getBoard();
+      if(!snapshot)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
+      if(webBuild.getStatus()?.status==='RUNNING')
+        return reply.code(409).send({code:'WEB_RESEARCH_RUNNING',job:webBuild.getStatus()});
+      return reply.code(202).send({job:webBuild.start(snapshot.board),
+        maxSearches:options.webResearch.maxSearchesPerRun});
+    });
     ownerBoard.post('/bootstrap',async(request,reply)=>{
       if(!options.provider)return reply.code(503).send({code:'ODDS_PROVIDER_UNCONFIGURED'});
       const input=z.object({acknowledgeProviderCost:z.literal(true)}).strict().safeParse(request.body);
@@ -516,7 +537,7 @@ export function buildServer(options: ServerOptions = {}) {
     const board=service.getBoard();if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
     try{return reply.code(201).send(await options.product!.savePrivateCrown(user.accountId,
       input.data.lineIds,board,service.getEvidence()));}
-    catch{return reply.code(422).send({code:'CROWN_VALIDATION_FAILED'});}
+    catch(error){return reply.code(422).send({code:'CROWN_VALIDATION_FAILED',issues:crownIssues(error)});}
   });
   app.delete('/v1/me/crowns/:id',async(request,reply)=>{
     const user=await currentUser(request);if(!user)return reply.code(401).send({code:'SIGN_IN_REQUIRED'});
@@ -553,6 +574,19 @@ export function buildServer(options: ServerOptions = {}) {
         ? 'NFL_AUTO_GRADING':'AWAITING_VERIFIED_RESULTS',
       providerRefreshCost:0};
   });
+  // Recent logged games for one player and market, from CrownIQ's internal history.
+  // Values come from attributed stat rows only; nothing is filled in or inferred.
+  app.get('/v1/players/:sport/:playerId/:market/games', async(request,reply)=>{
+    const parsed=z.object({sport:z.string().min(1).max(20),playerId:z.string().min(1).max(200),
+      market:z.string().min(1).max(80)}).safeParse(request.params);
+    if(!parsed.success)return reply.code(400).send({code:'INVALID_GAME_LOG_REQUEST'});
+    if(!options.internalHistory)return reply.code(404).send({code:'NO_HISTORY'});
+    const line=service.getBoard()?.board.lines.find((item)=>item.playerId===parsed.data.playerId&&
+      item.sport===parsed.data.sport);
+    const log=await options.internalHistory.gameLog(parsed.data.sport,parsed.data.playerId,
+      line?.playerName??null,parsed.data.market,now());
+    return log&&log.games.length?log:reply.code(404).send({code:'NO_HISTORY'});
+  });
   app.get('/v1/history/:sport/:playerId/:market', async(request,reply)=>{
     if(!options.product)return reply.code(503).send({code:'TRACKING_UNCONFIGURED'});
     const parsed=z.object({sport:z.string().min(1),playerId:z.string().min(1),
@@ -633,7 +667,7 @@ export function buildServer(options: ServerOptions = {}) {
       const board=service.getBoard();if(!board)return reply.code(503).send({code:'BOARD_UNAVAILABLE'});
       try{return reply.code(201).send(await options.product!.share((await actor(request))!,
         parsed.data.lineIds,board,service.getEvidence()));}
-      catch{return reply.code(422).send({code:'CROWN_SHARE_REJECTED'});}
+      catch(error){return reply.code(422).send({code:'CROWN_SHARE_REJECTED',issues:crownIssues(error)});}
     });
     social.delete('/crowns/:id',async(request,reply)=>{
       const parsed=z.object({id:z.string().uuid()}).safeParse(request.params);
diff --git a/apps/api/src/the-odds-api-provider.ts b/apps/api/src/the-odds-api-provider.ts
index cc323df..23f48c5 100644
--- a/apps/api/src/the-odds-api-provider.ts
+++ b/apps/api/src/the-odds-api-provider.ts
@@ -155,7 +155,7 @@ export class TheOddsApiProvider implements OddsProvider<RawPrizePicksSelection>
       eventStartTime: event.commence_time,
       playerId: 'NFL:' + hash(outcome.description.trim().toLowerCase()),
       playerName: outcome.description.trim(),
-      team: null, opponent: null,
+      team: null, opponent: null, homeTeam: event.home_team, awayTeam: event.away_team,
       market: marketNames[marketKey], threshold: outcome.point,
       availableDirections: [direction], lineType, fetchedAt,
       ...(multiplier == null ? {} : { payoutMultiplier: multiplier }),
diff --git a/apps/api/src/web-research.ts b/apps/api/src/web-research.ts
index ed41674..814d37b 100644
--- a/apps/api/src/web-research.ts
+++ b/apps/api/src/web-research.ts
@@ -290,6 +290,9 @@ export class WebResearchAdapter implements ResearchAdapter {
     this.catalog = options.catalog ?? new WebResearchCatalog(null);
   }
 
+  /** The most searches one research run may spend. */
+  get maxSearchesPerRun(): number { return this.maxSearches; }
+
   getHealth(): ResearchHealth { return this.health; }
   getCatalogSummary() { return this.catalog.summary(); }
   async getCatalog(offset = 0, limit = 100, sport?: string) {
diff --git a/apps/api/test/identity.test.ts b/apps/api/test/identity.test.ts
new file mode 100644
index 0000000..71f1f00
--- /dev/null
+++ b/apps/api/test/identity.test.ts
@@ -0,0 +1,77 @@
+import assert from 'node:assert/strict';
+import { mkdtemp, rm } from 'node:fs/promises';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import test from 'node:test';
+import { boardSchema, evidenceSchema, propLineSchema } from '@crowniq/contracts';
+import type { Evidence, PropLine } from '@crowniq/contracts';
+import { conservativeCorrelationPolicy, ModelRegistry } from '@crowniq/engine';
+import type { ResearchTarget } from '@crowniq/engine';
+import { BoardService } from '../src/board-service.js';
+import { CurrentContextResearch } from '../src/current-context.js';
+import { ProductLedger } from '../src/product-ledger.js';
+
+const now = new Date('2030-09-20T15:00:00.000Z');
+
+test('NFL identity uses the game sides to separate players who share a name', async () => {
+  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
+    '4984': { full_name: 'Josh Allen', position: 'QB', status: 'Active', injury_status: null, team: 'BUF' },
+    '3321': { full_name: 'Josh Allen', position: 'LB', status: 'Active', injury_status: null, team: 'JAX' },
+  }), { status: 200 });
+  const adapter = new CurrentContextResearch({ fetchFn, clock: () => now, allowedKeys: ['NFL:passing_yards'] });
+  const target: ResearchTarget = { eventId: 'buf-mia', eventName: 'Miami Dolphins @ Buffalo Bills',
+    eventStartTime: '2030-09-21T17:00:00.000Z', league: 'NFL', playerId: 'nfl:josh', playerName: 'Josh Allen',
+    team: null, opponent: null, homeTeam: 'Buffalo Bills', awayTeam: 'Miami Dolphins', market: 'passing_yards', sport: 'NFL' };
+  const evidence = await adapter.research([target]);
+  assert.equal(evidence.find((item) => item.kind === 'identity:team')?.finding, 'Buffalo Bills');
+  assert.equal(evidence.find((item) => item.kind === 'identity:photo')?.sourceUrl,
+    'https://sleepercdn.com/content/nfl/players/4984.jpg');
+  assert.equal(evidence.find((item) => item.kind === 'status:qb_available')?.numeric?.value, 1);
+  // Without game sides the shared name stays ambiguous, so nothing is emitted.
+  assert.equal((await adapter.research([{ ...target, homeTeam: null, awayTeam: null }])).length, 0);
+});
+
+const line = (id: string, playerId: string, eventId = 'buf-mia', market = 'player_points'): PropLine => propLineSchema.parse({
+  id, provider: 'prizepicks', sourceLineId: id, sport: 'NFL', league: 'NFL', eventId, eventName: 'Miami Dolphins @ Buffalo Bills',
+  eventStartTime: '2030-09-21T17:00:00.000Z', playerId, playerName: playerId, team: null, opponent: null,
+  homeTeam: 'Buffalo Bills', awayTeam: 'Miami Dolphins', market, threshold: 10.5, availableDirections: ['MORE'],
+  lineType: 'REGULAR', fetchedAt: now.toISOString() });
+const identity = (playerId: string, kind: string, finding: string, sourceUrl = 'https://example.org/source'): Evidence =>
+  evidenceSchema.parse({ id: `${kind}:${playerId}`, entityType: 'PLAYER', entityId: playerId, eventId: 'buf-mia', market: null,
+    kind, finding, sourceName: 'Fixture source', sourceUrl, sourceType: 'PUBLIC', retrievedAt: now.toISOString(),
+    expiresAt: '2030-09-20T15:30:00.000Z', quality: 'MEDIUM', confidence: 0.8, numeric: { value: 1 } });
+
+test('board service sets team only from a matching side and publishes player photos', async () => {
+  const board = boardSchema.parse({ provider: 'prizepicks', fetchedAt: now.toISOString(),
+    lines: [line('a', 'allen'), line('b', 'waddle'), line('c', 'stranger')] });
+  const research = { id: 'fixture', research: async () => [identity('allen', 'identity:team', 'Buffalo Bills'),
+    identity('allen', 'identity:photo', 'Player headshot', 'https://sleepercdn.com/content/nfl/players/4984.jpg'),
+    identity('waddle', 'identity:team', 'Miami Dolphins'), identity('stranger', 'identity:team', 'Kansas City Chiefs')] };
+  const service = new BoardService({ id: 'fixture-provider', fetchPrizePicksLines: async () => board.lines,
+    normalize: (raw) => raw as PropLine }, research, new ModelRegistry(), () => now);
+  const snapshot = await service.refresh();
+  const byId = new Map(snapshot.board.lines.map((item) => [item.id, item]));
+  assert.deepEqual([byId.get('a')!.team, byId.get('a')!.opponent], ['Buffalo Bills', 'Miami Dolphins']);
+  assert.deepEqual([byId.get('b')!.team, byId.get('b')!.opponent], ['Miami Dolphins', 'Buffalo Bills']);
+  // A team that is not one of this game's sides is ignored, never guessed.
+  assert.equal(byId.get('c')!.team, null);
+  assert.equal(snapshot.playerMedia?.allen?.photoUrl, 'https://sleepercdn.com/content/nfl/players/4984.jpg');
+});
+
+test('with team identity and the conservative policy, a valid Crown saves; a 3-leg single game does not', async (t) => {
+  const dir = await mkdtemp(join(tmpdir(), 'crowniq-crown-policy-'));
+  t.after(() => rm(dir, { recursive: true, force: true }));
+  const ledger = new ProductLedger(join(dir, 'ledger.json'), 'CROWN_STRONG', () => now, conservativeCorrelationPolicy);
+  const user = await ledger.register('crown@example.org', 'abcdefghijkl', 'Crown_user');
+  const legs = [line('x1', 'p1', 'g1'), line('x2', 'p2', 'g2'), line('x3', 'p3', 'g2'), line('x4', 'p4', 'g2')]
+    .map((item, index) => ({ ...item, team: index % 2 ? 'Buffalo Bills' : 'Miami Dolphins' }));
+  const analysis = (lineId: string) => ({ lineId, direction: 'MORE' as const, score: 90, scoreBreakdown: [], assessments: [],
+    evidenceIds: [], evidenceExpiresAt: null, evidenceQuality: 'HIGH' as const, dangerZone: false, ruleChecks: [],
+    supportingFactors: [], opposingFactors: [], rationale: 'Fixture.', reasonCode: null, modelVersion: 'FIXTURE-1',
+    scoreBand: 'CROWN_STRONG' as const });
+  const board = { board: boardSchema.parse({ provider: 'prizepicks', fetchedAt: now.toISOString(), lines: legs }),
+    analyses: legs.map((item) => analysis(item.id)), rankedLineIds: legs.map((item) => item.id), builtAt: now.toISOString() };
+  const account = (await ledger.authenticate(user.token))!.accountId;
+  assert.equal((await ledger.savePrivateCrown(account, ['x1', 'x2'], board, [])).alreadySaved, false);
+  await assert.rejects(() => ledger.savePrivateCrown(account, ['x2', 'x3', 'x4'], board, []), /SAME_EVENT_CONCENTRATION/);
+});
diff --git a/apps/api/test/player-game-log.test.ts b/apps/api/test/player-game-log.test.ts
new file mode 100644
index 0000000..aa7ea6d
--- /dev/null
+++ b/apps/api/test/player-game-log.test.ts
@@ -0,0 +1,38 @@
+import assert from 'node:assert/strict';
+import { mkdtemp, rm } from 'node:fs/promises';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import test from 'node:test';
+import { playerGameLogSchema } from '@crowniq/contracts';
+import { InternalHistoryStore } from '../src/internal-history.js';
+import { buildServer } from '../src/server.js';
+
+test('game log endpoint serves real logged values newest first, one per game day', async (t) => {
+  const dir = await mkdtemp(join(tmpdir(), 'crowniq-game-log-'));
+  t.after(() => rm(dir, { recursive: true, force: true }));
+  const now = new Date('2030-10-19T12:00:00.000Z');
+  const store = new InternalHistoryStore(join(dir, 'history.json'), () => now);
+  const base = { sport: 'NFL' as const, playerId: 'log-player', playerName: 'Fixture QB', sourcePlayerId: '7',
+    marketValues: {}, sourceKind: 'SEED_BACKFILL' as const, sourceName: 'stat-api.com',
+    sourceUrl: 'https://api.stat-api.com/example', sourceType: 'LICENSED_FEED' as const,
+    importedAt: now.toISOString(), modelVersion: null, line: null, direction: null, lineScore: null, dataConfidence: null };
+  await store.add(Array.from({ length: 18 }, (_, index) => ({ ...base, id: 'seed-' + index, eventId: 'g-' + index,
+    occurredAt: new Date(Date.parse('2030-06-01T00:00:00.000Z') + index * 7 * 86_400_000).toISOString(),
+    metrics: { passing_yds: 200 + index } })));
+  // A graded result for the newest game day must not double count it.
+  await store.add([{ ...base, id: 'live-dup', eventId: 'g-17', sourceKind: 'LIVE_GRADED',
+    occurredAt: new Date(Date.parse('2030-06-01T00:00:00.000Z') + 17 * 7 * 86_400_000).toISOString(),
+    metrics: {}, marketValues: { passing_yards: 217 } }]);
+  const app = buildServer({ internalHistory: store, clock: () => now });
+  try {
+    const response = await app.inject('/v1/players/NFL/log-player/passing_yards/games');
+    assert.equal(response.statusCode, 200);
+    const log = playerGameLogSchema.parse(response.json());
+    assert.equal(log.games.length, 15);
+    assert.equal(log.games[0].value, 217);
+    assert.equal(log.games[1].value, 216);
+    assert.ok(log.games.every((game) => game.opponent === null));
+    assert.equal((await app.inject('/v1/players/NFL/log-player/player_sacks/games')).statusCode, 404);
+    assert.equal((await app.inject('/v1/players/NFL/nobody/passing_yards/games')).statusCode, 404);
+  } finally { await app.close(); }
+});
diff --git a/apps/api/test/web-research.test.ts b/apps/api/test/web-research.test.ts
index b7330df..f5532fa 100644
--- a/apps/api/test/web-research.test.ts
+++ b/apps/api/test/web-research.test.ts
@@ -8,6 +8,7 @@ import type { OddsProvider } from '@crowniq/engine';
 import { researchTargetsFor } from '@crowniq/engine';
 import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
 import { buildServer } from '../src/server.js';
+import { ProductLedger } from '../src/product-ledger.js';
 import { extractWebFindings, planWebResearch, sourceHintsFor,
   WebResearchAdapter, WebResearchCatalog } from '../src/web-research.js';
 
@@ -113,7 +114,7 @@ test('partial or uncited searches are reported and never create scored inputs',
   assert.equal(adapter.getHealth().failures, 1);
 });
 
-test('owner refresh runs web research in background; public reads never search', async () => {
+test('pulls never start web research; it runs on request and stays out of scoring', async () => {
   const provider: OddsProvider = { id: 'fixture-provider',
     fetchPrizePicksLines: async () => [{ id: 'fixture' }],
     normalize: (_raw, fetchedAt) => fixtureLine({ fetchedAt }),
@@ -133,7 +134,11 @@ test('owner refresh runs web research in background; public reads never search',
     assert.equal((await app.inject('/v1/admin/research/catalog')).statusCode, 401);
     const refreshed = await app.inject({ method: 'POST', url: '/v1/admin/refresh', headers });
     assert.equal(refreshed.statusCode, 200);
-    assert.ok(refreshed.json().webResearchJob);
+    // A paid odds pull does not also spend OpenAI searches.
+    assert.equal(refreshed.json().webResearchJob, null);
+    assert.equal(calls, 0);
+    const started = await app.inject({ method: 'POST', url: '/v1/admin/research/start', headers });
+    assert.equal(started.statusCode, 202);
     for (let i = 0; i < 20; i++) {
       const state = (await app.inject({ url: '/v1/admin/research/status', headers })).json().job;
       if (state.status !== 'RUNNING') break;
@@ -146,8 +151,42 @@ test('owner refresh runs web research in background; public reads never search',
     assert.equal((await app.inject({ url: '/v1/admin/research/catalog', headers })).json().total, 1);
     const boardResponse = (await app.inject('/v1/board')).json();
     assert.equal(boardResponse.analyses[0].direction, 'PASS');
-    assert.equal(boardResponse.analyses[0].evidenceIds.length, 1);
+    // The finding is listed for display but never counted as model evidence.
+    assert.equal(boardResponse.analyses[0].evidenceIds.length, 0);
+    assert.equal(boardResponse.analyses[0].contextEvidenceIds.length, 1);
+    assert.equal(boardResponse.analyses[0].evidenceExpiresAt, null);
     await app.inject('/v1/rankings');
     assert.equal(calls, 1);
   } finally { await app.close(); }
 });
+
+test('owner starts web research only with an explicit cost confirmation', async () => {
+  const folder = await mkdtemp(join(tmpdir(), 'crowniq-owner-web-'));
+  let calls = 0;
+  const adapter = new WebResearchAdapter({ apiKey: 'synthetic-test-key', clock: () => at, maxSearches: 25,
+    fetchFn: async () => { calls++; return new Response(JSON.stringify(response([])), { status: 200 }); } });
+  const provider: OddsProvider = { id: 'fixture-provider', fetchPrizePicksLines: async () => [{ id: 'fixture' }],
+    normalize: (_raw, fetchedAt) => fixtureLine({ fetchedAt }) };
+  try {
+    const ledger = new ProductLedger(join(folder, 'ledger.json'), 'CROWN_STRONG', () => at);
+    const owner = await ledger.register('web-owner@example.org', 'abcdefghijkl', 'Web_owner');
+    const app = buildServer({ provider, product: ledger, requireProfiles: true, webResearch: adapter,
+      ownerPublicId: owner.profile.publicId, clock: () => at });
+    const headers = { authorization: 'Bearer ' + owner.token };
+    try {
+      assert.equal((await app.inject({ method: 'POST', url: '/v1/owner/board/web-research', headers,
+        payload: { acknowledgeResearchCost: true } })).statusCode, 503);
+      await app.inject({ method: 'POST', url: '/v1/owner/board/bootstrap', headers,
+        payload: { acknowledgeProviderCost: true } });
+      for (let i = 0; i < 50 && (await app.inject({ url: '/v1/board', headers })).statusCode !== 200; i++)
+        await new Promise((resolve) => setImmediate(resolve));
+      assert.equal(calls, 0);
+      assert.equal((await app.inject({ method: 'POST', url: '/v1/owner/board/web-research', headers,
+        payload: {} })).statusCode, 428);
+      const started = await app.inject({ method: 'POST', url: '/v1/owner/board/web-research', headers,
+        payload: { acknowledgeResearchCost: true } });
+      assert.equal(started.statusCode, 202);
+      assert.equal(started.json().maxSearches, 25);
+    } finally { await app.close(); }
+  } finally { await rm(folder, { recursive: true, force: true }); }
+});
diff --git a/apps/mobile/src/app/owner/board.tsx b/apps/mobile/src/app/owner/board.tsx
index f3d1b1e..94cf8a5 100644
--- a/apps/mobile/src/app/owner/board.tsx
+++ b/apps/mobile/src/app/owner/board.tsx
@@ -145,6 +145,22 @@ export default function OwnerBoardScreen(){
     }finally{setBusy(false);}
   };
 
+  const runWebResearch=async()=>{
+    if(busy)return;
+    setBusy(true);setError('');setMessage('');
+    try{
+      const result=await json<{maxSearches:number}>(await request('/v1/owner/board/web-research',{
+        method:'POST',headers:{'content-type':'application/json'},
+        body:JSON.stringify({acknowledgeResearchCost:true}),
+      }));
+      setMessage(`Web research started · up to ${result.maxSearches.toLocaleString()} OpenAI searches. Findings are shown as context and never change scores.`);
+    }catch(cause){
+      const text=cause instanceof Error?cause.message:'Web research could not start.';
+      setError(text==='WEB_RESEARCH_UNCONFIGURED'?'Web research is not configured on this server.':
+        text==='WEB_RESEARCH_RUNNING'?'Web research is already running.':text);
+    }finally{setBusy(false);}
+  };
+
   const topReasons=Object.entries(diagnostics?.reasonCounts??{}).slice(0,6);
   const stageIndex=pullStages.indexOf(pullStatus?.refreshStage as typeof pullStages[number]);
   const step=Math.min(Math.max(stageIndex+1,1),5);
@@ -225,6 +241,10 @@ export default function OwnerBoardScreen(){
         onPress={()=>void reanalyze()} style={[styles.action,(busy||pulling||!diagnostics)&&styles.disabled]}>
         <Text style={styles.actionText}>{busy?'Reanalyzing saved board…':'Reanalyze saved board (0 Odds credits)'}</Text>
       </Pressable>
+      <Pressable accessibilityRole="button" disabled={busy||!diagnostics}
+        onPress={()=>void runWebResearch()} style={[styles.secondary,(busy||!diagnostics)&&styles.disabled]}>
+        <Text style={styles.secondaryText}>Run web research (uses OpenAI searches)</Text>
+      </Pressable>
       {!!message&&<Text accessibilityRole="alert" style={styles.success}>{message}</Text>}
       {!!error&&error!=='BOARD_UNAVAILABLE'&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
     </>}
@@ -242,6 +262,9 @@ const styles=StyleSheet.create({
     alignItems:'center',justifyContent:'center',paddingHorizontal:14},
   actionText:{color:palette.background,fontSize:14,fontWeight:'900',textAlign:'center'},
   disabled:{opacity:.5},
+  secondary:{minHeight:46,borderColor:palette.green,borderWidth:1,borderRadius:12,
+    alignItems:'center',justifyContent:'center',paddingHorizontal:14},
+  secondaryText:{color:palette.green,fontSize:13,fontWeight:'800',textAlign:'center'},
   track:{height:8,backgroundColor:palette.border,borderRadius:8,overflow:'hidden'},
   fill:{height:8,backgroundColor:palette.green,borderRadius:8},
   success:{color:palette.green,fontSize:13,lineHeight:19},
diff --git a/apps/mobile/src/app/player/[lineId].tsx b/apps/mobile/src/app/player/[lineId].tsx
index 14d0ea9..ed57596 100644
--- a/apps/mobile/src/app/player/[lineId].tsx
+++ b/apps/mobile/src/app/player/[lineId].tsx
@@ -70,6 +70,7 @@ export default function PlayerDetail() {
     {(analysis?.opposingFactors.length?analysis.opposingFactors:['No additional risk factors supplied.']).map((item,index)=><Text key={index} style={styles.detail}>• {item}</Text>)}
     <Text style={styles.heading}>Evidence status</Text>
     <Text style={styles.detail}>{analysis?.evidenceIds.length ?? 0} attributed findings · {analysis?.evidenceExpiresAt ? `expires ${new Date(analysis.evidenceExpiresAt).toLocaleString()}`:'no current expiry'}.</Text>
+    {!!analysis?.contextEvidenceIds?.length && <Text style={styles.detail}>Web context (not scored): {analysis.contextEvidenceIds.length} {analysis.contextEvidenceIds.length===1?'finding':'findings'}. These never change the GKR score.</Text>}
     <Text style={styles.detail}>Source details are not exposed by this public board response; unavailable values are not inferred.</Text>
     {history && <><Text style={styles.heading}>{history.label}</Text>
       <Text style={styles.detail}>CrownIQ Tracked History · verified graded outcomes only</Text>
diff --git a/docs/ARCHITECTURE.md b/docs/ARCHITECTURE.md
index d1f6db6..6cf24ca 100644
--- a/docs/ARCHITECTURE.md
+++ b/docs/ARCHITECTURE.md
@@ -6,7 +6,7 @@ The new repository began with only a one-line README. This foundation follows th
 
 1. A server-only `OddsProvider` fetches **PrizePicks lines only** and normalizes its own raw format to validated `PropLine` records. Full scope discovers all active sports and each event's PrizePicks markets. The earlier `TheOddsApiProvider` remains available as an explicit NFL passing-yards scope.
 2. `BoardService.refresh()` validates **every** normalized line, classifies alternates against the complete board's matching Regular thresholds, then assembles a timestamped board. If refresh fails, the previous validated in-memory snapshot remains available. Public screens never trigger a provider call.
-3. Optional file evidence receives deduplicated targets from the current board. With a server-side OpenAI key, the owner refresh also starts a background web job grouping all markets and thresholds by event and player. The job checkpoints a persistent catalog of exact searches and consulted URLs; only cited, short-lived `AI_STRUCTURED` findings enter the board. Partial failures are reported without crashing refresh. [Research guide](WEB_RESEARCH.md).
+3. Optional file evidence receives deduplicated targets from the current board. With a server-side OpenAI key, the owner can start a background web job (it never starts with a pull) that groups all markets and thresholds by event and player. The job checkpoints a persistent catalog of exact searches and consulted URLs; only cited, short-lived `AI_STRUCTURED` findings enter the board, as display-only context that never changes a score. Partial failures are reported without crashing refresh. [Research guide](WEB_RESEARCH.md).
 4. `ModelRegistry` maps `(sport, market)` to a versioned **code** module. Candidate lines get initial, adversarial, and final assessments. Unsupported markets, stale required evidence, unavailable directions, invalid scoring, and model exceptions produce `PASS`. AI does not choose picks.
 5. Only **after every line** is assessed does the ladder choose the strongest result per event/player/market/direction. The adapter preserves Regular/Goblin/Demon and `UNKNOWN_ALTERNATE` line identities. An unclassified alternate always gets PASS even when a future model is installed. Higher final score wins; tied scores prefer lower MORE or higher LESS thresholds. Real modules must account for payout and Demon tax when payout data is available. Payout is never guessed from indicative odds.
 6. The Crown audit enforces no duplicate player, Apex team limits and a required correlation policy. The 2–6 pick contract exists; user-facing generation waits for real models and an implemented correlation policy.
diff --git a/docs/WEB_RESEARCH.md b/docs/WEB_RESEARCH.md
index 79132fe..b0d5a4a 100644
--- a/docs/WEB_RESEARCH.md
+++ b/docs/WEB_RESEARCH.md
@@ -25,7 +25,7 @@ Other future sports have distinct search topics in `apps/api/src/web-research.ts
 ## Running and retaining research
 
 1. Set `OPENAI_API_KEY` and `RESEARCH_PROVIDER=auto` **in the server runtime**, and set `CROWNIQ_RESEARCH_CATALOG_FILE` to a writable durable volume. The optional `WEB_RESEARCH_MAX_SEARCHES` budget defaults to 1,500, enough for the saved board's 1,184 groups; `WEB_RESEARCH_CONCURRENCY` defaults to four. Web search is a paid external operation. The key is never sent to the mobile client.
-2. Trigger `POST /v1/admin/refresh` with the owner bearer token. It publishes the complete normalized board and starts a background research job. `GET /v1/admin/research/status` reports its progress and search, cache, failure, no-source, and skipped counts. `POST /v1/admin/research/start` searches the current board without another odds pull. `POST /v1/admin/research/cancel` stops an in-progress job. Public reads never spend web-search calls.
+2. Publish a board (`POST /v1/admin/refresh` with the admin token and `x-confirm-provider-cost: yes`, or the Owner screen pull). A pull never starts web research. Start it explicitly with **Run web research** on the Owner screen (`POST /v1/owner/board/web-research` with `acknowledgeResearchCost: true`) or `POST /v1/admin/research/start`. Web findings are display-only context: they are listed in `contextEvidenceIds` and never change a score, evidence quality or evidence expiry. `GET /v1/admin/research/status` reports its progress and search, cache, failure, no-source, and skipped counts. `POST /v1/admin/research/start` searches the current board without another odds pull. `POST /v1/admin/research/cancel` stops an in-progress job. Public reads never spend web-search calls.
 3. `GET /v1/admin/research/catalog?offset=0&limit=100&sport=MLB` pages the exact queries, event and player IDs, markets, search times, cited URLs, and statuses. The private JSON catalog also persists those records and its expiry-based evidence cache; it checkpoints after each small batch. Retain or back up that configured file between deployments. Reused sources guide discovery after a new odds snapshot even when the old evidence expires. The catalog's `sourceUrls` are actual consulted links; the offline plan's `sourceUrls` are empty by design.
 4. To generate the saved-board plan without network calls or API credit use: `npm run plan:research -w @crowniq/api -- /absolute/path/board.json 2026-09-24T08:00:50.000Z /absolute/path/research-plan.json`. To execute the live pass against a saved board with the key configured: `npm run run:research -w @crowniq/api -- /absolute/path/board.json /absolute/path/research-result.json`. The live script writes findings and status to its output and the exact searches and websites to `CROWNIQ_RESEARCH_CATALOG_FILE`. Read the status before treating it as complete.
 
diff --git a/packages/contracts/src/index.ts b/packages/contracts/src/index.ts
index ee0aa0b..d630ead 100644
--- a/packages/contracts/src/index.ts
+++ b/packages/contracts/src/index.ts
@@ -31,6 +31,9 @@ export const propLineSchema = z.object({
   playerName: identifier,
   team: z.string().nullable(),
   opponent: z.string().nullable(),
+  /** The event's two sides as the odds feed names them; team is only ever set to one of these. */
+  homeTeam: z.string().nullable().optional(),
+  awayTeam: z.string().nullable().optional(),
   market: identifier,
   threshold: z.number().finite(),
   availableDirections: z.array(playableDirectionSchema).min(1).refine(
@@ -134,6 +137,8 @@ export const analysisSchema = z.object({
   thresholdCushion: z.number().finite().nullable().optional(),
   reviewStatus: z.enum(['STANDARD', 'SECOND_LOOK']).optional(),
   secondLook: secondLookAuditSchema.nullable().optional(),
+  /** Display-only findings (web research) that no model scores. */
+  contextEvidenceIds: z.array(identifier).optional(),
 });
 
 export const rankingCardSchema = z.object({
@@ -214,11 +219,33 @@ export const rankingsResponseSchema = z.object({
   watchlist: z.array(secondLookCardSchema),
 });
 
+/** Display media for a player, resolved from an exact source match. Absent means initials. */
+export const playerMediaSchema = z.object({
+  photoUrl: z.url().nullable(),
+  source: z.string().nullable(),
+});
+
 export const boardResponseSchema = z.object({
   board: boardSchema,
   analyses: z.array(analysisSchema),
   rankedLineIds: z.array(identifier),
   builtAt: timestamp,
+  playerMedia: z.record(z.string(), playerMediaSchema).optional(),
+});
+
+/** Recent pre-event results for one player and market, newest first. Values are never inferred. */
+export const playerGameLogSchema = z.object({
+  sport: sportSchema,
+  playerId: identifier,
+  playerName: identifier,
+  market: identifier,
+  source: z.enum(['CROWNIQ_INTERNAL_HISTORY', 'DEMO']),
+  unit: z.string().nullable(),
+  games: z.array(z.object({
+    date: z.string().min(10),
+    opponent: z.string().nullable(),
+    value: z.number().finite(),
+  })).max(40),
 });
 
 export const savedSelectionSchema = z.object({
@@ -267,6 +294,8 @@ export type Direction = z.infer<typeof directionSchema>;
 export type PlayableDirection = z.infer<typeof playableDirectionSchema>;
 export type Sport = z.infer<typeof sportSchema>;
 export type BoardResponse = z.infer<typeof boardResponseSchema>;
+export type PlayerMedia = z.infer<typeof playerMediaSchema>;
+export type PlayerGameLog = z.infer<typeof playerGameLogSchema>;
 export type RankingCard = z.infer<typeof rankingCardSchema>;
 export type SecondLookCard = z.infer<typeof secondLookCardSchema>;
 export type RankingsResponse = z.infer<typeof rankingsResponseSchema>;
diff --git a/packages/engine/src/analysis.ts b/packages/engine/src/analysis.ts
index 662a374..b8251ea 100644
--- a/packages/engine/src/analysis.ts
+++ b/packages/engine/src/analysis.ts
@@ -18,6 +18,10 @@ function pass(line: PropLine, reasonCode: string, modelVersion: string | null,
   };
 }
 
+function isContextOnly(item: Evidence): boolean {
+  return item.kind.startsWith('web:');
+}
+
 function evidenceQuality(evidence: readonly Evidence[]): Analysis['evidenceQuality'] {
   if (!evidence.length) return 'NONE';
   if (evidence.some((item) => item.quality === 'LOW')) return 'LOW';
@@ -44,7 +48,19 @@ export function evaluateLine(line: PropLine, evidence: readonly Evidence[], regi
   if (Date.parse(line.eventStartTime) <= now.getTime()) {
     return pass(line, 'EVENT_ALREADY_STARTED', module?.version ?? null);
   }
-  const fresh = freshEvidenceFor(line, evidence, now);
+  const current = freshEvidenceFor(line, evidence, now);
+  // Web findings are AI-structured context for people to read. No model scores them, so
+  // they must not lower evidence quality or shorten the analysis's evidence expiry.
+  // Identity findings (team, photo) describe who the player is, not how they will perform.
+  const fresh = current.filter((item) => !isContextOnly(item) && !item.kind.startsWith('identity:'));
+  const contextIds = current.filter(isContextOnly).map((item) => item.id);
+  const withContext = (analysis: Analysis): Analysis =>
+    contextIds.length ? { ...analysis, contextEvidenceIds: contextIds } : analysis;
+  return withContext(evaluateWithEvidence(line, fresh, module));
+}
+
+function evaluateWithEvidence(line: PropLine, fresh: readonly Evidence[],
+  module: ModelModule | null): Analysis {
   if (!module) return pass(line, 'MODEL_SUPPORT_INCOMPLETE', null, fresh);
   if (line.lineType === 'UNKNOWN_ALTERNATE')
     return pass(line, 'UNCLASSIFIED_ALTERNATE', module.version, fresh);
diff --git a/packages/engine/src/correlation.ts b/packages/engine/src/correlation.ts
new file mode 100644
index 0000000..3cfdc1b
--- /dev/null
+++ b/packages/engine/src/correlation.ts
@@ -0,0 +1,25 @@
+import type { CorrelationPolicy } from './interfaces.js';
+
+const PASSING = new Set(['passing_yards', 'player_pass_completions', 'player_pass_attempts', 'player_pass_tds']);
+const RECEIVING = new Set(['player_reception_yds', 'player_receptions', 'player_receiving_targets']);
+
+/**
+ * Conservative Crown correlation rules:
+ * - at most two legs from one event, so one game cannot decide most of an entry;
+ * - no same-direction pair of a quarterback's passing market with a teammate's receiving
+ *   market, whose outcomes move together.
+ * Same-player and same-team limits are already enforced by auditCrown.
+ */
+export const conservativeCorrelationPolicy: CorrelationPolicy = (picks) => {
+  const issues: string[] = [];
+  const perEvent = new Map<string, number>();
+  for (const { line } of picks) perEvent.set(line.eventId, (perEvent.get(line.eventId) ?? 0) + 1);
+  if ([...perEvent.values()].some((count) => count > 2)) issues.push('SAME_EVENT_CONCENTRATION');
+  for (const passer of picks) {
+    if (!PASSING.has(passer.line.market) || !passer.line.team) continue;
+    const stacked = picks.some((other) => other !== passer && RECEIVING.has(other.line.market) &&
+      other.line.team === passer.line.team && other.analysis.direction === passer.analysis.direction);
+    if (stacked) { issues.push('QB_RECEIVER_STACK'); break; }
+  }
+  return issues;
+};
diff --git a/packages/engine/src/index.ts b/packages/engine/src/index.ts
index b935fc5..3f1e39a 100644
--- a/packages/engine/src/index.ts
+++ b/packages/engine/src/index.ts
@@ -10,3 +10,4 @@ export * from './fantasy/registry.js';
 export * from './fantasy/scoring.js';
 export * from './selections.js';
 export * from './grading.js';
+export * from './correlation.js';
diff --git a/packages/engine/src/interfaces.ts b/packages/engine/src/interfaces.ts
index 7c16469..da7b1ae 100644
--- a/packages/engine/src/interfaces.ts
+++ b/packages/engine/src/interfaces.ts
@@ -21,6 +21,9 @@ export interface ResearchTarget {
   readonly playerName: string;
   readonly team: string | null;
   readonly opponent: string | null;
+  /** The event's sides as the odds feed names them, when known. */
+  readonly homeTeam?: string | null;
+  readonly awayTeam?: string | null;
   readonly market: string;
   readonly sport: Sport;
 }
diff --git a/packages/engine/src/research.ts b/packages/engine/src/research.ts
index e6e4222..ac03c3f 100644
--- a/packages/engine/src/research.ts
+++ b/packages/engine/src/research.ts
@@ -44,9 +44,9 @@ export function freshEvidenceFor(line: PropLine, evidence: readonly Evidence[],
 
 export function researchTargetsFor(board: Board): ResearchTarget[] {
   const targets: ResearchTarget[] = board.lines.map(({ eventId, eventName, eventStartTime, league,
-    playerId, playerName, team, opponent, market, sport }) => ({
+    playerId, playerName, team, opponent, market, sport, homeTeam, awayTeam }) => ({
     eventId, eventName, eventStartTime, league, playerId, playerName,
-    team, opponent, market, sport,
+    team, opponent, market, sport, homeTeam: homeTeam ?? null, awayTeam: awayTeam ?? null,
   }));
   return [...new Map(targets.map((target) => [
     [target.eventId, target.playerId, target.market].join('|'), target,
diff --git a/packages/engine/test/engine.test.ts b/packages/engine/test/engine.test.ts
index 376889a..c38baa8 100644
--- a/packages/engine/test/engine.test.ts
+++ b/packages/engine/test/engine.test.ts
@@ -161,3 +161,20 @@ test('auto Crown only returns a complete audited combination', () => {
   assert.deepEqual(partial.picks?.map((pick) => pick.line.id), [a.id]);
   assert.ok(partial.issues.includes('INSUFFICIENT_QUALIFIED_PICKS'));
 });
+
+test('conservative correlation policy limits one game and same-team QB stacks', async () => {
+  const { conservativeCorrelationPolicy } = await import('../src/correlation.js');
+  const pick = (eventId: string, market: string, team: string, direction: 'MORE' | 'LESS') => ({
+    line: { eventId, market, team } as never, analysis: { direction } as never });
+  assert.deepEqual(conservativeCorrelationPolicy([pick('a', 'passing_yards', 'BUF', 'MORE'),
+    pick('b', 'player_points', 'LAL', 'MORE')]), []);
+  assert.deepEqual(conservativeCorrelationPolicy([pick('a', 'player_points', 'X', 'MORE'),
+    pick('a', 'player_rebounds', 'Y', 'MORE'), pick('a', 'player_assists', 'Z', 'MORE')]), ['SAME_EVENT_CONCENTRATION']);
+  assert.deepEqual(conservativeCorrelationPolicy([pick('a', 'passing_yards', 'BUF', 'MORE'),
+    pick('a', 'player_reception_yds', 'BUF', 'MORE')]), ['QB_RECEIVER_STACK']);
+  // Opposite directions, or an opposing receiver, are not a stack.
+  assert.deepEqual(conservativeCorrelationPolicy([pick('a', 'passing_yards', 'BUF', 'MORE'),
+    pick('a', 'player_reception_yds', 'BUF', 'LESS')]), []);
+  assert.deepEqual(conservativeCorrelationPolicy([pick('a', 'passing_yards', 'BUF', 'MORE'),
+    pick('a', 'player_reception_yds', 'MIA', 'MORE')]), []);
+});
diff --git a/packages/engine/test/production-models.test.ts b/packages/engine/test/production-models.test.ts
index 43b73c4..a4f0168 100644
--- a/packages/engine/test/production-models.test.ts
+++ b/packages/engine/test/production-models.test.ts
@@ -309,3 +309,23 @@ test('saved selection retains the exact line, context, score, evidence, and immu
   assert.equal(saved.grade,'PENDING');
   assert.throws(() => snapshotSelection(line,{...analysis,direction:'PASS'},e,now));
 });
+
+test('web findings are display-only: score, quality and expiry ignore them', () => {
+  const line = fixtureLine();
+  const evidence = inputs(line);
+  const web = evidenceSchema.parse({ id: 'web:fixture', entityType: 'PLAYER', entityId: line.playerId,
+    eventId: line.eventId, market: null, kind: 'web:injury', finding: 'Synthetic web claim.',
+    sourceName: 'example.org', sourceUrl: 'https://example.org/fixture', sourceType: 'AI_STRUCTURED',
+    retrievedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 45 * 60_000).toISOString(),
+    quality: 'LOW', confidence: 0.5 });
+  const without = run([line], evidence).analyses[0];
+  const withWeb = run([line], [...evidence, web]).analyses[0];
+  assert.notEqual(without.score, null);
+  assert.equal(withWeb.score, without.score);
+  assert.equal(withWeb.scoreBand, without.scoreBand);
+  assert.equal(withWeb.evidenceQuality, without.evidenceQuality);
+  assert.equal(withWeb.evidenceExpiresAt, without.evidenceExpiresAt);
+  assert.deepEqual(withWeb.evidenceIds, without.evidenceIds);
+  assert.deepEqual(withWeb.contextEvidenceIds, ['web:fixture']);
+  assert.equal(without.contextEvidenceIds, undefined);
+});
```
