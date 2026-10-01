# Fix 02: Lock down the public health check

Give this whole file to ChatGPT, together with `02-health-lockdown.patch`. Apply fix 01 first; this patch was made on top of it.

## Prompt for ChatGPT

You maintain the CrownIQ repository. Apply the following fix. The attached patch is the exact change made and tested in a reference copy of this repository (on top of fix 01). Try `git apply 02-health-lockdown.patch` first (add `--ignore-whitespace` if line endings differ). If it doesn't apply cleanly, implement the same behavior by hand.

### Problem

`GET /health` in `apps/api/src/server.ts` is outside the profile check and returns most of `service.getStatus()`: research health per source, Second Look results by sport and market, missing-factor counts by market, model versions, the last error and refresh counts. Anyone who can reach the server can read it, and each anonymous request scans every analysis.

### Changes

- `apps/api/src/server.ts`:
  - `GET /health` returns only `{ status: 'ok', boardAvailable: boolean }` and does not call `service.getStatus()`.
  - New `GET /v1/owner/board/health` inside the existing owner-only `/v1/owner/board` plugin returns the previous payload (`status: 'ok'` plus `getStatus()` without `providerHealth` and `modelRequirements`). `GET /v1/admin/status` is unchanged.
- Tests:
  - `apps/api/test/server.test.ts`: anonymous `/health` equals `{status:'ok', boardAvailable:false}` with no board and `{status:'ok', boardAvailable:true}` after a pull.
  - `apps/api/test/startup-recovery.test.ts`: the startup-recovery test reads `lineCount` and `startupRecovery` from `/v1/admin/status` with an admin token instead of `/health`.
  - `apps/api/test/owner-board-refresh.test.ts`: the owner gets `lineCount` from `/v1/owner/board/health` with no `providerHealth`; a non-owner gets 404.
- `README.md`: notes what `/health` reports and where full status lives.

If anything else (a monitor, script or the mobile app) reads fields other than `status` from `/health`, switch it to `/v1/owner/board/health` or `/v1/admin/status`.

### Done when

`npm run typecheck`, `npm test` and `npm run lint` all pass. In the reference copy: API 88 tests, mobile 6, engine 40, all passing, typecheck and lint clean.
