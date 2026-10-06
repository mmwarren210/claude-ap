# CrownIQ Edge engine

Edge is CrownIQ's standalone probability engine. It has its own **Top Picks**, **Board** and **Gen** inside the app's Edge tab. It reads every line on the saved board directly, including every line GKR skips or PASSes, and never depends on GKR output (nor changes it). For each line it:
- prices a **hit probability**;
- sets **its own line** (the number where MORE and LESS are 50/50 on Edge's distribution);
- picks the side with the edge against what a PrizePicks entry needs to break even.

Lines Edge has no data for are still listed, marked **No read** with the reason.

Code: `packages/edge` (pure engine), `apps/api/src/edge-service.ts`, `apps/api/src/edge-ledger.ts`, and the app's **Edge** tab (`apps/mobile/src/app/(tabs)/edge.tsx`, `apps/mobile/src/app/edge/[lineId].tsx`).

## Why Edge is built differently

GKR scores mostly from "last 5 games vs last 10 games" factor ratios. The distance between projection and line moves the score by at most ±12. It assumes a normal distribution even for 0.5-line count stats, and it cannot say whether a pick beats a payout. Edge is built around the one question that decides whether a pick is worth playing: *what is the probability it hits, and is that above break-even?*

## In the app

- **Top Picks.**
  - Standard lines whose hit probability beats the break-even, ranked by rating.
  - Goblin & Demon lines ranked by hit probability, with the minimum payout factor each needs.
  - Best entries.
- **Board.** Every line on the board, searchable and filterable by sport. Filters: every line / Edge reads / No read. Sorts: start time / biggest edge / hit %. Each row shows the PrizePicks line next to Edge's line ("PP 24.5 · Edge 26.5"), the side, hit %, rating and the main reason. Tapping a row opens the full read.
- **Gen.** Generates up to 5 entries from Edge's +EV reads.
  - Choose Power or Flex, entry size, today / tomorrow / any day, and sport.
  - Each entry uses one leg per player, at most two legs per game and at least two games.
  - No leg is reused across entries, and an entry is never padded with weak legs.
  - Any entry loads into the slip, which prices it with exact EV.
- **Pick detail.** Every input behind a read: each sportsbook quote with its fair price, the stats projection, source weights, the distribution, reasons and warnings.

## Inputs

| Source | What it gives | Weight |
| --- | --- | --- |
| **Sportsbook prices** | The same Odds API odds request that fetches PrizePicks also asks for up to nine sportsbooks (default: Pinnacle, FanDuel, DraftKings, BetMGM, Caesars, ESPN BET, BetOnline, BetRivers, Hard Rock). Each book's margin is removed with the **power method**, and the fair price is converted into a full distribution for that player. | Highest. Books are weighted by sharpness (Pinnacle 1.0, FanDuel 0.8, …), quotes far from the PrizePicks line count less, and precision is capped because books copy each other. |
| **Stats projection** | Internal-history game rows (Stat API archive, backfill, graded results) for NFL/NBA/MLB. Projection = opportunity (minutes, snaps, attempts, PA, batters faced; recency-weighted) × per-opportunity rate (longer window). DNP rows are removed, not averaged in as zeros. | Lower. Its standard error is inflated 1.5× because opponent, pace and role are not modelled. |
| **PrizePicks ladder** | The regular PrizePicks line for the same player and market, treated as a 50/50 anchor. | Small when books exist and moderate otherwise. It also lets Goblin/Demon rungs be priced from the regular line when no book quotes exist. |

The three estimates of the mean are combined by inverse-variance weighting. The predictive distribution adds the estimate's own uncertainty to the game-to-game variance, which pulls probabilities toward 50% when evidence is thin.

**Captured but not used for pricing:** PrizePicks' own indicative prices and multipliers.

## Distributions

Each market has a profile (`packages/edge/src/markets.ts`) with a variance function V(μ) = φμ + ψμ²:

- **Poisson**: walks, home runs, NHL goals.
- **Negative binomial** (variance > mean): points, rebounds, assists, receptions, targets, strikeouts, hits, shots and so on.
- **Discretized normal**: yards, saves, pitching outs. Integer lines get a real exact-hit probability.
- **Continuous normal**: fantasy points.

An exact hit removes the pick on PrizePicks, so every probability is conditional on not landing exactly on the line, and the exact-hit chance is shown separately.

## Output per line

Each priced line is returned as an `edgePickSchema` record in `packages/contracts`:

- **Probability:** hit probability for the better offered side and for the opposite side.
- **Edge:** probability − break-even for standard lines. The break-even comes from the best configured entry, 54.2% for 6-pick Flex with the default tables.
- **Rating:** ELITE ≥ 7 points, STRONG ≥ 4.5, VALUE ≥ 2, THIN > 0. The edge is first multiplied by a source factor: Sharp 1.0, Market 0.85, Model 0.6, Ladder 0.5.
- **Edge line (`fairLine`):** the half-point where MORE and LESS are closest to 50/50 on Edge's distribution. It's the number Edge would post if it were the book.
- **Required payout factor:** break-even ÷ probability, the minimum PrizePicks payout factor at which the leg is worth playing. This is the decision number for Goblins and Demons.
- **Audit detail:** projection (mean, median, SD, family), every book quote with its fair over-probability, stats sample and hit rate at the line, source weights, plain-language reasons and warnings.

### Tiers

| Tier | Meaning |
| --- | --- |
| SHARP | At least two books, including a two-sided sharp book. |
| MARKET | Any sportsbook quote. |
| MODEL | Stats projection without books. |
| LADDER | Priced only from the PrizePicks regular line, so it applies to alternates only. A regular line with no independent information is left unpriced. |

### Goblins and Demons

The Odds API feed carries no PrizePicks payout factor for Goblin and Demon lines (see `docs/LIVE_ODDS_PULL_2026-09-24.md`). Edge therefore does not invent one:

- Every alternate rung gets a real probability from the same distribution.
- `edge` stays `null`, and the app shows "worth it only if its payout factor is at least X×".
- An owner who verifies the factors can set `EDGE_GOBLIN_FACTOR` / `EDGE_DEMON_FACTOR` to rank those lines as edges.

## Payouts, break-evens and slips

Default standard-line tables, overridable with `EDGE_PAYOUTS`. Confirm the current tables in the PrizePicks app.

| Entry | Pays | Per-leg break-even |
| --- | --- | --- |
| Power 2 | 3× | 57.7% |
| Power 3 | 6× | 55.0% |
| Power 4 | 10× | 56.2% |
| Power 5 | 20× | 54.9% |
| Power 6 | 37.5× | 54.7% |
| Flex 3 | 3× / 1× | 57.7% |
| Flex 4 | 6× / 1.5× | 55.0% |
| Flex 5 | 10× / 2× / 0.4× | 54.2% |
| Flex 6 | 25× / 2× / 0.4× | 54.2% |

**Slip EV.** Slip EV is exact for independent legs: the code computes the full Poisson-binomial distribution of how many legs hit and applies the payout for each outcome.

**Best entries.** The optimizer builds the best entry of each type from positive-edge standard lines, with one leg per player, at most two legs per game and at least two games. Same-game legs are correlated, so their EV is flagged as approximate.

**Your own slip.** In the app, any lines can be added to a slip and priced with `POST /v1/edge/slip`.

## Learning from results

1. **Tracking.** Every refresh records rated standard picks, plus alternates at ≥ 62%, in `CROWNIQ_EDGE_LEDGER_FILE`. Each record keeps the first and the latest pre-start probability.
2. **Grading.** Picks are graded from:
   - result facts posted to `/v1/admin/tracked-results` or `/v1/admin/edge/results`;
   - internal-history rows dated near the event;
   - with `STAT_API_KEY`, an hourly worker that fetches finals for up to `EDGE_AUTO_GRADE_MAX_PLAYERS` players per run. This uses Stat API quota, never Odds API credits.
3. **Calibration.** Once 150 picks are graded, a Platt recalibration p' = σ(a + b·logit p) is fitted (per sport once a sport has 150), with a prior toward the identity map. Every new pricing applies it. Until then, picks are labelled *uncalibrated*.
4. **Performance.** `GET /v1/edge/performance` reports:
   - Brier score, Brier skill, log loss and a reliability table;
   - hit rate on standard lines compared with their average break-even;
   - breakdowns by tier, rating and sport.
5. **Backtest.** `GET /v1/owner/edge/backtest` replays the stats projection walk-forward over all internal history. For each game it predicts only from earlier games and compares against the original GKR projection (mean/SD of the last 10 games as a normal), reporting log score, MAE and Brier per market.

## API

All routes require a signed-in profile; owner routes return 404 to anyone else.

| Route | Purpose |
| --- | --- |
| `GET /v1/edge?view=edges\|alternates\|all&sport=&market=&limit=&minProbability=` | Ranked picks, counts, calibration status, entries and best slips. |
| `GET /v1/edge/board?sport=&market=&q=&filter=all\|picks\|no_read&sort=start\|edge\|probability&offset=&limit=` | Every line with Edge's read, including No read lines. |
| `POST /v1/edge/gen` `{type, size, count, sport?, from?, to?, maxPerGame?, maxLegUses?}` | Edge Gen entries. |
| `GET /v1/edge/line/:lineId` | One line. The opposite side of a pick is returned flipped. |
| `GET /v1/edge/player/:playerId` | Every priced line for a player. |
| `POST /v1/edge/slip` `{type, lineIds}` | Exact EV for a custom 2–6 leg entry. |
| `GET /v1/edge/performance` | Graded track record. |
| `GET /v1/owner/edge/status`, `POST /v1/owner/edge/grade`, `GET /v1/owner/edge/backtest` | Owner diagnostics. |
| `POST /v1/admin/edge/results` | Admin result facts. |

`/v1/board` strips sportsbook quotes from its payload so the mobile board stays the same size.

## Limits

These are estimates, not guarantees.

- **Opponents and injuries:** the stats model has no opponent, pace or injury inputs. Sportsbook prices usually already reflect them, which is why the market weight is high.
- **Correlation:** treated as independence inside a slip.
- **Payout tables:** defaults that can drift from PrizePicks' live tables.
- **Calibration:** none until results accumulate.
- **Book prices:** missing for markets the configured books do not offer, in which case Edge falls back to model or ladder pricing at lower confidence.

Hit rate against break-even on graded picks is the measure that settles whether Edge is beating PrizePicks.

---

## On `claude/crowniq-redesign` (Edge 2.0)

### P1 (2026-10-06): data foundation, Edge live on PrizePicks

How this branch differs from the reference build above, agreed with the owner:

| Reference build | This branch |
| --- | --- |
| PrizePicks lines from The Odds API | The scraped PrizePicks board (the app's own board), plus any PrizePicks line SharpAPI lists that the scrapers missed. SharpAPI's PrizePicks rows never count as a price: their price is the payout (Power −137, Flex −119 on every line). |
| Sportsbook quotes from up to nine Odds API books (Pinnacle as the sharp anchor) | SharpAPI: DraftKings, FanDuel, Hard Rock (Kalshi props are P2). No Pinnacle, so most reads are MARKET or SHARP via FanDuel. |
| Payout tables from `EDGE_PAYOUTS` | The app's own owner-checked charts (`DEFAULT_PAYOUTS` / `CROWNIQ_PAYOUTS`), so Edge and the Crown generators agree. |
| Stats from internal history for NFL/NBA/MLB only | Internal history rows, plus the same History values every tab uses (CrownIQ history, Stat API rows, ESPN game logs, free sources) for every sport. |
| Grading from internal history / Stat API | ESPN and MLB box scores (`BoxScoreResults`), then internal history. |
| Backtest vs "original GKR projection" | Backtest vs the last-10-games baseline. Edge is never compared with GKR. |

New in P1:
- **Odds snapshot store** (`apps/api/src/edge/snapshots.ts`): SQLite through Node's built-in `node:sqlite` at `${CROWNIQ_DATA_DIR}/edge/snapshots.sqlite`. A row is written when a price first appears or changes, and each key's last-seen time is kept, which carries the same information as storing every poll. Sources: every SharpAPI refresh (book prices and PrizePicks lines), the scraped PrizePicks / Underdog / Pick6 boards with multipliers, and Kalshi every 5 minutes. `closing(eventKey)` gives the last pre-start price per key. 120 days at full resolution, then one row per key per hour.
- **Identity layer** (`apps/api/src/edge/market-map.ts`): one market table, player names through `normalizedName`, events by team plus start within ±6h. Ambiguous names are counted and left out. A book quote more than 3 SD from the board's regular line is rejected as `MARKET_MISMATCH`.
- **No read with the exact missing input**: every line Edge can't read says which inputs it lacks (no sportsbook price; N games of history, needs 5; no regular line to anchor it).
- **Diagnostics**: `[edge]` log line per pricing pass (lines read / No read by reason / +EV / edge null / tiers / SharpAPI confirmations / match rate / MARKET_MISMATCH); `GET /v1/admin/edge/status` and `GET /v1/owner/edge/status` (snapshot rows per source).
- **Goblins and Demons**: no PrizePicks scraper or Apify actor gives their payout factors (checked 2026-10-05), so `edge` stays null until the owner sets `EDGE_GOBLIN_FACTOR` / `EDGE_DEMON_FACTOR`.

**Owner changes after P1 (2026-10-06):** Kalshi and Polymarket are removed from the app, so Edge 2.0 covers five
platforms: PrizePicks, Underdog, DK Pick'em, DraftKings and Hard Rock. The spec's Kalshi/Polymarket sections (§1.1b,
§2.5, §4) no longer apply. BetRivers joins the SharpAPI books as a price source (data only, no tab).

### P2 (2026-10-06): every platform, each with its own payout math

Edge prices five platforms in one pass (`apps/api/src/edge/service.ts`, `platform-lines.ts`), and the app's Edge tab has a
platform chip for each:

| Platform | Lines | A side's bar | Entries |
| --- | --- | --- | --- |
| PrizePicks | Scraped board + SharpAPI PrizePicks lines | Entry break-even (Goblin/Demon ÷ owner-set factor, else no edge) | Power 2–6, Flex 2–6 (app chart) |
| Underdog | Scraped board, each side's multiplier | Entry break-even ÷ the pick's multiplier | Standard 2–8, Flex 3–8 (app chart × each pick's multiplier) |
| DK Pick'em | Scraped board, each side's multiplier; gimmes never ranked | No public chart: chance shown, edge null until the owner sets `EDGE_PICK6_PAYOUTS_CONFIRMED=true` (tables in `CROWNIQ_PAYOUTS`) | Power 2–6 once confirmed |
| DraftKings | SharpAPI prices, every rung | 1 ÷ decimal odds; EV = p × odds − 1; quarter-Kelly stake capped at 2% | Parlays 2–8 |
| Hard Rock | SharpAPI prices, every rung | Same as DraftKings | Parlays 2–20 |

- Leave-one-out: a platform's own book never counts toward its fair price, and pick'em rows never count as prices.
- An edge above 15 points is held for review and never ranked (spec §6).
- Slip EV multiplies the entry's payout by each leg's own multiplier (an app pick's payout, or a parlay leg's odds).
- `/v1/edge`, `/board`, `/gen`, `/line/:id`, `/player/:id` and `/slip` take `platform` (default `prizepicks`).

### P3 (2026-10-06): movement, stale lines, injuries, ranking, alerts

- **Refresh rate:** SharpAPI every 15 minutes (`CROWNIQ_SHARP_REFRESH_MINUTES`); its Hobby plan limits only requests per
  minute. The books-history file still appends hourly.
- **Movement** (`edge/movement.ts`): each book's implied mean per player and stat, compared refresh to refresh. A move is
  ≥ 0.25 SD; steam is 3+ books moving the same way in one refresh (≤ 10 minutes).
- **STALE** (pick'em platforms): the books moved after the app's number last changed (snapshot store `lastChange`), toward
  the pick's side, and the app's number is ≥ 0.5 SD from the books' mean. The card says "Books moved up 14 min ago (3
  books, first FanDuel); PrizePicks hasn't." Every first STALE flag is logged to `edge/stale-events.jsonl`;
  `GET /v1/owner/edge/stale` replays the last 7 days with Edge's view at the close and the result once graded.
- **Injuries:** players listed Out/Doubtful/Suspended/Inactive on the injury feed are never ranked (the line still shows).
  Teammate repricing needs usage data (P5).
- **Ranking:** `rank = (EV or edge) × confidence × freshness` (`packages/edge/src/ranking.ts`); Top Picks and the Board's
  "Best" sort use it. Nothing starting within 5 minutes is shown.
- **Alerts:** in-app, not push. CrownIQ runs as a web app, where Expo push doesn't reach; native push can follow when the
  app ships to the stores. `GET /v1/edge/alerts`: STALE picks (≤ 30 minutes old) with ≥ 4 points of edge, one per player
  per hour, shown at the top of the Edge tab.
- **Best number across apps:** every pick lists the same player and stat on the other platforms with Edge's chance there.
