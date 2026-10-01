# CrownIQ: all fixes, one prompt for ChatGPT

Paste everything below the line into ChatGPT, and attach the five patch files from this folder:
`01-paid-pull-safeguards.patch`, `02-health-lockdown.patch`, `03-web-findings-display-only.patch`,
`04-player-game-log.patch`, `05-crowns-team-identity.patch`.

---

You maintain the CrownIQ repository (Expo app in `apps/mobile`, Fastify API in `apps/api`, shared `packages/contracts` and `packages/engine`). Apply the fixes below in order. After each one, run `npm run typecheck`, `npm test` and `npm run lint`; all must pass before you move on. Use synthetic test fixtures only, and never call a paid provider in tests. Never relax a hard gate: started events, expired required evidence, unknown alternates, unmodeled markets and unoffered directions must stay unplayable. Never infer data you don't have.

## Part A: apply the five tested patches (already done and tested in a reference copy of this repo)

Apply in order with `git apply <file>` (add `--ignore-whitespace` if line endings differ). They apply cleanly in sequence to commit 5e3b89d. If one fails because the code changed, implement the same behavior by hand from its description.

1. **01 Paid-pull safeguards**
   - New `POST /v1/owner/board/bootstrap`, which refuses with `409 BOARD_EXISTS` once any board exists.
   - Admin `/refresh` and `/force-provider-refresh` need the `x-confirm-provider-cost: yes` header and share the single owner pull job (409 `PULL_RUNNING` while one runs).
   - The job record (stage, error, credits spent and remaining) is persisted to `CROWNIQ_OWNER_JOB_FILE`, and a restart mid-pull is reported as `INTERRUPTED_BY_RESTART`.
   - Mobile `use-board.tsx` splits `retry` into a free `reload()` and a confirmed `bootstrapPull()`. The Owner screen calls `reload()` after a pull or reanalysis, which fixes a double paid pull.
2. **02 Health lockdown.** `GET /health` returns only `{status, boardAvailable}`. The full status moves to the owner-only `GET /v1/owner/board/health`.
3. **03 Web findings display-only**
   - `web:*` evidence no longer reaches the models, evidence quality, `evidenceIds` or `evidenceExpiresAt`; it goes into the new optional `analysis.contextEvidenceIds`.
   - Pulls no longer auto-start OpenAI web research. The owner starts it with `POST /v1/owner/board/web-research` and `acknowledgeResearchCost: true`.
4. **04 Player game log**
   - `GET /v1/players/:sport/:playerId/:market/games` returns up to 15 recent logged values from internal history, newest first, one per game day.
   - Contracts gain `playerGameLogSchema` and an optional `playerMedia` on the board response.
5. **05 Crowns, team identity, correlation policy**
   - Lines carry `homeTeam` / `awayTeam`.
   - Sleeper and MLB exact matches emit `identity:team` and `identity:photo`, and the Sleeper lookup uses the game's sides to separate players who share a name.
   - The board service sets team and opponent only when the matched team is one of the line's two sides, and publishes `playerMedia`.
   - New `conservativeCorrelationPolicy` (at most 2 legs per game, no same-direction QB with a same-team receiver), on by default through `CROWNIQ_CROWN_CORRELATION_POLICY`.
   - Crown save and share failures return `issues` codes.

## Part B: remaining fixes (not yet done anywhere; implement them)

### B1. Truthful diagnostics funnel (read-only, zero provider calls)

In `apps/api/src/server.ts` `GET /v1/owner/board/diagnostics`, add a `funnel` object counted once per line, in this order:
- started;
- `marketNotModeled` (no registered module; today's MODEL_SUPPORT_INCOMPLETE);
- `modeledButUnapproved`, with its own reason counts;
- then, for approved markets:
  - `unknownAlternate`;
  - `missingHardEvidence`, broken down by missing kind (`projection:<market>` or each status kind);
  - `coverageBelow60`;
  - `offeredSideUnfavored`, split into `oppositeTwin` (another line with the same event, player, market and threshold and the other direction exists) and `alternateSide`;
  - other PASS reasons;
  - scored lines by `scoreBand`;
- finally, `rankedCount` after the one-line-per-player rule.

Stop labeling LEAN and WEAK lines "PLAYABLE" in `reasonCounts`, but keep the old fields for one release.

Add `apps/api/scripts/audit-saved-board.ts` (npm script `audit:board`). It loads `CROWNIQ_BOARD_CACHE_FILE`, re-evaluates it at `--at` (default: fetchedAt + 1 minute) with no network calls, and prints:
- the funnel;
- for alternates already classified GOBLIN or DEMON by threshold, a table of `payoutMultiplier` (<1, =1, >1, missing) by class;
- `UNKNOWN_ALTERNATE` counts by reason and by market;
- how many `NO_REGULAR_REFERENCE` alternates have a Regular line in the same event and market whose player name differs only by case, accents or punctuation.

Show the funnel on the Owner screen. Add tests with synthetic boards that hit every bucket.

### B2. Free scheduled context refresh (fixes rankings fading within an hour)

Player status evidence lasts only 10–60 minutes (`current-context.ts`, `research.ts` max ages), and only a manual Reanalyze refreshes it.

- **`board-service.ts`:** add `refreshContext(adapter)`, run inside `exclusive()`.
  1. Select upcoming lines in approved markets whose events start within `CROWNIQ_CONTEXT_WINDOW_HOURS` (default 8).
  2. Run `collectResearch` on that subset.
  3. Merge the results into base evidence, replacing items with the same entity, event, market and kind.
  4. Drop expired items, then save through `cache.save` and publish.

  It must never call the odds provider, web research or `StatApiGkrEvidence`.
- **`main.ts`:** add a scheduler that runs every `CROWNIQ_CONTEXT_REFRESH_MINUTES` (default 15; 0 disables).
  - It runs `InternalHistoryResearch` plus `CurrentContextResearch` limited to NFL and MLB.
  - NBA status is included only when `CROWNIQ_CONTEXT_NBA_DAILY_LOOKUPS > 0`, enforced with a daily counter saved next to the board cache.
  - Skip a tick while a pull, a reanalysis or an earlier tick is running.
  - Run one tick right after startup restore.
- **Status and tracking:** report `lastContextRefresh {at, linesTargeted, evidenceAdded, oddsCreditsUsed: 0, statApiLookups}` in status and on the Owner screen. Don't call `product.track` from ticks until B5 is done.
- **Tests** (fake adapters and a fake clock):
  - an expired-status line ranks again after a tick;
  - a tick never calls `provider.fetchPrizePicksLines`;
  - NBA stops at the budget;
  - a tick during a pull is skipped.

### B3. Readable GKR breakdown data

- **`packages/engine/src/models/scoring.ts`:** add optional structured fields `{observed, reference, weight, measured}` to each context component and `{kind}` to each line adjustment. Add them as optional fields on `scoreComponentSchema`. Keep the explanation text unchanged, and change no numbers.
- **App:** wherever the app shows the breakdown, render plain labels instead of raw keys, for example "Targets per snap" for `target_opportunity_rate`.
  - Measured metrics read "Last 5 avg 36.1 vs last 10 avg 33.0 (+9%)".
  - Unmeasured factors read "Not measured" instead of 0.
  - Show two groups, "Player context" and "Line adjustments", that add up to the score.
- **Test:** every factor key in `marketDefinitions` has a label.

### B4. Snapshot honesty and a lighter board

- **`apps/mobile/src/state.ts`:**
  - In Lite view, treat a line as unqualified once `analysis.evidenceExpiresAt <= now`.
  - In Full view, label it "Evidence expired, reanalysis needed".
- **Mobile `use-board.tsx`:** refetch `/v1/board` (it's free) on app foreground (AppState `active`), every 5 minutes while the Board is focused, and when the earliest ranked evidence expiry passes.
- **Labels:** replace LIVE / FRESH / CACHED with "Captured N min ago". Always show "Saved snapshot. Confirm the exact line and direction in PrizePicks before playing."
- **Server:** add `GET /v1/board/lite` (upcoming lines, slim analyses, `rankedLineIds`) for the Board list; the full board is about 17 MB at 15k lines.
- **Crown draft:** `addLeg` rejects legs below the Crown minimum for the next size (2 legs: 88, 3: 86, 4: 84, 5: 82, 6: 80).

### B5. De-duplicate tracked decisions and limit snapshot age for Social

`product-ledger.ts` `idFor()` hashes the whole evidence snapshot, so every reanalysis adds a duplicate decision. Grading then grades every copy, and the learning summary counts them all.

- **Decision key:** add `decisionKey = sha256([lineId, direction, modelVersion])`. In `track()`, `saveUserPick()`, `savePrivateCrown()` and `share()`, append later snapshots to an append-only `revisions` array instead of adding a decision.
- **Migration on read:**
  - Write a timestamped backup of the ledger first.
  - Keep the earliest decision per key and move the others into its `revisions`.
  - Rewrite `savedPicks`, `privateCrowns`, public Crown legs and `publicCredits` to the kept id.
- **Snapshot age:**
  - Store `boardFetchedAt` and `snapshotAgeMinutes` on decisions created from user actions.
  - `share()` rejects legs from a snapshot older than `CROWNIQ_SOCIAL_MAX_SNAPSHOT_MINUTES` (default 30) with `SNAPSHOT_TOO_OLD`.
- **Counting:** `learningSummary()` and `history()` count one decision per key.
- **Tests:** duplicate tracking, the migration, and the snapshot-age rejection.

### B6. Score LESS picks correctly (ONLY with the owner's explicit approval; it changes scores)

Context factors in `scoring.ts` treat "recent average above reference" as favorable for every pick, so a LESS pick on a rising player scores like a MORE pick.

- **Orientation:** give each factor an orientation in `definitions.ts`, either directional (minutes, volume, usage, rates) or neutral (stability, evidence_quality).
- **Scoring:** for LESS, use `clamp(.5 - delta*2, 0, 1)` on directional factors. Change nothing else, including the 68/80/86/92 thresholds and the 60% coverage gate.
- **Versioning:**
  - Ship this as new model versions (for example `GKR-NBA-PLAYER-POINTS-1.4`).
  - `createGkrRegistry(approvedVersions)` registers the new module only when its version is approved; otherwise it registers the current one.
  - `statHistoryReadyVersions` keeps the current versions.
- **Tests:**
  - Mirrored MORE/rising and LESS/falling fixtures score the same.
  - LESS/rising scores below LESS/falling.
  - The current versions reproduce today's scores exactly (golden test).

## Done when

Every part passes typecheck, tests and lint, and you list what you changed for each fix.
