# Live PrizePicks feed check — 2026-09-24

The Odds API was queried from GitHub Actions with the repository secret `THE_ODDS_API` mapped to the server-only `THE_ODDS_API_KEY`. This report covers **provider-exposed, numeric PrizePicks player props in the returned snapshot**, not every line on the PrizePicks app. The adapter selected only the `prizepicks` bookmaker, scanned active sports/events, discovered per-event market keys, then requested numeric player outcomes and their available alternate thresholds. The exported board is a point-in-time file, not a deployed CrownIQ board or a set of recommendations.

## Latest complete snapshot

| Field | Result |
| --- | ---: |
| Board fetched (UTC) | 2026-09-24 08:00:49 |
| Active sports scanned | 80 |
| Events discovered | 983 |
| Events with exposed PrizePicks numeric prop markets | 67 |
| Event/market entries discovered | 1,489 |
| Odds requests | 111 |
| Normalized directional selections | 20,081 |
| Outcomes skipped for incomplete/non-player data | 0 |
| Unique events / players | 67 / 1,184 |
| Real source `sid` present | 20,081 |
| Credits used by this full run | 1,556 |
| Credits remaining after this full run | 91,372 |

| Provider sport | CrownIQ sport | Selections |
| --- | --- | ---: |
| `americanfootball_nfl` | NFL | 6,188 |
| `americanfootball_ncaaf` | NCAAFB | 4,589 |
| `baseball_mlb` | MLB | 6,923 |
| `basketball_nba` | NBA | 188 |
| `basketball_wnba` | WNBA | 62 |
| `soccer_usa_mls` | OTHER, with original key retained | 2,131 |

The original Actions export had **4,853 Regular** and **15,228 `UNKNOWN_ALTERNATE`** lines, with 17,655 MORE and 2,426 LESS directional outcomes. Every alternate in this snapshot was MORE. The sampled raw NFL alternate outcomes had an explicit `multiplier: null` despite requesting `includeMultipliers=true`; the normalized export contains no numeric payout multiplier. The base market key identifies Regular lines and `_alternate` identifies alternate lines independently of that field. No NHL, tennis, or esports selections appeared in this snapshot; this does not establish permanent absence on PrizePicks.

## Offline line-type correction

The saved latest board was reclassified **without another provider request**. For each alternate, CrownIQ used a unique Regular threshold for the same event, player, and market. Lower MORE is Goblin and higher MORE is Demon; the opposite applies to LESS per [PrizePicks' examples](https://www.prizepicks.com/playbook-article/demons-and-goblins-explained-introducing-less-and-more-picks). Equal thresholds, missing Regular lines, and conflicting Regular thresholds remain unknown. The historical `fetchedAt` time and the original coverage report were preserved; this is a derived snapshot, not new live data.

| Tier in derived board | Lines | Reason |
| --- | ---: | --- |
| Regular | 4,853 | Base market |
| Goblin | 2,540 | Lower MORE threshold than its Regular line |
| Demon | 4,527 | Higher MORE threshold than its Regular line |
| Unknown alternate | 8,161 | 8,154 without a Regular reference; 7 with conflicting Regular thresholds |

| Unknown alternate by sport | Lines |
| --- | ---: |
| MLB | 4,737 |
| MLS soccer (`OTHER` in the current sport registry) | 2,049 |
| NFL | 780 |
| NCAAFB | 546 |
| NBA | 27 |
| WNBA | 22 |

The derived ZIP contains `board.json`, the unchanged historical `coverage.json`, and `classification.json` explaining the derivation. No payout was inferred, and no sport model was run to produce picks.

## Runs, cost, and access

- First complete pull: workflow run [35972065797](https://github.com/mmwarren210/crowniq-ai/actions/runs/35972065797), fetched 07:53:49 UTC, 20,023 selections, 1,556 credits, 92,932 remaining.
- A `pull_request` workflow trigger unintentionally caused a second complete pull on a subsequent PR update: workflow run [35972721100](https://github.com/mmwarren210/crowniq-ai/actions/runs/35972721100), fetched 08:00:49 UTC, 20,081 selections, another 1,556 credits. The two complete runs used **3,112 credits total**. Small diagnostic requests also used credits; the latest observed remaining balance was **91,372**.
- Both repository diagnostic workflows now use **`workflow_dispatch` only**. Do not add a PR or push trigger to a paid full-board job. A local/backend refresh also consumes account credits.
- Each successful Actions run uploaded `board.json` (normalized player/threshold/direction/line type with source IDs) and `coverage.json` as a short-lived artifact. These exports contain line data, **no API key**, and must not be committed as application fixtures or used as an always-current feed.

`/events/{eventId}/markets` returns market keys recently seen by the provider, so a successful sweep cannot guarantee coverage of every PrizePicks line. The adapter includes numeric player props and excludes team markets, outrights, match winners without a numeric threshold, and anything not returned by this provider. At the time of this pull, no sport GKR modules, scored rankings, research cache, persistent backend board, or scheduled refresh were in place. Subsequent model work is documented in [MODEL_ENGINE.md](MODEL_ENGINE.md); its modules still require approved calibration and current evidence before they can rank live lines. The Expo app needs a running backend with its own environment configured and an authorized owner refresh to show live lines; the GitHub Actions secret alone does not configure that backend.
