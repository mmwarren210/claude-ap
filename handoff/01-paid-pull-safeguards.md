# Fix 01: Paid-pull safeguards

Give this whole file to ChatGPT, together with `01-paid-pull-safeguards.patch`.

## Prompt for ChatGPT

You maintain the CrownIQ repository. Apply the following fix. The attached patch is the exact change made and tested in a copy of this repository that was identical at commit 5e3b89d. Try `git apply 01-paid-pull-safeguards.patch` first (add `--ignore-whitespace` if line endings differ). If it doesn't apply cleanly because the code has changed, implement the same behavior by hand using the description below. Do not change scoring, evidence gates or provider normalization.

### Problems being fixed

1. **First-board double pull.** When the Board tab gets 503 it sets `needsBootstrap` in `apps/mobile/src/use-board.tsx`. After the owner's pull finishes, `apps/mobile/src/app/owner/board.tsx` calls `retry()` (also after a successful Reanalyze). `retry()` still sees `needsBootstrap` and no local board, so it POSTs `/v1/owner/board/refresh` with `acknowledgeProviderCost: true`. The server only refuses while a job is RUNNING, so a second paid pull starts.
2. **Refresh board spends credits when a board already exists.** `retry()` takes the free path only when the phone already holds a board, so on a new device, or while the first `/v1/board` download is loading or failed, the owner's tap starts a paid pull. The server never checks whether a board exists.
3. **Admin refresh skips confirmation and the job lock.** `POST /v1/admin/refresh` starts a paid pull with only the admin token and runs outside the owner job, so two pulls can run back to back.
4. **Restart hides a lost pull.** The job record is memory-only. A restart mid-pull loses it; the Owner screen shows an idle job with no failure.
5. **Owner screen misses completion.** The board provider re-renders every 60 s, giving `retry` a new identity, which re-runs the Owner screen's focus effect and resets `previousJob`.

### Changes

**Server (`apps/api`)**
- New `src/owner-pull-job.ts`: `OwnerPullJob` schema, `idlePullJob()`, and `OwnerPullJobStore` (atomic temp-file + rename, like `board-cache.ts`).
- `src/server.ts`:
  - The single pull job (`startOwnerBoardRefresh`) now records `tracked`, `refreshStage`, `creditsSpent` and `creditsRemaining` (from `provider.getHealth()`: `coverage.creditsSpent` when present, otherwise the drop in `creditsRemaining`), keeps a `pullDone` promise, and saves the record through `options.ownerJobStore` on start and finish.
  - `onReady` loads the saved record; a record still `RUNNING` becomes `FAILED` with error `INTERRUPTED_BY_RESTART` and is saved back.
  - New `POST /v1/owner/board/bootstrap` (owner-only): requires `{acknowledgeProviderCost: true}` (428 otherwise), returns `409 {code:'BOARD_EXISTS'}` when any board exists, otherwise starts the job (202).
  - `POST /v1/admin/refresh` and `POST /v1/admin/force-provider-refresh` share one handler: require header `x-confirm-provider-cost: yes` (428), return `409 {code:'PULL_RUNNING', job}` while a pull runs, otherwise start the job, await it, and return the old response fields plus `creditsSpent` and `creditsRemaining` (502 on failure).
  - New option `ownerJobStore?: OwnerPullJobStore | null`.
- `src/main.ts`: `ownerJobStore: new OwnerPullJobStore(process.env.CROWNIQ_OWNER_JOB_FILE ?? 'tmp/owner-pull-job.json')`.

**Mobile (`apps/mobile`)**
- `src/use-board.tsx`: `retry` is removed. The context exposes `reload()` (memoized, free reread of `/v1/board`), `needsBootstrap`, and `bootstrapPull()` (POSTs the new bootstrap route; on 409 it reloads; then polls as before).
- `src/components/BoardView.tsx`: the button reads **Pull first board** only when `needsBootstrap`, and opens a confirmation sheet ("Use credits and pull" / "Cancel") before calling `bootstrapPull()`. Otherwise it calls `reload()`. It is disabled while the board is loading.
- `src/app/owner/board.tsx`: calls `reload()` (never a paid route) after a pull succeeds or a reanalysis finishes; keeps `previousJob` in a `useRef`; shows credits used and remaining, and a clear message for `INTERRUPTED_BY_RESTART`.

**Tests**
- Existing admin-refresh tests now send `x-confirm-provider-cost: yes` (`nfl-pilot`, `server`, `web-research`, `product-routes`).
- New test in `apps/api/test/owner-board-refresh.test.ts`: bootstrap needs confirmation; while a pull is held open, owner refresh returns `started: false`, admin refresh returns 428 without the header and 409 with it; the finished job reports 7 credits spent and 493 remaining; bootstrap then returns `409 BOARD_EXISTS` without calling the provider; a confirmed admin pull works; and a job file left `RUNNING` reads back as `FAILED` / `INTERRUPTED_BY_RESTART` after a restart.

**Docs**
- `README.md`, `docs/PRODUCT_TRACKING_SOCIAL.md` and `.env.example` (`CROWNIQ_OWNER_JOB_FILE`).

### Done when

`npm run typecheck`, `npm test` and `npm run lint` all pass. In the reference copy: API 88 tests, mobile 6, engine 40, all passing, typecheck and lint clean.
