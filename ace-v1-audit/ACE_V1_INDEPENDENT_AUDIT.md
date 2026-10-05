# ACE v1 — Independent audit of `codex/ace-v1-full-build`

**Audited commit:** `636c9b0eb30435ca76f7b17f1820a48aab2bb9d9` (branch head equals the expected commit; no drift). The last code change is `a1c0cb1`; `636c9b0` changes only docs.
**Scope:** audit only. No application code was changed, nothing was committed, merged, or published, and no owner database, social account, or paid provider was used.

## Verdict: **Ready only after listed fixes** (merge as a supervised baseline). **Not ready** for live publishing or Auto Mode.

The engineering baseline is real. All claimed checks pass independently, including 81/81 tests with real Postgres 16, FFmpeg, and espeak-ng. Several of the 19 self-audit fixes hold. But four confirmed defects undermine ACE's central promise ("Evidence > everything"), and the closed learning loop and Auto Mode are mostly not implemented as the spec describes:

- **Unverified claims reach publication.** Non-important, stale, low-confidence evidence is narrated as fact and passes QC, approval, and the connected-publish re-check (F1). Templates speak the unverified discovery headline (F2). Short contradictory numeric claims both verify (F3). Sibling domains of one publisher count as independent corroboration (F4).
- **Reconnecting an account is impossible on Postgres** (F5). Same-channel lock waiters starve the connection pool (F6).
- **LEARN does not change behavior.** Patterns are recomputed only on a manual API call and only feed an advisory endpoint. Creative dimensions are constants (G3).
- **Auto Mode cannot approve anything.** It only republishes owner-approved projects (G2). The test that "proves" otherwise uses a state the code never produces (T1).
- **In live mode nothing can ever be verified,** and every live topic has zero platform candidates (G1).

---

## 1. Commands run (disposable environment)

| Command | Result |
|---|---|
| `npm ci` | PASS |
| `npm test` (no DATABASE_URL) | PASS: 15 files passed, 1 skipped; **77 passed, 4 skipped (81)**. Database tests skip cleanly. |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm audit --audit-level=low` | PASS, 0 vulnerabilities |
| `npm run audit:acceptance` | PASS (see the caveat under T3) |
| `npm run demo` | PASS |
| `npm run demo:live-fixture` | PASS |
| `npm run db:migrate` ×2 against disposable Postgres 16.14 | PASS, idempotent |
| `npm test` with DATABASE_URL + ACE_RENDER_INTEGRATION=1 + ACE_VOICE_INTEGRATION=1 (espeak-ng installed) | **PASS: 81 passed, 0 skipped** (Codex's 81 claim confirmed) |
| `npm run demo:full-fixture` (real FFmpeg) | PASS. Two real MP4s produced; fixture tone audio, fixture research. |
| `npm run smoke:dashboard` (Chromium) | PASS, using the pre-installed Chromium 1194 via an executablePath shim. Playwright 1.58.2 expects build 1208, which could not be downloaded here. |
| Docker build/readiness | **NOT RUN.** No Docker daemon in this sandbox. |
| Transaction-pooler (pgbouncer/Supavisor) behavior | **NOT RUN.** No pooler available. Analysis only (F7). |
| Live RSS reachability, real OAuth/upload/analytics | **NOT RUN** by design (no internet use or accounts). |
| GitHub Actions evidence | Verified via API: run 37227548312 (`a1c0cb1`) = success; run 37227823928 (`636c9b0`) = success. |
| Independent reproduction probes (`probes.test.ts`, `pg.test.ts`, attached) | **11/11 reproduce** the findings below. |

---

## 2. Confirmed bugs

### F1 — HIGH — Unverified, non-important evidence is narrated as fact and passes QC, approval, and publishing
- **Where:** `services/production/src/scripting.ts:129` (the script uses *all* evidence and ignores `important`, freshness, confidence, and source type); `scripting.ts:173-175` (`supported` accepts any cited evidence); `services/production/src/index.ts:213`; `services/publisher/src/index.ts:242-248`. `verifyEvidence` (`packages/shared/src/verification.ts:6`) only evaluates `important` items.
- **Requirement:** Spec §7 ("must not advance … when important claims are unsupported"), §18 ("never fabricate citations"), §21.
- **Repro (probe P3):** A research provider returns two matching official/direct important claims plus one non-important claim: `sourceType: 'other'`, confidence 0.05, `freshness: 'stale'`, published 2001, text "The mayor was secretly convicted of fraud in 1998". The topic becomes `verified`. `draftScript` includes the smear as a `fact` beat. QC `passed=true`, approval succeeds, and connected `publish()` uploads it (`uploads === 1`).
- **Expected:** Only claims that individually meet the verification bar may be spoken. **Actual:** Any non-contradicted evidence row qualifies.
- **Fix:** Build fact beats only from claims that belong to a verified, corroborated important group. Make `scriptEvidenceChecks` require the same per-claim bar (current, direct, primary/official, corroborated) at QC and at publish. Treat `important: false` as never speakable unless an owner override cites it.
- **Regression test:** P3 must fail (no smear beat; QC `claim_consistency` false if an owner adds it).

### F2 — HIGH — Hook, cold-open, and context templates speak the unverified discovery headline
- **Where:** `scripting.ts:136-140, 154` interpolate `project.title`, which is the raw RSS headline from `production/src/index.ts:169`. `scriptEvidenceChecks` (`scripting.ts:171-172`) whitelists those same interpolated strings as "neutral".
- **Requirement:** §7, §8 ("verified evidence"), self-audit A03.
- **Repro (probe P4):** Headline "Senator arrested in bribery sting"; the only verified claim is "The agency scheduled a press briefing for Monday". The script's `cold_open` and `context` beats contain the headline. QC `claim_consistency` passes and QC passes overall.
- **Fix:** Templates must not interpolate unverified text. Use a verified claim, or an owner-edited title that must itself match evidence. Audit owner title edits.
- **Regression test:** P4 must fail.

### F3 — HIGH — Short numerically contradictory claims both verify
- **Where:** `verification.ts:53-55`. The conflict check needs ≥0.7 token overlap, and numbers count as tokens.
- **Repro (P1):** "Acme raised 5 billion dollars" vs "Acme raised 7 billion dollars", each corroborated by two domains → `verified`. Overlap = 4/6 = 0.67.
- **Fix:** Compute overlap with numeric tokens removed and flag when numbers differ. Also cover unit and qualifier changes ("over"/"under", "million"/"billion"). Add negation words like "false", "unlikely", "won't".
- **Regression test:** P1 plus unit/qualifier variants → `needs_review`.

### F4 — MEDIUM — Sibling domains of one publisher count as independent corroboration
- **Where:** `verification.ts:19-27` (last-two-labels grouping).
- **Repro (P2):** `bbc.co.uk` + `bbc.com`, and `theguardian.com` + `guardian.co.uk`, each → `verified`. Conversely, every `*.co.uk` / `*.gov.uk` source collapses into a single group (`co.uk`), which undercounts.
- **Fix:** Use a Public Suffix List (e.g. `tldts`) for the registrable domain, plus an owner-maintained publisher-alias map. Require independence by publisher, not by host.
- **Regression test:** P2 → `needs_review`; `gov.uk` agency + `bbc.co.uk` → independent.

### F5 — HIGH (operations) — Re-authorizing a connected account fails on Postgres; memory mode keeps using the expired connection
- **Where:** `services/publisher/src/auth.ts:155-159` always inserts a new id. Unique index `platform_connections_unique (channel_id, destination, externalAccountId)` in `002_content_pipeline.sql`. `PgRepository.put` handles only `ON CONFLICT (id)`. Lookups use `.find(destination)` (`publisher/index.ts:232`, `analytics/index.ts:77`, `learning.ts:298`). There is no disconnect API.
- **Repro:** PG1 throws `duplicate key`, so the OAuth callback returns "Account connection failed". PG1b: in memory, after reconnect the old expired row is still selected, and `accessToken()` throws "reconnect account".
- **Impact:** Once a refresh token is revoked or expires (common for Google apps in "testing" status after 7 days, and for TikTok), the channel can never publish again without manual SQL.
- **Fix:** Upsert by (channel, destination, externalAccountId), keeping the id. Choose the newest connection deterministically. Add a disconnect endpoint with an audit event.
- **Regression test:** connect → expire → reconnect the same account → publish uses the new token (memory and Postgres).

### F6 — MEDIUM — Same-channel lock waiters exhaust the pg pool and stall unrelated work
- **Where:** `packages/database/src/index.ts:131-133` takes a pool connection *before* blocking in `pg_advisory_lock`. There is no `connectionTimeoutMillis` (`system.ts:41`), and the API processes jobs eagerly in-process (`queue.ts:76`).
- **Repro (PG2):** With pool max 3, one holder plus two waiters on channel A means a `get` on channel B cannot obtain a connection until A finishes (stalled more than 1.5 s). With the default max of 10, about 10 queued renders/discoveries for one channel freeze every DB read in the API, including `/ready`, for up to the 20-minute render timeout.
- **Fix:** Use `pg_try_advisory_lock` with backoff that releases the connection between attempts, or a lock-wait budget. Use a dedicated small pool for lock holders. Set `connectionTimeoutMillis`. Serialize same-channel jobs at claim time (skip channels with a running job).
- **Regression test:** PG2 must return the unrelated read promptly.

### F7 — MEDIUM (suspected; NOT RUN) — Silent failure under transaction-mode poolers
Session advisory locks (`index.ts:133-137, 144-147`) taken through Supabase's default transaction pooler (port 6543) can lock and unlock on different backends. That can leak locks or leave the system effectively unlocked. The limitation is documented, but nothing detects it.
- **Fix:** At startup, verify session affinity (e.g. compare `pg_backend_pid()` across two queries on one client, or reject known pooler ports/`pgbouncer=true`). Or switch to `pg_advisory_xact_lock` inside an explicit transaction.

### F8 — MEDIUM — Unauthenticated localhost mode accepts cross-site and DNS-rebinding requests
- **Where:** `apps/api/src/app.ts:62-68` (auth applies only when a token is set). There is no Host/Origin check.
- **Repro (P8):** `POST /v1/discovery/cycles` with `Origin: https://evil.example`, `Host: rebind.evil.example`, `content-type: text/plain` → 202. Any web page the owner visits can trigger discovery, research, render, QC, `scheduled/run`, `brain/recompute`, and reads (via rebinding).
- **Fix:** Always require the owner token for state-changing routes, or at least enforce a Host allow-list (`127.0.0.1`, `localhost`) and reject a cross-origin `Origin`.

### F9 — MEDIUM — No platform limit validation in QC or publishing
Spec §10 requires "platform file-limit validation". There are no checks for Shorts ≤ 3 min, TikTok/Reels duration or size, or YouTube title/description limits beyond 100/5000 (`publisher/index.ts:54`). Narration length is unplanned (G4), so a Shorts project can render longer than Shorts allows and still pass QC.
- **Fix:** Add a per-destination limits table checked in QC and before upload.

### F10 — LOW/MEDIUM — YouTube analytics normalize views by the wrong age
`services/analytics/src/index.ts:23-24` sums through *yesterday*, while age is `now − publishedAt` (`:101`, `learning.ts:194`). YouTube Analytics lags about 48–72 h. Rates for young content are biased low, and content published less than ~1 day ago throws every 6 h.
- **Fix:** Use `endDate` as the observation time, and skip (do not fail) until data exists.

### F11 — LOW — Auto worker acts on a stale snapshot
`workers/auto-worker/src/main.ts:174-188` reads `project.state` and `publishSettings` outside the lock and uses them inside. Reload inside the lock.

### F12 — LOW — A scheduled project whose evidence changed is retried forever
`publisher/index.ts:249-252` leaves the project `scheduled` after an evidence block. Every `runDue` creates another failed job and audit event, and those failed jobs count against the Auto daily post limit. Move the project to a review state instead.

### F13 — LOW — Raw error messages returned by default-channel routes
`app.ts:250,258,270,282,289,306,338,372,392,402,409` return `error.message` without `safeError`. This is owner-only, and no secret leak was found, but it is inconsistent with A15. Use `safeError` everywhere.

### F14 — LOW — Stale job handlers' side effects are not fenced (suspected)
A06 fences only the `jobs` row. A stale render or research handler still writes renders, topics, and evidence after a retry. This is mitigated because both run under the channel lock and reload state. Consider an attempt token checked before the final project write.

### F15 — LOW — Budget reservation scans the entire `provider_usage` table under a global lock on every call
`packages/providers/src/index.ts:87`. Throughput degrades over time. Query today's rows and the cycle's rows with indexed SQL.

---

## 3. Missing or partial requirements (not credential gates)

| ID | Gap | Evidence |
|---|---|---|
| **G1** | **Live mode cannot verify anything, and live scores are meaningless.** The only research adapters are RSS feed-metadata matchers that emit `reporting`/`indirect` evidence (`live.ts:213-221`), so `verified` is unreachable. Discovery priors are constants (`live.ts:184-188`), so live topics differ only by freshness, max total is about 48 (the Auto default minimum is 85), and fit scores of about 41 are under the 60 cutoff (`discovery/index.ts:111-112`). **Every live topic has zero platform candidates** (probe P6). | P6 |
| **G2** | **Auto Mode cannot approve anything.** Its `quality` gate requires `qc.status === 'passed'` (`learning.ts:318`), which only an owner approval sets (`production/index.ts:514`). The `awaiting_approval` path is dead code. Auto also never drafts, renders, or QCs; it dispatches projects the owner already approved. | P5 |
| **G3** | **LEARN does not change behavior.** `recomputeLearnedPatterns` runs only on a manual API call (no worker invokes it). Patterns only affect `GET …/brain/recommendations`, which nothing else consumes. hookType = first beat kind (determined by destination), tone = `'clear'`, style/voice are constants (`analytics/index.ts:117-121`), so most dimensions can never yield a pattern. Experiments have no variant assignment. Requires 8 samples per cohort and does not "learn from video #1". | P7 |
| G4 | No narration duration planning. A 60 s target yields about 6 s and passes with a warning (`production/index.ts:484`). Caption timing is word-proportional, and QC's `caption_timing` only compares the file to its own regeneration (not alignment). | P4 |
| G5 | Workflow orchestration is manual. Each step from verified topic to project, script, voice, visuals, render, QC, approval, and publish is a separate owner call. There is no production worker, no scheduler definitions (cron files, compose services) for workers, and no automatic TikTok status polling (refresh is API-only). | code |
| G6 | Instagram insights are absent (no insights scope, and `analytics/index.ts:75` throws). | code |
| G7 | Forbidden topics are checked only as a substring of the title, and only at publish/Auto. Discovery does not apply them, and no blocked-source list exists beyond per-provider disable (§18). | `publisher/index.ts:204`, `learning.ts:325` |
| G8 | Duplicate-content check is exact SHA-256 only. Copyright/provenance is metadata only. Audio "intelligible" is a loudness check only. | `production/index.ts:429-469` |
| G9 | Architecture deviations from §17: served HTML instead of React/Next.js, Postgres queue instead of Redis, and no separate scripting/verification/voice/visuals/render services or production worker. Acceptable if accepted explicitly. | repo |
| G10 | Operations: no backups, media lifecycle, HTTPS proxy, alerting, secret rotation, or worker scheduling. Media defaults to `/tmp/ace-media` outside Docker (`system.ts:63`). No disconnect API. The dashboard has no UI for the auto-policy or publish reconciliation. | code |

**Unverified integrations (configuration-gated, but adapter code exists):** YouTube OAuth, upload, thumbnail, and Analytics; TikTok OAuth, Direct Post, status, and video query; Instagram OAuth and Reels publish. All are fixture-tested only. Request shapes look plausible but are not validated against live APIs. YouTube processing rejection after upload is never checked.

---

## 4. Do the 19 self-audit corrections hold?

| ID | Verdict | Note |
|---|---|---|
| A01 | **Partial** | Exact-match corroboration holds; short numeric conflicts evade it (F3); non-important claims bypass it entirely (F1). |
| A02 | **Partial** | Subdomain and age rechecks hold; sibling domains count as independent (F4). |
| A03 | **Partial** | The label-swap bypass for facts is fixed; template interpolation and non-important support remain (F1, F2). |
| A04 | **Holds, with caveats** | Serialization works (two-connection test passes); pool starvation (F6); pooler unguarded (F7). |
| A05 | Holds | Channel scope is enforced in both repos (reviewed). |
| A06 | Holds (row level) | Side effects are not fenced (F14). |
| A07 | Holds | Within the owner-reconciliation model. |
| A08 | Holds | No automatic status polling (G5). |
| A09–A12 | Hold | Real FFmpeg and espeak tests pass; reviewed paths, process bounds, and symlink checks. |
| A13 | **Partial** | Measured duration holds; creative dimensions are constant (G3); age bias (F10). |
| A14 | **Partial** | Current-state reload holds; the awaiting-approval path is unreachable, and its test fabricates state (G2, T1). |
| A15 | **Partial** | The vault requires a token; tokenless localhost is CSRF/rebinding-exposed (F8); raw errors (F13). |
| A16 | Holds | 0 vulnerabilities. |
| A17 | Holds | Reviewed. |
| A18 | Holds for voice | Discovery/research overruns are counted but emit no overrun audit event. |
| A19 | Holds | Reviewed plus tests; performance note in F15. |

---

## 5. Test quality

- **T1:** `tests/auto-mode.test.ts:29-40` hand-writes a QC run with `status: 'passed'` for an `awaiting_approval` project, a state production code never creates, and evidence with a random `researchRunId` and no run. It "proves" an Auto path that cannot occur (G2).
- **T2:** Workers (`auto-worker`, `publishing-worker`, `analytics-worker`, `job-worker` main) have **no tests**.
- **T3:** `audit:acceptance` runs discovery and research in-process (`system.discovery.run`), not through HTTP. Only `/health`, providers/health, and budget go over HTTP. The report's "actual HTTP flows" wording overstates this.
- **T4:** Positive verification fixtures fabricate two `official`/`direct` sources with identical text. The suite never shows a *real* adapter reaching `verified` (because none can, G1).
- **T5:** The CI Docker readiness check runs without a database (memory), so it does not validate the compose stack. The browser test in CI depends on `playwright install`.
- **Positive:** Most tests assert behavior (blocked calls counted, cross-channel 404s, fencing, idempotent observations), and the self-audit regressions genuinely fail on the old logic for the cases they cover.

---

## 6. Requirement coverage matrix (summary)

Legend: **IV** = implemented and independently verified · **IU** = implemented, unverified · **P** = partial · **M** = missing · **B** = blocked by credentials or platform approval.

| Area | Status |
|---|---|
| P1 §20.1–14 (no-niche discovery, multi-source normalize, dedupe, explainable 0–100 score, components, three fit scores, targeted research, structured evidence, partial failure, dashboard, usage, multi-channel model, tests, no Phase 1 publishing) | **IV** (mock/fixture). Live scoring is degenerate (G1). |
| 1B RSS adapters / health / modes / budgets / Postgres | IV locally (fixture transport); live reachability IU (CI only) |
| Verification gate | **P** (F1–F4) |
| Script engine (short/long schema) | P: structure present; no learned inputs, no duration planning (G3, G4) |
| Voice / visuals / captions / FFmpeg / provenance | IV (baseline quality) |
| QC | P (F9, G4, G8) |
| Preview / approval / regeneration invalidation | IV |
| YouTube / TikTok / Instagram publishing | IU fixture only → **B** live |
| Scheduling | P (one-shot worker, no scheduler; F12) |
| Manual handoff / export | IV (export does not re-check evidence: low) |
| Analytics ingest (YT/TikTok) | IU → B live; P (F10); Instagram **M** (G6) |
| Learning / exploration / experiments / adaptive tuning | **P/M** (G3) |
| Auto Mode gated | **P**: gates exist; autonomous pipeline **M** (G2, G5) |
| Multi-channel isolation / budgets | IV (memory + Postgres) |
| Durable jobs / locks | IV with caveats (F6, F7, F14) |
| Security (vault, signed previews, rate limit, audit) | IV; P (F8, F13); blocked sources/forbidden topics P (G7) |
| Deployment | IU (Docker NOT RUN here; CI success observed); ops **M** (G10) |

**Workflow:** DISCOVER ✔ · SCORE ✔ (degenerate live) · RESEARCH ✔ (RSS metadata only) · VERIFY ✖ (bypassable, F1–F4; unreachable live, G1) · SCRIPT ✔ (manual) · PRODUCE ✔ (manual) · QC ✔ (gaps) · APPROVE ✔ (owner only) · PUBLISH fixture only · MEASURE fixture only · LEARN ✖ (manual, advisory, constant dimensions). **Auto Mode only dispatches owner-approved projects.**

---

## 7. Recommendations

- **Merging into main:** Acceptable once P0 below is fixed, with a README status that states the gaps in §3 plainly ("baseline; not autonomous; live verification unavailable").
- **Local use (mock / fixture / manual review):** Fine today if the owner token is always set (F8). Treat every script as needing line-by-line review until F1/F2 are fixed.
- **Live publishing:** Not ready. It needs P0 and P1 fixes, a primary-source research adapter, private-visibility sandbox validation per platform, and backups/HTTPS/scheduling.
- **Auto Mode:** Not ready, and not actually autonomous. Keep the kill switch on until G1, G2, G3, and G5 are designed and implemented.

## 8. Prioritized fix list for Codex

**P0 (before merge)**
1. F1: speak only verified-group claims; enforce at draft, QC, and publish (probe P3).
2. F2: remove unverified headline interpolation from templates (P4).
3. F3: numeric, unit, and negation conflict detection independent of overlap (P1).
4. F4: registrable-domain grouping (PSL) plus publisher alias map (P2).
5. F5: upsert connections; newest-wins selection; disconnect endpoint (PG1/PG1b).
6. F8: require the token (or a Host/Origin allow-list) for all `/v1` mutations (P8).
7. T1: rewrite the Auto test using real QC/approval flows, and decide G2 explicitly (either implement Auto approval with the same gates, or remove the dead path and document "Auto = scheduled dispatch of approved projects").

**P1 (before any live account)**
8. F6/F7: non-blocking lock acquisition, connection timeouts, a pooler detection guard (PG2).
9. F9: per-platform duration/size/metadata limits in QC and before upload; G4 duration planning (fit the script to the target, or reject).
10. A primary/official research adapter so `verified` is reachable without fixtures (G1); measured or explicitly "unknown" discovery signals instead of constant priors.
11. F10, F12, F11, F13.
12. Worker tests (T2); a TikTok status poller; a scheduler definition (cron or compose services) for all workers.

**P2 (product completion)**
13. G3: feed learned hook/tone/duration/style into script and production choices; run recompute after analytics ingestion; variant assignment for experiments.
14. G5: production-orchestration worker (verified topic → awaiting_approval).
15. G6 Instagram insights; G7 discovery-time forbidden/blocked sources; G10 ops (backups, media lifecycle, alerting, secret rotation); F14, F15.
