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
- **Beta** (owner, 2026-10-05): CrownIQ is labeled BETA (header badge, sign-in note, link preview); family members
  are the testers. **Beta feedback** (More → Beta feedback; `feedback.ts`, `/v1/feedback`, `/v1/updates`): testers report
  bugs and suggestions; twice a day they're reviewed (`/v1/admin/feedback`, or More → Review feedback for the owner):
  fix, plan or decline with a reply, then post patch notes (`/v1/admin/updates`) linking the reports they answer.
  Fixes that change model scores still need the owner's approval.
- **Logo**: the CrownIQ icon (gold crown, dripping CrownIQ, POWERED BY GKR) is the home-screen icon, favicon, sign-in
  logo and link preview (`public/og.png`); the header uses its crown (`assets/images/crown.png`).
- **Free public history** (owner, 2026-10-05; `player-history.ts`): each player's last 15-20 matches from ESPN tennis
  scoreboards (games won, total games, sets, first set; refreshed every 12 h), OpenDota (Dota 2 tournament maps: kills,
  deaths, assists, last hits), Leaguepedia (LoL pro games; often rate-limited from Railway) and Sleeper's recent performance
  (Apify `solidcode/sleeper-player-props-scraper`, CS2 and tennis, the last ~10 results for each line's exact stat; about a
  cent a run, twice a day, under the scraper cap; `CROWNIQ_SLEEPER_HISTORY=false` turns it off). Scout gets them as facts in every question; the cards'
  game log falls back to them; the games go to the archive. No GKR score uses them (that needs a new opt-in model).
- **Stat-history set 3** (owner approved 2026-10-05: "if Sleeper is giving all that, use it for scoring"): GKR scores
  CS2 (kills and headshots, maps 1+2) and tennis (games won, total games, aces, double faults, break points) from player
  history (`free-history-evidence.ts`: projection, recent form, stability). On with GKR_MODEL_PRESET=stat_history_v2
  unless GKR_SH3=false. It replaces two unapproved placeholders (CS2 maps_1_2_kills, TENNIS total_games) only when
  approved; nothing gates these sports on availability (no source exists).
- **Scout's info pool** (owner, 2026-10-05): every Scout read (both models' picks, confidence, summaries, reasons with
  evidence kind and source, late news) and its grade go to the archive's `scout` stream for good; a result Scout looked
  up (tennis, esports) also joins the `results` stream as a player stat. Saved reads are backfilled at startup.
- **History Read** (owner, 2026-10-05; `history-read.ts`): a free More/Less on every line GKR doesn't play, from the
  player's last 15 results for the stat (CrownIQ history, then the free public sources): over rate with one game of
  doubt each way, averaged with the books' no-vig chance when priced; a play needs 60% (Goblin 72%, Demon 55%) and the
  average on the same side; 55-59% (Goblin 66-71%) shows as a LEAN (not recorded, Scout may still read it); under 5 games
  is no read. Lookups: CrownIQ history, stored Stat API rows (MLB/NBA/NFL stats without an internal spec), ESPN game logs
  (soccer, NHL, college football), then ESPN tennis/Sleeper/OpenDota. The board gets the last set while a new one builds. Labeled "History", never a GKR score; graded as shadow kind
  `history` (shown in Results' Beta box). Board order where GKR can't score: Scout, History, Books. Scout's scheduled
  run, its app-line extras and the owner's Scout queue skip lines a History Read already picks.
- **Scout queue** (owner, 2026-10-05): More → Scout queue shows lines waiting on Scout by board and sport, with Ask
  all / by board / by sport (`/v1/owner/scout-queue`; 300 a day, `CROWNIQ_SCOUT_OWNER_DAILY`; two at a time). Answers
  show on the boards at once. The refresh banner was removed (owner: it popped up too often); `/v1/data-version` stays
  for later use.
- **Scout reads app-only lines** (owner, 2026-10-05): Underdog and Pick6 lines for players PrizePicks doesn't list
  (no GKR research) go to Scout's scheduled run after the PrizePicks lines, under the same caps. The app boards show
  Scout's side and score ("Scout 61 · Less"), and the Picks filter includes them after GKR's.
- **Tennis and esports go through Scout** (owner, 2026-10-05: "use Scout, that's what it's for"): no new stat source.
  Scout reads those lines like any line GKR can't score, and grades them itself: with no box score, both models look up
  the final number with a source page and must agree (`settleResult`); otherwise it waits, and is void four days on.
  60 lookups a day, 10 per hourly run (`CROWNIQ_SCOUT_RESULTS_DAILY`, `CROWNIQ_SCOUT_RESULTS_PER_RUN`).
- **Shared names** (two Max Muncys): grading and ESPN rosters keep only the namesake on the line's team (`sharedName`);
  with no team on the line, nothing is matched. The Stat API adapter already did this.
- **Sign-up is locked** (owner, 2026-10-05): new accounts need a code. The family code unlocks sign-up (and makes the
  account lifetime); without it, register and new Google/Apple sign-ins fail with SIGNUP_CLOSED and the screen says to
  contact the owner for a subscription code (`CROWNIQ_SIGNUP_CONTACT` adds how). `CROWNIQ_SIGNUP_OPEN=true` reopens it.
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
- **Research reach (2026-10-05).** The paid Stat API also runs in the 15-minute research loop (`stat-api-context.ts`):
  games starting within 36 hours, soonest first, at most 300 players per run, each player at most every 6 hours
  (`CROWNIQ_STAT_CONTEXT*` variables; `CROWNIQ_STAT_CONTEXT=false` turns it off). Its daily record count is saved to
  `stat-api-usage.json`, so restarts don't reset it. ESPN research goes soonest game first, up to 1500 players
  (`GKR_ESPN_MAX_PLAYERS`). The `[gkr-coverage]` log splits missing-evidence passes into "no projection" and "has
  projection, waiting on status". None of this changes model math; lineup and injury gates stay.
- **Per-app Crowns, line shop, our own hit rates (2026-10-05).** The Crown tab's "Play on" picker builds Underdog and
  Pick6 Crowns from that app's own lines (`AppCrown.tsx`, `app-lines.ts` `backing`: GKR 80+, then Scout plays, then
  History plays; no Goblins/Demons there). Line shop (`line-shop.ts`, `/v1/line-shop`, Board → "Line shop" chip and the
  player screen): each app's number for the same player and stat, the easiest number per side, the books' line, and
  where GKR's (or History's) side is easiest. Our own hit rates: `base-rates.ts` grades every standard PrizePicks line
  after its game; a side that hit 57%+ over 60+ lines at that number (or 150+ across the stat) shows as a **Trend**
  (amber, never auto-picked, recorded as shadow kind `trend`). `/v1/hit-rates` gives each source's graded record by
  sport and stat; cards show "Our record" once 10+ picks are graded. All display only; no score changes.
- **Sportsbook and prediction-market expansion (2026-10-05).** SharpAPI (`context/sharp-props.ts`, hourly) now pulls
  tennis (ATP/WTA) and eight soccer leagues besides the US leagues, more MLB/NHL stats, Kalshi's over-only player props
  (`overOnly`) and every book's full-game winner/spread/total lines (`games`; NCAAB and UFC game lines too). Books default
  to DraftKings, Hard Rock, Kalshi, FanDuel, Polymarket (`CROWNIQ_SHARP_BOOKS`; ones the plan hasn't selected are
  skipped). DK/HR tabs (`book-picks.ts`): GKR first, then the **History Read at the book's number** (same lookups as
  every tab, blended with that book's no-vig), then **Value** (price needs 3%+ less than the other book's fair chance);
  players off PrizePicks get synthetic lines so History still reads them; graded as shadow kinds `book-history` /
  `book-value`. Kalshi/Polymarket (`exchange-picks.ts`): exchange game lines vs the books' no-vig (3%+ edge, 15–85¢),
  Kalshi props vs the books (3%+) or History alone (6%+, dropped when History says Less; matched to the player's real
  next game because Kalshi stamps props with the close date; 20–85¢), and the books' consensus fills in for Pinnacle when
  it's stale or lacks the game. Totals are graded from final scores; props stay out of the market record. Soccer winners
  are skipped (draws). Team names match via `team-match.ts`. Display only; no GKR score changes.
- **+EV everywhere and Top Picks "Every app" (2026-10-05).** `/v1/ev` covers PrizePicks, Underdog and DK Pick'em at each
  app's own easiest break-even (a boosted pick's own payout lowers its bar; cut picks under 0.95x are left out). Books'
  chance: the same number, else estimated between two numbers a book prices (≤3 apart), else a one-sided floor from a
  harder number (≤2 away) (`chanceAt` in `context/ev.ts`; `bookViews(..., nearby)` stays exact for Books picks). Each
  +EV pick carries the History Read on the same line ("History agrees/disagrees"). Top Picks opens on **Every app**
  (`AllPicks.tsx`, `all-picks.ts` `rankAll`): PrizePicks GKR/Scout/History, Underdog and DK Pick'em backed lines,
  DraftKings/Hard Rock GKR/History/Value picks, and Kalshi/Polymarket edges in one list with board chips.
