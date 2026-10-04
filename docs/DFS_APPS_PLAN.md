# DFS apps roadmap

Owner decision (October 2026): CrownIQ will support these DFS apps, in addition to PrizePicks:

1. **Underdog Fantasy**
2. **DraftKings Pick6**
3. **Betr Picks**
4. **Dabble**

## Data sources (to confirm before building)

| App | Source | Notes |
| --- | --- | --- |
| PrizePicks | The Odds API, `prizepicks` (us_dfs) | In use today. |
| DraftKings Pick6 | The Odds API, `pick6` (us_dfs) | Listed on The Odds API bookmaker page. |
| Betr Picks | The Odds API, `betr_us_dfs` (us_dfs) | Listed on The Odds API bookmaker page. |
| Underdog Fantasy | Not confirmed on The Odds API | Check its bookmaker list; otherwise a licensed feed. |
| Dabble | Not on The Odds API | Candidates: Betstamp dabble odds feed (REST/SSE, props and alternates), OpticOdds, SportsGameOdds. Needs pricing, terms and a sample payload. |

Only licensed or official feeds; no scraping of the apps themselves.

## Work needed

- Contracts: `provider` accepts any supported app; every line keeps its app.
- Per-app line-type and payout rules (Goblin/Demon are PrizePicks only).
- Board app filter; a Crown holds legs from one app only.
- One fetch adapter per source, each behind the existing paid-pull confirmation and job lock.

## Player identity layer (built)

Every line, from any line source, goes through one identity layer (`apps/api/src/identity/`) that
attaches the player's team and headshot. It is display data only: the engine never scores it.

- **Sources, in fallback order** (`identitySources` in `apps/api/src/main.ts`): Sleeper (NFL), then ESPN public
  team rosters (NFL, college football, MLB, NBA, WNBA, NHL, and the soccer leagues mapped in `espn-rosters.ts`).
- **Matching:** a player is looked up only on the two teams in their game, and a team is kept only if it is
  one of the game's own sides. When a name still matches two people, nothing is attached.
- **Not yet covered:** individual sports (tennis, darts, table tennis, badminton), esports, KBO, AFL and
  handball. They need a source; adding one needs no other change.
- **Adding an API or scraper:** implement `PlayerIdentitySource` (`identity/types.ts`): `supports(target)` and
  `resolve(target)` returning `{team, photoUrl, sourceName, sourceUrl, sourceType, confidence}`, null when not
  found or ambiguous, and throwing only on an outage. Add it to `identitySources`. Health per source shows up
  in research status under its `id`. When two sources name a photo or team, the higher `confidence` wins.
- **New line sources** (Underdog, Pick6, Betr, Dabble) get identity for free, provided their adapter sets
  `homeTeam`, `awayTeam` and, for soccer, `sourceSportKey`.

## Scraper budget (owner decision, 2026-10-03)

- Up to **$2 per day per scraper**, about six scrapers (roughly $12/day, $360/month).
- Scrapers run on Apify and may stand in for a pricier licensed API. Several scrapers covering the same app back
  each other up: when sources disagree on a line, the app shows the line only where they agree or marks it unconfirmed.
- Each scraper gets its own adapter, its own daily spend cap and a run schedule sized to that cap.
- Scraping can break without notice and may conflict with an app's terms; each adapter must fail closed
  (no lines rather than stale or wrong ones).

## Refresh rules (owner decision, 2026-10-03)

- **Two scheduled pulls a day** per scraper. Each pull skips leagues and teams whose games have started.
- **A confirmed line is not pulled again.** It is re-pulled only when a major change hits that game: an injury or
  status change for a player in it, or a weather change, as reported by the free context refresh. That re-pull is
  limited to the affected teams.
- **One record per line** (app, player, stat, number, side); a second source confirms it rather than copying it, and a
  moved number replaces the old one.
- **Lines on started games are frozen and leave the board.**
- The app tells people lines can move near game time and to confirm the line in the app within an hour of the start;
  the user makes the final call on the presented line.

## First scraper measured (2026-10-03)

- `lergassy/dfs-props-scraper` (PrizePicks + Underdog): one full run returned 13,859 PrizePicks props across
  10 leagues and 276 Underdog props in about 2 minutes. At $0.10 per 1,000 props that is about $1.41 per run,
  about $2.82 a day at two pulls. **The owner approved that cost for this scraper** (above the $2 guideline).
- Its PrizePicks league index returned HTTP 403 and it fell back to a built-in league list, so it may miss new
  leagues: keep a second PrizePicks source as backup.
- 276 Underdog props looks partial; confirm against another Underdog source before relying on it.

## Chosen scrapers (owner, 2026-10-03)

| Apify actor | Apps | Status |
|---|---|---|
| `lergassy/dfs-props-scraper` | PrizePicks, Underdog | Full run OK: 13,859 PrizePicks + 276 Underdog props. Approved ~$2.82/day. |
| `crawloop/draftkings-pick6-scraper` | DraftKings Pick6 | Runs OK but Pick6 had no open props at test time (one MLB slate, 0 props). Retest when NFL slate is up. |

Needed before building each connector: the actor's input JSON (Input tab, JSON view) and a sample of its output rows.
`crawloop/prizepicks-player-props-scraper` was tried and returned 1 row for $0.105; not chosen.

## Pull schedule with two scrapers (owner, 2026-10-03)

With two scrapers instead of six, the extra budget goes to more pulls a day. Total cap: **$12/day**.

| Scraper | Pulls/day | Approx. cost/day |
|---|---|---|
| `lergassy/dfs-props-scraper` (~$1.41 per full board) | 4 (morning, midday, afternoon, early evening ET) | ~$5.60 at most; less as started games are skipped |
| `crawloop/draftkings-pick6-scraper` ($0.05/1,000 lines) | 6 (every ~2–3 h while slates are open) | under $1 |

- The CrownIQ server starts the runs (not Apify Schedules), so it can skip started games, confirmed lines and
  closed slates, and stop at each scraper's daily cap.
- Major-change re-pulls (injury, status, weather) count against the same daily cap.
- If a run returns nothing or errors, the next pull still happens; no lines are shown from a failed run.

## Next after scrapers (owner, 2026-10-03)

**Built (2026-10-04):** Claude runs as a second web-research provider next to ChatGPT (`claude-web-research.ts`,
`CombinedWebResearch`). With both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` on the server, an owner research run
searches with both; each keeps its own budget and catalog, findings stay display-only, and a finding both make
(same player, event, kind and source page) is shown once with "ChatGPT and Claude both found this."

## Built: PrizePicks lines from `lergassy/dfs-props-scraper` (2026-10-03)

Code in `apps/api/src/scrapers/`. Turn on with `ODDS_PROVIDER=scrapers` and `APIFY_TOKEN`.
- **Pulls:** 9, 12, 15 and 18 Eastern, capped at $6/day and $2.50/run, up to 20,000 rows (the first runs were cut
  off at 10,000 and lost NBA, NHL and others). A cut-short run is flagged and takes no lines down.
- **Store:** one record per app line id; moved numbers replace the old one (kept as `previousLine`); a second source
  reporting the same line adds a confirmation; started games are frozen; finished games drop after two days.
- **Board:** PrizePicks lines only (Underdog rows are stored for later). Stat labels map to model market keys
  (unmapped stats keep a plain key and simply have no model); NFL teams get full names; ids match the Odds API
  provider's so player history lines up. Player headshots come from the row (team logos excluded) or the identity layer.
- **Measured on the real 10,000-row run:** 9,614 lines kept (276 live Underdog rows and 110 multi-player combos
  skipped); 3,262 of 4,782 NFL lines and 672 of 1,616 MLB lines are on modeled markets.
- **Not yet:** Pick6 connector (its two test runs returned 0 props from open slates, which suggests the scraper is
  broken; retest Sunday); major-change re-pulls (the scraper has no team filter, so a re-pull is a full run).

## Sources after the live tests (2026-10-03)

| Source | Role | Live test | Schedule (ET) |
|---|---|---|---|
| `zen-studio/prizepicks-player-props` | Main PrizePicks source; no row cap; home/away teams; teams filter | 9,072 NFL lines for $0.20 ($0.05/1,000) | 9, 12, 15, 18 |
| `lergassy/dfs-props-scraper` | Confirms PrizePicks lines; actor caps at 20,000 rows / 20 leagues | 20,000 rows (cut off) for $1.80 | 12 |
| `zen-studio/underdog-player-props` | Underdog pregame board, stored for later | 4,935 NFL lines with payouts per side | 10, 17 |

Merged on real data: 8,885 PrizePicks lines confirmed by both PrizePicks sources, 6 with differing numbers
(newest wins, flagged), 19,036 PrizePicks lines on the board. Owner decision: no row caps; $12/day overall.
Not chosen: `crawloop/prizepicks-player-props-scraper` (1 row), `automation-lab/underdog-fantasy-player-props-scraper`
(0 rows). Odds API to run alongside as a third check is still to be wired.

Full-board live run (2026-10-03): `zen-studio/prizepicks-player-props` with All leagues returned **28,411 lines
for $1.47**. Expected daily spend at the default schedule: Zen PrizePicks 4 × ~$1.47 + lergassy 1 × ~$1.80 +
Zen Underdog 2 × ~$1 ≈ **$9.70/day**, under the $12 cap.

## Odds API alongside (2026-10-03)

The Odds API is the third PrizePicks source (`apps/api/src/scrapers/odds-api-source.ts`). Its Over and Under outcomes
are joined into one line; lines it shares with the scrapers are matched by player, market, number and tier (its ids
differ from PrizePicks'), confirm each other, and appear once on the board under PrizePicks' id and game. It runs on
the owner's paid pull only. Odds-only lines in leagues where the two sources name teams differently (outside the NFL)
may keep their own game id.

## Watch list

- **Pick6 (`crawloop/draftkings-pick6-scraper`):** returned 0 props on both test runs (2026-10-03: an MLB slate, then
  a CFB slate). The owner has an Apify auto-refresh on it. **If it comes back blank again, flag it** and replace it.
  Any source wired into the puller also reports `blankRunsInARow` in owner diagnostics.

## SharpAPI (owner, 2026-10-03)

The owner added a SharpAPI key to the environment's secrets. SharpAPI can cover DraftKings (Pick6), Hard Rock,
Underdog, PrizePicks and Kalshi. It was not reachable from the session where it was added (secrets reach new
sessions only). Next: in a new session, read its docs and responses, then add it as another source in
`apps/api/src/scrapers/` (no Apify; a `run()` source like `odds-api-source.ts`), confirming lines across sources.

## Game context feeds (owner, 2026-10-04)

Display-only, never scored (`apps/api/src/context/`). They share the scraper budget, raised to **$15/day**.

| Apify actor | Shows | Schedule (ET) | Per-run cap |
|---|---|---|---|
| `lergassy/sports-injuries-api` | Injury status, injury, expected return, ESPN note (NFL, NBA, MLB, NHL, WNBA, college football) | 8, 11, 14, 17 | $0.50 |
| `lergassy/pinnacle-odds-api` | Pinnacle moneyline (no-vig win chance), spread and total for games in the next 3 days | 9, 15 | $1.50 |
| `lergassy/kalshi-scraper` | Sports prediction markets (top 300 by volume, min $1,000) | 11 | $1.00 |
| `lergassy/polymarket-scraper` | Same, from Polymarket | 11 | $1.00 |

The player screen shows them under **Game news** ("Not part of the GKR score"); `GET /v1/context/line/:lineId` serves
them, owner diagnostics show each feed's last run and `blankRunsInARow`, and `POST /v1/admin/context/pull` runs one now.
Using any of them inside scoring needs the owner's approval and a new opt-in model version.

## Platforms, boards and +EV (owner, 2026-10-04)

**Order:** (1) store every platform's lines per player/stat over time (no score change; player screens show other apps'
lines); (2) a platform picker on the Board, one board per pick'em app with its own rules, a Crown from one app only;
(3) a proposal to use cross-platform lines in scoring, as new opt-in model versions, measured on tracked results first.

| Platform | Role | Source |
|---|---|---|
| PrizePicks | Board (default) | Zen + lergassy scrapers, The Odds API; SharpAPI when its PrizePicks feed returns (upstream gap 2026-10-04) |
| Underdog | Board | Zen scraper (already stored), SharpAPI |
| DraftKings Pick6 | Board, its own section | `zen-studio/draftkings-pick6-player-props` (tested 2026-10-04: real rows, $0.01 for NFL). Not on SharpAPI; `crawloop` returned 0 twice |
| DraftKings Sportsbook | Reference odds only, its own section | SharpAPI (Hobby) |
| Hard Rock | Reference odds only | SharpAPI (Hobby) |
| Kalshi, Polymarket | Reference odds (Game news) | Apify feeds; SharpAPI also carries Kalshi |
| Onyx | Wanted | No source found yet: not on SharpAPI or the Apify store |

**+EV (wanted):** SharpAPI's ready-made `/opportunities/ev` needs its Pro plan (the account is Hobby). CrownIQ can
compute its own: remove the vig from a sharp book's Over/Under prices for the same player, stat and number (DraftKings
and Hard Rock props via SharpAPI; Pinnacle for game lines) to get a fair probability, then compare it with each pick'em
app's break-even for its payout. Shown as its own +EV view; it does not change GKR scores unless approved as a model version.

### +EV built (2026-10-04)

`apps/api/src/context/sharp-props.ts` pulls DraftKings and Hard Rock player-prop prices from SharpAPI every hour
(`SHARPAPI_KEY` on the server), pairs each book's Over and Under at the same number and removes the vig.
`ev.ts` matches them to standard PrizePicks lines by sport, player, stat and exact number, averages the books, and
compares the better side with the break-even (54.21%, PrizePicks' 5-6 pick Flex; `CROWNIQ_EV_BREAK_EVEN`). Goblins and
Demons are left out because they pay differently. `GET /v1/ev` serves picks with a positive edge; Top Picks has a
**+EV** tab that also shows what GKR says about the same line. It never changes a GKR score. Tying the two together
(for example, sportsbook agreement as a GKR factor) is a separate proposal for the owner. Only exact stat names are
mapped (`marketKeys`); unmapped stats are left out rather than guessed.
