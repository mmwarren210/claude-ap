# CrownIQ: working rules

- **This repo (`mmwarren210/claude-ap`) is the primary CrownIQ codebase.** All new work happens here.
- **Do everything here yourself.** ChatGPT maintains `mmwarren210/crowniq-ai`. It receives work from this repo
  as handoffs (prompt plus patch in `handoff/`), but its code is never copied back here. That repo may be read
  only to audit what ChatGPT did, and is never modified unless the owner asks.
- **Lines come from PrizePicks only for now** (The Odds API). Underdog, DraftKings Pick6, Betr and Dabble come
  after the PrizePicks groundwork is done; see `docs/DFS_APPS_PLAN.md`.
- **Anything that changes model scores needs the owner's explicit approval** and ships as new, opt-in model
  versions. Identity and web findings are display-only and never scored.

## Checks

Run from the repo root: `npm run typecheck`, `npm test`, `npm run lint`. Tests use `node --import tsx --test`.
