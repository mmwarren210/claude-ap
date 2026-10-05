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
  shown in the app as **Scout** (never "AI"; the name lives in `SCOUT` in `use-ai-picks.ts`), where ChatGPT and Claude give MORE/LESS/PASS with a 0-100 score on lines GKR can't score, shown as their own labeled
  score, graded in their own record, never mixed into GKR (`ai-picks.ts`; `CROWNIQ_AI_PICKS_DAILY` caps the spend: 350 a day, 20 per 30-minute run, set 2026-10-05).
  Scout also gives **second opinions** on GKR Top Picks (owner, 2026-10-05): researched without seeing GKR's pick, shown
  as agrees/disagrees/no edge plus late news, never changing the GKR score (`CROWNIQ_SCOUT_SECOND_DAILY`, default 40).
  `/admin/ai-picks` tracks GKR's hit rate by verdict; blending Scout into GKR would need a new opt-in model version.
  Scout second opinions also cover the strongest DraftKings, Hard Rock, Kalshi and Polymarket tab picks (same caps).
- **No AI product names on screen** (owner, 2026-10-05): the two research models show as **Scout A** and **Scout B**
  (`providerName`), and `unbrand` replaces any product name inside their text. Their prompt says never to name one.
- **Tennis and esports go through Scout** (owner, 2026-10-05: "use Scout, that's what it's for"): no new stat source.
  Scout reads those lines like any line GKR can't score, and grades them itself: with no box score, both models look up
  the final number with a source page and must agree (`settleResult`); otherwise it waits, and is void four days on.
  60 lookups a day, 10 per hourly run (`CROWNIQ_SCOUT_RESULTS_DAILY`, `CROWNIQ_SCOUT_RESULTS_PER_RUN`).
- **Shared names** (two Max Muncys): grading and ESPN rosters keep only the namesake on the line's team (`sharedName`);
  with no team on the line, nothing is matched. The Stat API adapter already did this.
- **Revoke access** (owner, 2026-10-05): More → Member access lists every account with Revoke/Restore
  (`/v1/owner/members`, `/v1/owner/members/access`). Revoked accounts are signed out at once, can't sign in or reset,
  and free a member seat; restoring a member needs a free seat. The owner can't revoke themselves.
- **Public address: https://crowniq.up.railway.app** (owner, 2026-10-05). The old `claude-ap-production` address is
  turned off. Admin curls and the deploy live check need `crowniq.up.railway.app` allowed in the session environment's
  network settings (and the admin token injected for it); until then deploy with `CROWNIQ_SKIP_LIVE_CHECK=1`.
  Other Railway names stay as they are (users don't see them).
- **GKR 80 and up is a play** (owner, 2026-10-05): Crown legs need 80 at every size (was 88/86/84/82/80), and GKR's
  tracked record saves picks from 80 (`CROWNIQ_AUTO_TRACK_MIN_BAND` default PLAYABLE). Ranking stays by score. Scout's
  own scale (55 and up) is unchanged.
- **Membership keys** for the 100 members: the owner said wait two weeks (from 2026-10-05).
- **GKR Beta** (owner, 2026-10-05; `scout-beta.ts`): GKR plus Scout's research as its own model version
  (`+SCOUT-BETA-0.1`). Late news (out, benched, scratched) passes a line; both models agreeing on matchup, role or
  injury news moves the score up to 8; form and history alone move nothing; Beta never plays a GKR pass. Lifetime members
  see "GKR 82 · Beta 90" (or "Beta passes: …") on cards and player pages where the two differ; the board, Top Picks and
  Crown stay on GKR. Everyone else sees GKR only. Graded as `gkr`,
  `beta` and `beta-pass` in the shadow record and shown in Results. Scout second opinions: 150 a day, 12 per run.
- **Context refresh window is 72 hours** (`CROWNIQ_CONTEXT_WINDOW_HOURS`): player-status findings last 30 minutes, so
  every game on the board must be in the 15-minute refresh, or its GKR plays drop half an hour after a full pull or a
  restart.
- **Market picks record** (`market-record.ts`): Kalshi and Polymarket picks are saved before their games and graded
  from ESPN final scores (spreads with their handicap), scored per $1 at the price shown; shown on each market tab.
- **History archive** (`history-archive.ts`, `$CROWNIQ_DATA_DIR/archive/`): every ESPN game log fetched (all sports),
  every graded box-score result and every line seen with its moves, append-only JSON lines by month, for built-in
  verification and evidence later. Not read for scoring. `/admin/history` shows it with the other stores.
- **Members** (owner, 2026-10-05): 20 lifetime family seats plus 100 members, 120 in all (`CROWNIQ_MAX_MEMBERS`).
  A family member signs up normally with the family code as the first password (`CROWNIQ_FAMILY_CODE`, Railway
  Variables only, never in the repo), then must set their own. Member keys for the other 100 come later. Guests and
  suspended accounts take no seat; `/admin/members` shows counts.
- **Shadow records** (owner, 2026-10-05; `shadow-record.ts`, `/admin/shadow`): Books picks, sportsbook-tab picks and
  game-script snapshots, graded in their own record. Display and tracking only; never GKR's record.

## Checks

Run from the repo root: `npm run typecheck`, `npm test`, `npm run lint`. Tests use `node --import tsx --test`.

## Deploys

Railway does not deploy pushes on its own. After pushing to `claude/crowniq-redesign`, run `scripts/railway-deploy.sh`
and confirm it ends with a healthy `/health` (see `docs/DEPLOY.md`).
