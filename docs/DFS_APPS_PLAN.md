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
