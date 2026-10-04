# CrownIQ: working rules

- **This repo (`mmwarren210/claude-ap`) is the primary CrownIQ codebase.** All new work happens here.
- **Do everything here yourself.** ChatGPT maintains `mmwarren210/crowniq-ai`. It receives work from this repo
  as handoffs (prompt plus patch in `handoff/`), but its code is never copied back here. That repo may be read
  only to audit what ChatGPT did, and is never modified unless the owner asks.
- **GKR scores every line it has history for** (owner, 2026-10-04: "GKR should score everything"): PrizePicks,
  plus Underdog and DraftKings Pick6 lines through the same models (`CROWNIQ_APP_GKR_SCORES`). Models come in opt-in
  sets: `GKR_MODEL_PRESET=stat_history_v2` adds 59 stats (Stat API for MLB/NFL, ESPN game logs for NHL, soccer,
  college football) to the v1 set. Every model keeps a hard status gate (lineup, probable starter, active player).
  Betr and Dabble come later. See `docs/DFS_APPS_PLAN.md` and `docs/PROPOSAL_APP_SCORING.md`.
- **Anything that changes model scores needs the owner's explicit approval** and ships as new, opt-in model
  versions. Identity and web findings are display-only and never feed GKR. Exception (owner, 2026-10-04): **AI reads**,
  where ChatGPT and Claude give MORE/LESS/PASS with a 0-100 score on lines GKR can't score, shown as their own labeled
  score, graded in their own record, never mixed into GKR (`ai-picks.ts`; `CROWNIQ_AI_PICKS_DAILY` caps the spend).

## Checks

Run from the repo root: `npm run typecheck`, `npm test`, `npm run lint`. Tests use `node --import tsx --test`.

## Deploys

Railway does not deploy pushes on its own. After pushing to `claude/crowniq-redesign`, run `scripts/railway-deploy.sh`
and confirm it ends with a healthy `/health` (see `docs/DEPLOY.md`).
