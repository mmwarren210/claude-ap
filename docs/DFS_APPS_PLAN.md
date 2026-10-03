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
