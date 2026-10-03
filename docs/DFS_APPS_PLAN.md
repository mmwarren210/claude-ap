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
