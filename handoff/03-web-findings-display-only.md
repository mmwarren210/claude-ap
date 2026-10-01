# Fix 03: Web findings are display-only; web research starts on request

Give this whole file to ChatGPT, together with `03-web-findings-display-only.patch`. Apply fixes 01 and 02 first; this patch was made on top of them.

## Prompt for ChatGPT

You maintain the CrownIQ repository. Apply the following fix. The attached patch is the exact change made and tested in a reference copy of this repository (on top of fixes 01 and 02). Try `git apply 03-web-findings-display-only.patch` first (add `--ignore-whitespace` if line endings differ). If it doesn't apply cleanly, implement the same behavior by hand. Do not change any gate, threshold, model version or risk handling.

### Problem

Web research findings are built in `apps/api/src/web-research.ts` as kind `web:*`, sourceType `AI_STRUCTURED`, quality `LOW`, confidence 0.5, expiring after 45 minutes. No model reads `web:*` kinds as input, but `freshEvidenceFor` still passes them to the model, so:
- the evidence adjustment in `packages/engine/src/models/scoring.ts` drops from +2 to −3 for any player with a web finding (a 72.5 line became PASS in a test);
- `analysis.evidenceExpiresAt` in `packages/engine/src/analysis.ts` moves to the web finding's 45-minute expiry, so rankings and saved picks expire early;
- `evidenceQuality` shows LOW.

Separately, every provider pull automatically started a web research job (up to 1,500 OpenAI searches by default), which the pull's cost confirmation never mentioned.

### Changes

- `packages/engine/src/analysis.ts`: `evaluateLine` splits current evidence into model evidence (kind not starting with `web:`) and context evidence (`web:*`). Only model evidence feeds the hard-evidence check, the assessments, `evidenceIds`, `evidenceQuality` and `evidenceExpiresAt` (including PASS results). When context evidence exists, the analysis gets `contextEvidenceIds`.
- `packages/contracts/src/index.ts`: optional `contextEvidenceIds: string[]` on `analysisSchema`.
- `apps/api/src/server.ts`: the pull job no longer calls `webBuild.start` (`webResearchJob` is always null after a pull). New owner-only `POST /v1/owner/board/web-research`: 503 `WEB_RESEARCH_UNCONFIGURED` without an adapter, 428 without `{acknowledgeResearchCost: true}`, 503 `BOARD_UNAVAILABLE` without a board, 409 `WEB_RESEARCH_RUNNING` while a job runs, otherwise 202 with `{job, maxSearches}`. `POST /v1/admin/research/start` still works for the admin token.
- `apps/api/src/web-research.ts`: `maxSearchesPerRun` getter on `WebResearchAdapter`.
- `apps/mobile/src/app/player/[lineId].tsx`: shows "Web context (not scored): N findings".
- `apps/mobile/src/app/owner/board.tsx`: **Run web research (uses OpenAI searches)** button calling the new route.
- Docs: `docs/WEB_RESEARCH.md`, `docs/ARCHITECTURE.md`.

### Tests

- `packages/engine/test/production-models.test.ts`: a scored line has the same score, band, evidence quality, evidence expiry and `evidenceIds` with and without a `web:injury` LOW finding, and `contextEvidenceIds` lists it.
- `apps/api/test/web-research.test.ts`: an admin pull returns `webResearchJob: null` and makes no web calls; an explicit `research/start` runs the job; the board analysis has 0 `evidenceIds`, 1 `contextEvidenceIds` and a null `evidenceExpiresAt`. A second test covers the owner route (503 / 428 / 202 with `maxSearches`).

### Done when

`npm run typecheck`, `npm test` and `npm run lint` all pass. In the reference copy: API 89 tests, mobile 6, engine 41, all passing, typecheck and lint clean.
