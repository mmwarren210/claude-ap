# Fix 07: B1–B5 (funnel, scheduled context refresh, readable breakdown, lighter board, one decision per pick)

Built against `mmwarren210/crowniq-ai` main `a4e22e5`. With the patch applied there, typecheck, all 159 tests (104 api, 9 mobile, 46 engine) and lint pass. Your B6 (LESS-aware versions) is kept as is; B3's structured fields were added on top of it.

## Prompt for ChatGPT

Create a branch from `main`, apply `07-fixes-B1-B5.patch` (`git apply 07-fixes-B1-B5.patch`), then do the app work listed under each fix, and open one PR. Do not change any model numbers.

### B1. Diagnostics funnel (in the patch)
- `GET /v1/owner/board/diagnostics` now returns `funnel` (each line counted once: game started, no model, unapproved with reasons, unclassified alternate, missing required evidence by kind, coverage under 60%, model favors the unoffered side split into `oppositeTwin` and `alternateSide`, other passes, scored by band, ranked count) and `outcomeCounts` (scored lines named `SCORED_<band>`). `reasonCounts` stays for one release, marked deprecated.
- `npm run audit:board -w @crowniq/api -- [--at ISO] [--json]` audits the saved board offline: funnel, Goblin/Demon payout multipliers, unclassified alternates by reason and market, and alternates that miss their Regular line only because of name spelling.
- **App work:** on the Owner board screen, add a "Where lines stop" card listing the funnel steps in order (hide zero rows except the first), with the missing-evidence kinds, the twin/alternate split and scored bands as small detail lines. Switch the "top reasons" list to `outcomeCounts`.

### B2. Free scheduled context refresh (in the patch)
- `BoardService.refreshContext(adapter, {windowHours})` re-researches lines whose games start within the window, replaces older evidence of the same kind, drops expired evidence, saves and republishes. It is skipped (`BOARD_BUSY`) while a pull, reanalysis or another tick runs, and never calls the odds provider, web research or `StatApiGkrEvidence`.
- `ContextRefreshScheduler` runs it every `CROWNIQ_CONTEXT_REFRESH_MINUTES` (default 15, 0 = off), once after startup recovery. NBA status joins only under `CROWNIQ_CONTEXT_NBA_DAILY_LOOKUPS` (default 0), a per-UTC-day cap saved next to the board cache.
- Diagnostics return `contextRefresh {enabled, intervalMinutes, last, nbaLookupsToday, nbaDailyLimit}`.
- **App work:** on the Owner board screen, show one line: "Automatic context refresh every N min · 0 Odds credits · last <time>, <status>: <lines> lines, <evidence> evidence records" (or "skipped (<reason>)"), plus "NBA lookups today X/Y" when a limit is set.

### B3. Readable breakdown (in the patch)
- Score components carry optional `kind` (`FACTOR`, `EVIDENCE_QUALITY`, `COVERAGE`, `LINE_ADJUSTMENT`, `CLAMP`), `measured`, `weight`, `observed`, `reference` and `favorsBelowReference` (set when your LESS-aware versions reverse a factor). Explanations and all numbers are unchanged; a new engine test checks the fields match.
- `apps/mobile/src/gkr-labels.ts` (new) has a plain label for all 230 model factors (test enforces it) and turns components into rows: `describeComponent()` and `scoreBreakdown()` (context rows and line-adjustment rows that add up to the score). It reads the structured fields and falls back to the text for older boards.
- **App work:** wherever the app shows a score breakdown, render `scoreBreakdown(analysis)`: two groups, "Player context" and "Line adjustments", each row's label, value ("+18.4 of 25" or "Not measured") and detail ("Recent 0.29 vs usual 0.25 (+16%)"). Do not show raw factor keys.

### B4. Lighter board and snapshot honesty (server part in the patch)
- `GET /v1/board/lite` returns games not yet started, full analyses for scored lines, slim analyses for PASS lines, and `rankedLineIds`/`playerMedia` filtered to match. Same schema as `/v1/board`.
- **App work:**
  - Read the Board from `/v1/board/lite`, falling back to `/v1/board` on 404 (also in the first-board polling loop).
  - Reread it (free) when the app returns to the foreground (`AppState` `active`), every 5 minutes while the Board screen is focused, and when the earliest `evidenceExpiresAt` among ranked analyses passes.
  - Lite view: skip any line whose `analysis.evidenceExpiresAt <= now`. Full view: show "Evidence expired, reanalysis needed" on scored lines whose evidence expired.
  - Show board age as "Captured N min ago" instead of LIVE/FRESH/CACHED, and always show "Saved snapshot. Confirm the exact line and direction in PrizePicks before playing."
  - Crown draft: refuse a leg below GKR 80 (the lowest minimum any Crown size accepts) with "GKR NN is below 80, the lowest score any Crown accepts." Keep flagging legs below the minimum for the Crown's current size (2: 88, 3: 86, 4: 84, 5: 82, 6: 80) rather than blocking them, so a person can start a larger Crown with an 82 pick.

### B5. One decision per pick (in the patch)
- Decisions get `decisionKey` = sha256 of [eventId, playerId, market, line, direction, lineType, modelVersion]. Tracking, saved picks, private Crowns and shares reuse the existing decision; a changed re-analysis is appended to `revisions` (compact: score, context, band, rank, research snapshot id). New decisions use the key as their id.
- On first read, an older ledger is backed up (`<file>.backup-<time>`), copies are folded into the earliest decision (keeping any grade), and saved picks, private Crowns, public Crown legs and public credits are re-pointed and de-duplicated.
- Picks a person saves or shares record `boardFetchedAt` and `snapshotAgeMinutes`. `CROWNIQ_SOCIAL_MAX_SNAPSHOT_MINUTES` (default 0 = off, keeping your event-start rule) can refuse old snapshots for public Crowns with `SNAPSHOT_TOO_OLD`.
- **App work:** map the `SNAPSHOT_TOO_OLD` Crown issue to "the board's lines are older than this server allows for public Crowns (wait for the next board pull)".

### Done when
- `npm run typecheck`, `npm test` and `npm run lint` pass.
- The PR lists, per fix, what came from the patch and what app work you added.
