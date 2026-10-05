# Prompt for Codex

An independent audit of `mmwarren210/ace-v1`, branch `codex/ace-v1-full-build` at commit `636c9b0`, is published in a separate repository:

- **Repository:** `mmwarren210/claude-ap`
- **Branch:** `claude/ace-v1-audit-q8xcb6`
- **Folder:** `ace-v1-audit/`
  - `ACE_V1_INDEPENDENT_AUDIT.md`: the full report. Findings F1–F15 and G1–G10, test-quality notes T1–T5, a requirement matrix, and the fix order.
  - `probes/probes.test.ts.txt` and `probes/pg.test.ts.txt`: reproduction tests.
  - `probes/README.md`: how to install and run them.

Fetch it without merging it into ace-v1:

```bash
git clone --branch claude/ace-v1-audit-q8xcb6 --depth 1 https://github.com/mmwarren210/claude-ap /tmp/ace-audit
# audit files are in /tmp/ace-audit/ace-v1-audit/
```

**Verdict:** ready to merge only after the listed fixes. Not ready for live publishing or Auto Mode. Your 81/81 test claim and CI runs were independently confirmed.

## Rules

- Work only on `codex/ace-v1-full-build` in `mmwarren210/ace-v1`.
- Do not touch `main` or `codex/core-brain`.
- Do not merge anything from `claude-ap`.
- Do not enable publishing or Auto Mode, connect accounts, or spend provider credits.

## First step

Install the probes as described in `probes/README.md`, under `.audit-probes/` in ace-v1. Run them. All should pass now, which means each bug is present.

## Fix order

Details, file/line references and the regression test for each item are in the report.

### P0 — before merge

1. **F1:** Scripts may speak only claims from a verified, corroborated important group. Enforce this at draft, QC and publish. Non-important, stale or low-confidence evidence must never be narrated.
2. **F2:** Remove unverified headline (`project.title`) interpolation from the hook, cold_open and context templates.
3. **F3:** Detect numeric, unit and negation conflicts independently of word overlap.
4. **F4:** Group sources by registrable domain (Public Suffix List) plus a publisher alias map.
5. **F5:** Upsert platform connections by (channel, destination, account). The newest connection wins. Add a disconnect endpoint.
6. **F8:** Require the owner token, or a Host/Origin allow-list, for all `/v1` state-changing routes.
7. **T1/G2:** Rewrite `tests/auto-mode.test.ts` using real QC and approval flows. Then do one of these:
   - implement Auto approval with the same gates, or
   - remove the dead `awaiting_approval` path and document Auto Mode as "scheduled dispatch of owner-approved projects".

### P1 — before any live account

8. **F6/F7:**
   - non-blocking advisory-lock acquisition;
   - pool connection timeouts;
   - transaction-pooler detection.
9. **F9 + G4:**
   - per-platform duration, size and metadata limits in QC and before upload;
   - plan narration to the target duration.
10. **G1:**
    - add a primary/official research adapter so "verified" is reachable without fixtures;
    - replace constant discovery priors with measured or explicitly unknown values.
11. **F10, F11, F12, F13.**
12. Tests for all workers, a TikTok status poller, and scheduler definitions for the workers.

### P2 — product completion

13. **G3:**
    - learned hook, tone, duration and style must drive script and production choices;
    - run the pattern recompute after analytics ingestion;
    - add variant assignment for experiments.
14. **G5:** an orchestration worker that takes a verified topic to `awaiting_approval`.
15. **G6, G7, G10, F14, F15.**

## Process

- After each fix, invert the matching probe's assertions and move it into `tests/` as a permanent regression test. Delete `.audit-probes/` before committing.
- Run the full suite with `DATABASE_URL`, `ACE_RENDER_INTEGRATION=1` and `ACE_VOICE_INTEGRATION=1`.
- Also run lint, typecheck, build and `audit:acceptance`.
- Update the README and reports so they don't overstate status. See report sections 3 and 5 (T3).
- Report back with:
  - the commit SHA;
  - probe results before and after;
  - the CI run link for re-audit.
