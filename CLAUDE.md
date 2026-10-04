# CrownIQ: working rules

- **This repo (`mmwarren210/claude-ap`) is the primary CrownIQ codebase.** All new work happens here.
- **Do everything here yourself.** ChatGPT maintains `mmwarren210/crowniq-ai`. It receives work from this repo
  as handoffs (prompt plus patch in `handoff/`), but its code is never copied back here. That repo may be read
  only to audit what ChatGPT did, and is never modified unless the owner asks.
- **GKR scores PrizePicks lines only.** Underdog and DraftKings Pick6 boards are live (owner, 2026-10-04): their own
  lines for picking and line shopping, saved as the user's own slips and graded, with the same PrizePicks line and its
  GKR score shown for reference. Scoring other apps' lines needs the owner's approval; Betr and Dabble come later.
  See `docs/DFS_APPS_PLAN.md`.
- **Anything that changes model scores needs the owner's explicit approval** and ships as new, opt-in model
  versions. Identity and web findings are display-only and never scored.

## Checks

Run from the repo root: `npm run typecheck`, `npm test`, `npm run lint`. Tests use `node --import tsx --test`.

## Deploys

Railway does not deploy pushes on its own. After pushing to `claude/crowniq-redesign`, run `scripts/railway-deploy.sh`
and confirm it ends with a healthy `/health` (see `docs/DEPLOY.md`).
