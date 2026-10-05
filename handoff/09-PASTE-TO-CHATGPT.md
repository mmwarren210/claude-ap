# CrownIQ catch-up: prompt for ChatGPT (handoff 09)

Paste everything below the line into ChatGPT. It covers everything built in `mmwarren210/claude-ap` since handoff 07.
It is a spec, not a patch: the must-haves are fixed, and ChatGPT builds the rest its own way. When it is done, bring
back the PR link, and Claude audits it against this list.

---

You maintain `mmwarren210/crowniq-ai`, a version of **CrownIQ**, a pick'em research app (the name is CrownIQ, never
"CrownIQ AI"). The main codebase has added the features below since the last handoff (fixes B1–B5). Bring your repo up
to them. **Must-haves** are requirements. **Suggestions** are how the main codebase did it: follow them or build it your
own way, as long as the must-haves hold. Work in small PRs, one section per PR, with tests.

## Ground rules (apply to every section)

1. **No secrets in code, logs or chat.** Keys come only from environment variables. Never print or return a key, token
   or password, not even in an error.
2. **GKR scores change only with the owner's approval**, and each change ships as a new, opt-in model version. Nothing in
   sections 4–9 below may change a GKR score. Each one is display-only or kept in its own record.
3. **Fail closed.** When a source can't be read with certainty (a name, team, number, side or start time), skip the row
   and count why. Never guess a line or a result.
4. **Started games are frozen.** Never update or newly show a line or pick after its game starts.
5. **Plain words on screen.** Short sentences, no jargon, written for someone who reads slowly.
6. Run your typecheck, tests and lint before every push.

## 1. Line sources and the scraper budget

Must-haves:
- PrizePicks lines come from **The Odds API** as the main source. Apify scrapers (PrizePicks, Underdog, DraftKings Pick6)
  are helpers that confirm lines and fill gaps.
- **A partial source never clears other sources' lines.** When a pull covers only some leagues, or fails partway, a line
  it didn't list stays. A source removes only lines it listed before and no longer lists. A line is gone only when no
  source still confirms it. Keep an admin undo route that restores lines removed since a given time.
- **Merge rule:** each field keeps the newest value any source supplied, and never a blank over a value. A moved number
  replaces the old one. A second source reporting the same line confirms it.
- **Scraper spend cap per Eastern day** (midnight to midnight America/New_York): $25 by default, set by an environment
  variable. A run starts only if at least $5 is left. Save the counter to disk, so a restart or two overlapping
  deployments can't reset it or double-spend. When the account's real Apify spend since midnight Eastern is available,
  count the higher of real and local.
- **Never repeat a scheduled pull** after a restart or an overlapping deploy (a saved "last pulled" marker per slot).
- Pulls run at 9 AM, 12 PM, 3 PM and 6 PM Eastern (Pinnacle context included). Avoid deploying at those hours.

Suggestions: an admin route that reads The Odds API's remaining credits with a free call; an admin route to run one
source pull by hand.

## 2. Payouts and break-evens per app

Must-haves:
- A payout table per app (PrizePicks, Underdog, Pick6) for Power and Flex, by number of picks and number of hits. The
  owner can override any part with an environment variable (JSON, merged over the defaults one pick count at a time).
  Defaults:

| App | Power (all hit) | Flex |
|---|---|---|
| PrizePicks | 2: 3x, 3: 5x, 4: 10x, 5: 20x, 6: 37.5x | 3: 3/1x · 4: 6/1.5x · 5: 10/2/0.4x · 6: 25/2/0.4x |
| Underdog | 2: 3x, 3: 6x, 4: 10x, 5: 20x, 6: 37.5x | 3: 3/1x · 4: 6/1.5x · 5: 10/2.5x · 6: 25/2.6/0.25x |
| Pick6 | 2: 3x, 3: 5x, 4: 10x, 5: 20x, 6: 40x | none |

(For Flex, the numbers are what all-hit, one-miss and two-miss entries pay.)
- **Break-even** per entry type is the per-pick hit rate where the expected return equals 1 (solve by bisection on the
  binomial return). Show the lowest one per app ("needs 54.2% per pick") and use it as the bar for "worth playing".
- Serve the table at `GET /v1/payouts`. Break-even math is shown first; Scout (section 5) comes second.

## 3. Boards, tabs and slips

Must-haves:
- **Board tabs:** PrizePicks, Underdog, Pick6, DraftKings, Hard Rock, Kalshi, Polymarket. Use a board picker with
  league chips (no dropdown arrows).
- **Show plays only.** A PASS is never shown on any board. Show one card per player; the player page has a stat picker
  for that player's other lines.
- **Goblins and Demons are MORE only.** Never offer LESS on them.
- **Slip builder on every board.** Pick legs, see the payout and break-even for that app, then port the slip:
  copy it to the clipboard and open the app (PrizePicks, Underdog, Pick6 by deep link or web URL). For the sportsbooks
  and prediction markets, copy the picks and open the site. Never place a bet or log in for the user.
- **Pick6 promos:** read Pick6's boosted payouts, "gimme" lines and promo lines from the scraper (`is_gimme`,
  `original_line`) and tag them on cards (BOOST / GIMME / PROMO), with a Boosted filter.
- Game times sit on their own row on app-board cards. Tell users that lines can move near game time.

## 4. Sportsbook tabs: DraftKings and Hard Rock

Must-haves:
- Prices come from a sportsbook prop feed (the main codebase uses SharpAPI) as no-vig fair chances. DraftKings has the
  main line only. Hard Rock posts alternate ladders.
- **Each book's main line** per player and stat is the number whose no-vig chance is closest to 50/50. Never put the
  easiest number on a ladder on the tab.
- **Tab picks** are GKR scored at the book's own number, on the research for the same player and stat on the PrizePicks
  board. Keep only lines where GKR picks a side, one per player and stat (the highest score), strongest first.
- **Pricey label:** when a book's price needs a 60% or higher win rate to break even, label the pick "pricey". Still
  show it.
- **Check a lower or higher line:** on the player page, list the books' numbers near the PrizePicks line, each scored by
  GKR. When an easier number exists, tag it: "check lower line" for a MORE, "check higher line" for a LESS. When Hard
  Rock has a ladder there, tag DraftKings too (DraftKings usually offers alternate lines as well).
- When PrizePicks passes the same player and stat, say why in plain words (for example: no model for this stat, or
  stale data).
- **Books picks** (shadow only): on a standard line GKR couldn't score, the side DraftKings and Hard Rock back, at a
  no-vig chance of 56% or more. Leave out Goblins and Demons.
- **Books agree badge:** on GKR cards, show whether the books' no-vig view agrees with GKR's side. This is display
  only. Keep an hourly history of what the books said about each board line.

## 5. Scout (ChatGPT plus Claude research)

Must-haves:
- Scout is the name on screen, never "AI". Both models research a line on the web and answer MORE, LESS or PASS with
  0–100 confidence, a two-sentence summary, up to four reasons and late news. Each reason is tagged with its evidence
  kind: matchup, recent_form, history, injury_news, role, market or other. Use strict JSON / strict tools.
- **Fail closed:** an unknown side, a side the line doesn't offer, or confidence under 55 is a PASS. Keep a reason's link
  only if it is a page the model's own searches returned.
- **Combining the two models:** both on one side means that side at their average confidence. One side plus one PASS
  means that side, minus 10. Opposite sides, or both PASS, means PASS. A combined score under 55 is a PASS.
- **Late news:** drop a late-news line that only says there is no news ("No injury designation…", "I did not find…").
  Keep it when it names news after a "but".
- **Which lines:** Scout reads lines GKR can't score (no model for the stat, or missing or stale data), never a line
  GKR passed on the merits. Most valuable first: major leagues' full-game stats come first; fantasy, single-map and
  partial-game props come last. One line per player. Games start between 15 minutes and 12 hours from now.
- **Caps** (environment variables): 350 reads a day, 20 per run; Ask Scout 15 per user per day. Second opinions:
  150 a day, 12 per run. Count only answered lines against a cap. Stop a run after three failures in a row.
- **Second opinions:** Scout also reads GKR's Top Picks, the strongest DraftKings and Hard Rock tab picks (top 6) and the
  strongest Kalshi and Polymarket picks (top 3), **without being told GKR's pick**. Show the result as agrees,
  disagrees or no edge, plus late news.
- **Evidence goes under the player profile** on every board, PrizePicks included, grouped by kind (matchup strength,
  recent form, history and the rest), with source links.
- **Scout's own record:** grade Scout's reads apart from GKR's. Track GKR's hit rate when Scout agreed, disagreed or saw
  no edge.
- **Tennis and esports go through Scout** (no new stat source). With no box score to grade from, both models look up
  the final number with a source page, and both must find the same number (or both a DNP). Otherwise the read waits
  and is retried after 6 hours at most. Anything still ungraded four days after the game is void. Cap: 60 lookups a
  day, 10 per hourly run. Never give the models the line's number when asking for a result.

## 6. GKR Beta (GKR plus Scout)

Must-haves:
- Beta is its own model version (`<GKR version>+SCOUT-BETA-0.1`), shown only to lifetime members (the owner and
  family). Everyone else sees GKR only. The board, Top Picks and Crowns stay on GKR.
- **Late news** (out, scratched, benched, inactive, not starting) makes Beta pass the line.
- When both models land on a side **and** their reasons include matchup, role or injury news, move GKR's score toward
  them by up to 8 points: up when they back GKR's side, down when they oppose it. Recent form and history alone move
  nothing, because GKR already measures them.
- Beta never turns a GKR pass into a play.
- **Display:** there is no switch. On cards and player pages, show "GKR 82 · Beta 90" where the two differ, and only the
  GKR score where they match. When Beta passes on late news, keep the card and add a gold line "Beta passes: …".
- Keep Beta's record in Results (see section 7).

## 7. Shadow records and grading

Must-haves (nothing here changes a GKR score or enters GKR's record):
- Shadow kinds, each graded in its own record:
  - `books`: Books picks.
  - `book:draftkings` and `book:hardrock`: the sportsbook tab picks.
  - `gkr` and `beta`: the same lines, graded the same way, so the two compare fairly.
  - `beta-pass`: GKR plays that Beta passed, graded on GKR's side.
  - `script`: a GKR decision with the game's expected script saved beside it (favorite, margin, total, from Pinnacle
    and the prediction markets).

  Save entries every 15 minutes, before the game starts. Grade them hourly.
- **Grade every sport** that has box scores (NFL, college football, NBA, WNBA, NHL, MLB, soccer): ESPN summaries, and
  the MLB Stats API for baseball. A player who didn't play is DNP, not zero. Quarter, half and map splits are not
  graded from full-game box scores. For a quarterback, "sacks" means sacks taken; for a defender, sacks made.
- **Shared names** (two Max Muncys): when two players with the same name appear in one game or roster, keep only the
  one on the line's team. When the line has no team, match neither.
- Kalshi and Polymarket picks get their own record (section 8).

## 8. Kalshi and Polymarket tabs

Must-haves:
- Read live prices from the free public APIs: Kalshi's trade API events with nested markets (the yes ask is the price),
  and Polymarket's Gamma events (outcomes and prices are JSON strings). Pinnacle's no-vig price for the same game and
  number is the fair chance.
- Show a side only when its cost (price plus fee) is at least 2 points below Pinnacle's fair chance. Kalshi's fee per
  contract is `ceil(0.07 × p × (1 − p))` to the cent. Polymarket has no fee. Winner and spread markets only: exclude
  first-half, quarter and other partial-game markets. Match teams by nickname or by city.
- Grade from ESPN's final scores: a winner pick on the winner, a spread pick with its handicap. Score the result per $1
  at the price shown. Void after 4 days with no result.

## 9. History archive

Must-haves:
- CrownIQ keeps its own append-only archive for later verification and evidence. Three streams: player game logs
  fetched, final results graded, and lines seen (each move included). JSON lines, one file per stream per month. The
  month is taken when a record is handed over, not when it is written.
- Never write a record twice: dedupe by key within a batch and across restarts (on startup, read back the keys already
  in this month's file). Archive writes are best effort and never break the caller. Nothing reads the archive for
  scoring.
- Add an admin route showing files and sizes per stream.

## 10. Accounts and membership

Must-haves:
- Sign in with email or username. Web sign-in lasts until Log Out.
- **Seats:** 20 lifetime family members plus 100 members (120 in all). Lifetime members don't count toward the 100.
  Guests and suspended accounts don't take a seat. When the seats are full, refuse sign-up with `MEMBERS_FULL` (or
  `LIFETIME_FULL` for family).
- **Family sign-up:** a family member signs up normally, using the family code as their first password. The code lives
  only in an environment variable (`CROWNIQ_FAMILY_CODE`), never in code, tests or docs. That marks the account lifetime
  and sends them to a "set your own password" step before anything else.
- **Membership keys for the 100 members are not built yet.** The owner will decide in about two weeks. Leave room for
  them; don't build them.
- **Change password** in More. The current password is required, and the new one can't be the old one or the family
  code.
- **Forgot password:** the owner makes a one-time reset code for a member: format `XXXX-XXXX`, valid for 24 hours,
  stored only as a hash. The member enters it with a new password. A reset ends all that member's sessions. There is
  no email reset. Codes come from the owner, to keep profiles private.
- **Delete account:** the member confirms with their password (or types DELETE if the account has none). Remove their profile and sessions. Keep anonymous pick
  records only if they hold no personal data.
- **Guest link:** four testers, no username, three days each. A demo link (`?demo`) shows sample picks.

## 11. Reliability

Must-haves:
- A background task can never crash the server. Catch every rejection in timers.
- **GKR plays survive restarts and the gaps between pulls.** Keep context and status evidence for a 72-hour window, so
  a play doesn't drop when its 30-minute status evidence refreshes. Check this in every sport, not only NFL.
- Admin routes are protected. Health is public liveness only, with no operating detail.

## When you're done

Reply with:
- the PR links, one per section;
- any must-have you couldn't meet, and why;
- anything you built differently from the suggestions.
