# CrownIQ Edge 2.0: build spec

**Target branch:** `claude/crowniq-redesign` (Railway deploys it). **Reference implementation:** `claude/edge-engine` (`packages/edge`, `docs/EDGE_ENGINE.md`).

**Goal.** Give every line on every platform (PrizePicks, Underdog, DraftKings Pick6, DraftKings, Hard Rock, Kalshi, Polymarket) a calibrated hit probability and a payout-correct expected value. Then find the lines the apps have mispriced *before* they move, and prove it with closing-line value, not vibes.

## How this spec is used

- **Additive only.** GKR, book picks, exchange picks and app boards keep working unchanged. Edge replaces nothing until its own track record beats them on the metrics in §9.
- **No invented inputs.** Payouts, multipliers, fees and prices come from feeds or owner-set config, and every default says "confirm in app". Unknown means `null` and a visible label, never a guess.
- **Phase gates.** Phases ship in order (§11). Each phase is pushed only when typecheck, tests and lint are green and its acceptance checks pass.

---

## 0. Where edge actually comes from

Ranked by how much money each source is worth, so effort goes there first:

1. **Stale DFS lines.** Books re-price on news within minutes; PrizePicks, Underdog and Pick6 lag. A DFS number left behind after the books moved is the single biggest, most repeatable edge. → §3, §6.
2. **Wrong-number arbitrage.** The same player and stat at different numbers across apps (a PrizePicks Goblin, an Underdog line half a point off, a Hard Rock alternate). The distribution prices every number consistently. → §2.
3. **Payout mispricing.** Underdog/Pick6 multipliers and PrizePicks Goblin/Demon factors that don't match the true probability. → §4.
4. **Exchange mispricing.** Thin Kalshi/Polymarket books priced off the sportsbook consensus after fees. → §4.
5. **Model edge.** Opponent, pace, role and injury redistribution that the books haven't fully priced. This is real but small, and only trustworthy where CLV confirms it. → §5.
6. **Correlation.** Same-game stacks that the payout tables price as independent. → §7.

---

## 1. Data foundation (build first; everything else depends on it)

### 1.1 Odds snapshot store (time series)

Without price history there is no CLV, no steam detection and no backtest. Store every observed price, appending only.

- **Row:**
  `{observedAt, source, platform, eventKey, playerKey, market, number, side, priceDecimal | probability | multiplier, size|liquidity?, lineType, raw id}`.
- **Write path:** every SharpAPI pull, every Odds API pull (PrizePicks plus the books requested in the same call), every Underdog/Pick6 scraper run, and every Kalshi/Polymarket run.
- **Storage:**
  - Use a SQLite file on the Railway volume (`better-sqlite3`) or Postgres if `DATABASE_URL` is set. JSON files won't scale to millions of rows.
  - Indexes: `(playerKey, market, observedAt)` and `(eventKey, observedAt)`.
  - Retention: 120 days at full resolution, then thin to one row per hour per key.
- **Closing snapshot:** for each event, materialize the last observation before `startTime` per (platform, player, market, number, side).

### 1.1b Data sources: official APIs first, scrapers only for real gaps

Do the cheap checks before building; record the results in the P1 report.

| Data | Primary source | Scraper role |
| --- | --- | --- |
| PrizePicks lines | The Odds API `prizepicks` (in use) | None |
| Sportsbook player props | SharpAPI (in use) **plus** The Odds API books in the PrizePicks request (`consensusBookmakers`) | None |
| **Underdog, DraftKings Pick6 lines and multipliers** | **Test first:** one `/events/{id}/odds?bookmakers=underdog,pick6&markets=<one player market>&includeMultipliers=true` call (~1–2 credits). If lines and multipliers come back, request them in the same odds call as PrizePicks (`bookmakers=prizepicks,underdog,pick6,…`, still one region for ≤ 10 books) and make that the primary source. | The existing Apify scrapers become a cross-check under the owner's two-source rule (show lines where sources agree, mark disagreements unconfirmed), or are disabled to save budget. Keep them primary only if the test returns no lines or no multipliers. |
| **Kalshi** | **Official public API, no key needed for market data:** `GET https://api.elections.kalshi.com/trade-api/v2/markets` (filter by sports series/event) and `/markets/{ticker}/orderbook` for depth. | Replace the `lergassy/kalshi-scraper` Apify actor. |
| **Polymarket** | **Official public APIs:** Gamma `https://gamma-api.polymarket.com/markets` / `/events` for sports markets, and CLOB `https://clob.polymarket.com/book?token_id=…` for the order book. | Replace the `lergassy/polymarket-scraper` Apify actor. |
| PrizePicks Goblin/Demon payout factors | Not in The Odds API (`multiplier: null` in the 2026-09-24 pull). | **Only gap a scraper fills.** Search the Apify store for a PrizePicks actor whose output includes per-projection payout or odds-type multipliers. Add an adapter (≤ $2/day, fail-closed) only if one does. Until then use owner-set `EDGE_GOBLIN_FACTOR`/`EDGE_DEMON_FACTOR`, read from the app, and keep `edge = null` when unset. |

Before switching Kalshi or Polymarket, verify the host is reachable from Railway, check the endpoints' current docs and confirm the response fields. Run old and new side by side for 24h and compare match counts before removing the scraper.

### 1.2 One identity for player, event and market across every source

There are already three ID schemes (Odds API hash, scraper `ud:`/`p6:` ids, SharpAPI names). Build `canonicalKey(sport, league, playerName, eventStart±6h, home/away)`:

- Run names through the existing `normalizedName` and the identity layer (`apps/api/src/identity/`).
- Events match on team pair plus start time within ±6h.
- Markets map through **one** table, `market-map.ts`, built from the existing `sharp-props.ts` `marketKeys`, the `app-boards.ts` `sameStat` table and the `edge` profiles. Every source maps into it.
- Ambiguity yields no match and a counter in diagnostics, never a guess.
- **Market sanity check:** reject a cross-source match when the two sources' implied means differ by more than 3 SD. This catches mislabeled stats like the existing tennis "total games" vs "games won" problem. Record the rejection as `MARKET_MISMATCH` with both sources.

### 1.3 Result grading for every sport that is priced

The current grading covers mostly NFL, NBA and MLB. Add an ESPN public box-score result source. The identity layer already uses ESPN rosters, so reuse those mappings. Cover NBA, WNBA, NFL, NCAAFB, MLB, NHL and the soccer leagues already mapped. Write graded results into internal history so they feed projections and calibration.

**Acceptance for §1:**
- 24h of live snapshots stored.
- The identity layer matches ≥ 95% of PrizePicks lines that have a SharpAPI price.
- `MARKET_MISMATCH` count shown on owner diagnostics.
- ESPN grading resolves ≥ 90% of finished NBA/NFL/MLB/NHL picks within 6h of the final.

---

## 2. Pricing core (`packages/edge`, upgraded)

Keep the existing pieces:
- `devigPower`;
- the distribution families;
- `fitMean`, which converts a price at one number into a full distribution and hence a probability at any number;
- `projectFromRows`;
- Platt calibration;
- exact slip EV.

Upgrade the following.

### 2.1 Learned dispersion per market

Replace the hand-set ψ in `markets.ts` with values estimated from internal history. For each `sport:market`, fit the negative binomial / normal variance function `V(μ)=φμ+ψμ²` by maximum likelihood over all player-games, then shrink toward the current defaults with weight n/(n+500).

- Store the fitted values in a versioned JSON file (`edge-dispersion-v{n}.json`).
- Validate with the PIT histogram: the probability integral transform of actual outcomes should be uniform. Report a KS statistic per market on owner diagnostics.

### 2.2 Book weights learned from data, not asserted

Start from the current `bookWeights` prior, then learn each book's weight per sport from the snapshot store. The question for each book is how well its de-vigged price N hours before start predicts:
- (a) the closing consensus;
- (b) the result.

Fit inverse-variance weights from each book's squared error against the close, updated weekly and shrunk to the prior.

Sharpness differs by market: FanDuel may be sharp on NBA points and soft on NFL tackles. Learn weights per sport, plus a per-market override when n > 300.

### 2.3 Leave-one-out consensus

When pricing a line *on* a platform, exclude that platform from the consensus. This applies to DraftKings and Hard Rock (both priced and used as signals) and to Kalshi/Polymarket when used as signals. A book must never confirm its own price.

### 2.4 Freshness weighting

Weight each quote by `exp(−age/τ)` with τ = 20 min near game time and 3h earlier. A quote older than the most recent move by other books is down-weighted by 4×. A stale quote is information about staleness (§3), not about the true price.

### 2.5 Prediction markets as signals

Kalshi/Polymarket prices enter the consensus only with a liquidity weight: `min(1, depthAtTop / 200 contracts)` at the ask/bid midpoint, never the last trade. Fees are not removed for signal use; they are removed only for EV (§4).

### 2.6 Output: one `FairLine` per canonical (player, market, event)

```
FairLine {
  canonicalKey, sport, market, family,
  mean, variance, se,                 // posterior mean, game variance, estimate SE
  sources: [{kind, weight, mean, se, books?, n?}],
  probabilityAt(number, side) -> {p, push},   // conditional on no push
  updatedAt, lastBookMoveAt, dataQuality: OK | THIN | SUSPECT
}
```

Every platform's lines are priced by evaluating `probabilityAt` at their own number. One distribution therefore gives consistent prices across the regular line, Goblins/Demons, Underdog numbers, Hard Rock alternates and Kalshi strikes.

**Acceptance for §2:**
- Unit tests for leave-one-out, freshness, learned dispersion (synthetic data recovers ψ within 15%) and PIT uniformity on simulated data.
- Owner diagnostics show the dispersion table and the book-weight table.

---

## 3. Movement intelligence

### 3.1 Steam and move detection

From the snapshot store, compute per `FairLine` over the last 10/30/120 minutes:
- consensus mean change in SD units;
- the number of books that moved in the same direction;
- the first mover.

A **steam** event is ≥ 3 books moving the same way by ≥ 0.25 SD within 10 minutes.

### 3.2 Stale-line detector (the money feature)

For each DFS line (PrizePicks, Underdog, Pick6), compare the app's number with the consensus fair median after the most recent steam or news event.

Flag `STALE` when:
- `|appNumber − fairMedian| ≥ 0.5·SD`;
- the app's line was last seen unchanged after the books' move;
- and the side favored by the move is offered.

Show the age: "Books moved 14 min ago; Underdog hasn't."

### 3.3 News-triggered repricing

The redesign's free context refresh already detects injuries and status changes. On an `OUT`/`DOUBTFUL`/`QUESTIONABLE→OUT` change:

1. Immediately reprice every teammate's `FairLine` using §5.3 usage redistribution, before the books move. Mark these `NEWS_MODEL`.
2. Re-pull that game's lines within the existing scraper budget rules ("re-pull on major change" is already an owner rule).
3. When books move later, measure whether they moved toward the `NEWS_MODEL` price. That measurement is the CLV of the news model.

**Acceptance for §3:**
- Replaying 7 days of stored snapshots produces a list of STALE events with timestamps.
- Each STALE event records the DFS number and the consensus at detection and at close.
- Owner diagnostics show the hit rate and CLV of STALE flags specifically.

---

## 4. Platform payout layers (exact EV per platform)

Common output for every priced line:

```
EdgeOffer {
  platform, lineId, canonicalKey, number, side, lineType,
  p, push, fairSource tier,
  cost | breakEven | multiplier | decimalOdds,
  ev, evPerUnitRisk, kellyFraction, rating,
  stale?, steamWith?, clvSoFar?, warnings[]
}
```

### PrizePicks
- Use the Power/Flex tables (`EDGE_PAYOUTS`).
- **Goblin/Demon factors:** add a PrizePicks scraper field (via the Apify budget) that captures the per-pick payout adjustment shown in the app. Until that exists, `edge = null`, with the minimum payout factor needed shown (as already built).
- The app enforces a pick limit per game and requires at least two teams. Enforce both in the builder.

### Underdog
- Each line has `multipliers[direction]`. Entry payout = base table × product of leg multipliers.
- Base tables: Standard 2–8 picks, plus Flex. Read them from `EDGE_PAYOUTS_UNDERDOG`, defaulted and marked "confirm in app".
- Leg value is computed inside the slip EV, not per leg in isolation.
- Rank single legs by `p × multiplier` against the per-leg break-even of the best entry size.

### DraftKings Pick6
- Use the multipliers and promo/gimme flags captured by the existing scraper.
- Payout tables come from `EDGE_PAYOUTS_PICK6`, marked "confirm in app".
- A gimme pick's probability is real, but it is excluded from "edge" ranking because its payout is promotional.

### DraftKings and Hard Rock (sportsbooks)
- `ev = p_LOO × decimal − 1`, where `p_LOO` is the leave-one-out probability.
- Stake = fractional Kelly: `f = κ·(p·d − 1)/(d − 1)` with `κ = EDGE_KELLY_FRACTION` (default 0.25), capped at 2% of bankroll per bet and 6% per game.
- Include every alternate rung both books expose. The "best number" for a side is the one with the highest EV, not the one closest to the main line.
- Line-shop: show both books' prices at the same number and pick the better one.

### Kalshi and Polymarket
- Price at the **ask** for buys (YES or NO), using orderbook depth: walk the book for the configured size and use the average fill price.
- `ev = p − (fillPrice + platformFee(platform, fillPrice))`, reusing the existing `platformFee`.
- Evaluate both YES and NO.
- Show the size available at that edge; never rank an edge that has less than $25 of depth.

**Acceptance for §4:**
- Unit tests per platform with hand-computed EVs: an Underdog 3-pick with mixed multipliers, a Kalshi YES and NO with the fee, a Hard Rock alternate ladder, Pick6 gimme exclusion, and a PrizePicks Goblin with an unknown factor.

---

## 5. Projection model 2.0 (the stats signal, made worth weighting)

The current stats projection is recency-weighted opportunity × rate. Upgrade it into a game-environment model.

### 5.1 Team environment from game lines

SharpAPI already provides game spreads and totals. Convert them into team implied points or runs or goals. For each player, model:

```
stat = teamVolume × playerShare × efficiency
```

Definitions by sport:
- **NBA:** teamVolume is possessions (from the total and the pace prior); share is usage or rebound share.
- **NFL:** teamVolume is plays and pass rate (from total and spread: trailing teams pass more); share is target or carry share.
- **MLB:** teamVolume is plate appearances (from the implied team runs); for pitchers, use batters faced from the pitch-count prior.

Each component is estimated with recency-weighted, shrunk means, as in `projectFromRows` today.

### 5.2 Opponent adjustment

Use allowed-rate versus league average for each defense, by stat and position, from internal history plus ESPN results. Shrink heavily: weight `n/(n+60)` games. Apply the adjustment to efficiency, not to volume.

### 5.3 Usage redistribution when a teammate is out

From internal history, find games where teammate X missed and measure each player's share change. Shrink toward a positional prior: a missing starter's usage goes to the same-position players in proportion to their minutes.

This is what §3.3 uses for `NEWS_MODEL`.

### 5.4 Minutes / snaps as a mixture

The playing-time distribution is a mixture:
- normal minutes;
- a blowout tail, whose probability comes from the spread;
- a foul-trouble or injury tail.

The stat distribution is then a mixture of conditional distributions, evaluated by Monte Carlo (5k draws per player-market, cached per refresh). This corrects the under-pricing of LESS on big-spread games and of MORE on close games.

### 5.5 Context features

Include rest days, back-to-back, home/away, altitude, weather (NFL/MLB wind and temperature from the context feeds) and park factors (MLB). Each enters as a shrunk multiplicative adjustment with its coefficient learned from history. Drop any coefficient whose 90% CI includes 1.0.

### 5.6 Honesty gate

The stats signal's weight in the blend comes from its *measured* out-of-sample error versus the closing consensus (§9), not from its standard error. If the model doesn't beat the close on a market, its weight there decays toward zero automatically.

**Acceptance for §5:**
- Walk-forward backtest (the existing `backtestHistory`, extended) shows lower log loss than both the current Edge projection and the old GKR baseline on NBA points/rebounds/assists, NFL yards/receptions and MLB hits/strikeouts.
- The per-market table is on owner diagnostics.

---

## 6. Ranking: what the user sees first

Sort score per offer:

```
rank = ev × confidence × freshnessBoost
```

- `confidence`:
  - 1.0 for SHARP with ≥ 3 books;
  - 0.85 for MARKET;
  - for MODEL, the learned honesty weight from §5.6;
  - × 0.5 when `dataQuality = SUSPECT`.
- `freshnessBoost` = 1.25 for STALE lines in their first 30 minutes, decaying to 1.

**Sanity cap:** any edge above 15 points of probability, or above 25% EV on a sportsbook, is held as `REVIEW` until a second independent source agrees. Huge edges are usually mismatched data.

Never show a pick that starts in under 5 minutes, or a DFS line not seen in the last refresh.

---

## 7. Correlation-aware slips and portfolio

### 7.1 Factor model

For players in the same game, simulate with latent factors:
- the game-total factor (shared by everyone);
- the team-script factor (opposite signs for the two teams);
- a pair-specific term, such as QB↔receiver or pitcher Ks↔opposing batters' hits.

Estimate the loadings from residual correlations in internal history, shrunk toward these priors:

| Pair | Prior correlation |
| --- | --- |
| QB passing yds ↔ his WR/TE receiving yds | +0.35 |
| Same-team NBA points ↔ points | −0.05 |
| Pitcher Ks ↔ opposing hitters' hits | −0.15 |

### 7.2 Slip EV by simulation

Use 20k correlated draws per slip, with exact payout logic per platform (PrizePicks Power/Flex, Underdog multipliers, Pick6). Keep the independent closed form as a cross-check: the two must agree within 0.5% when correlations are zero.

### 7.3 Builder and portfolio

- **Builder:** for each platform and entry size, maximize expected log growth (Kelly for multi-outcome entries) or EV. The user picks which.
- **Constraints:** platform rules (teams per entry, picks per game), one leg per player, and a max exposure per player across all suggested entries.
- **Positive correlation:** a positively correlated stack is allowed and shown as such ("QB + WR stack: +4.1% EV vs independent").

### 7.4 Custom slip checker

Users paste or choose legs on any platform and get:
- exact EV;
- hit-count distribution;
- the correlation-adjusted probability;
- a "swap this leg for X to add +Y% EV" suggestion.

**Acceptance for §7:**
- Tests: simulation matches the closed form at zero correlation, and a positive QB–WR correlation raises the 2-pick all-hit probability by the expected amount.
- The builder respects every platform rule.

---

## 8. Alerts and UI

- **Push notifications** (Expo push; register tokens server-side) for:
  - STALE lines with EV ≥ owner threshold;
  - a NEWS_MODEL reprice that creates a +EV DFS line;
  - a Kalshi edge with ≥ $100 of depth.
  - Rate-limit to 1 per player per hour.
- **Edge tab:**
  - platform chips;
  - sort by rank, EV or hit %;
  - STALE/STEAM badges with age;
  - each card shows hit %, platform price (multiplier, odds or cents), EV and Kelly stake;
  - a "best number across apps" row ("Underdog 24.5 at 1.04× beats PrizePicks 25.5").
- **Line detail:**
  - fair distribution chart, with the number marked;
  - every platform's number and price on one ladder;
  - movement sparkline from the snapshot store;
  - source weights;
  - news events.
- **Track record screen:**
  - CLV per platform;
  - hit rate vs break-even with 95% CI;
  - ROI with a bootstrap CI;
  - a calibration plot.
  - It is public to users, so the product earns trust from proof.

---

## 9. Evaluation (how we know it's better)

| Metric | Definition | Target before Edge replaces anything |
| --- | --- | --- |
| **CLV** (primary) | Fair p at close minus the price paid (DFS: close-fair p minus break-even at pick time) | Mean CLV > 0 with 95% CI above 0 over ≥ 500 picks per platform |
| Beat-the-close rate | Share of picks where the close moved toward our side | ≥ 55% |
| Calibration | Max deviation per 5-point probability bucket (n ≥ 50) | ≤ 3 points |
| Brier skill | vs. the de-vigged closing consensus | ≥ 0 (we are at least as good as the close) |
| ROI | Realized, standard lines, per platform | Reported with a bootstrap CI; not a target until n ≥ 1,000 |

- Every metric is broken down by platform, sport, tier (SHARP/MARKET/MODEL/NEWS_MODEL/STALE) and rating.
- A tier or source whose CLV is ≤ 0 after 300 picks is automatically down-weighted and flagged on owner diagnostics.
- **Backtest harness:** replay the snapshot store day by day, so the engine only sees data available at that time. Report every metric above for each code version, and run it in CI against a fixed fixture slice.

---

## 10. Operations and budget

- **Single scheduler** for all pulls, respecting the existing owner rules:
  - two scraper pulls per day;
  - re-pull on news;
  - the $2/day/scraper cap;
  - the Odds API credit ceilings.
- **Pricing cost:** reprice incrementally per changed canonical key, not the whole board. Target < 300 ms for a typical change and < 5 s for a full board. Run the Monte Carlo in a worker thread (`node:worker_threads`) so the API never blocks.
- **Health page:**
  - per-source freshness;
  - match rates;
  - `MARKET_MISMATCH` counts;
  - snapshot rows per hour;
  - Odds API `creditsSpent` per refresh, before and after adding bookmakers to the PrizePicks call;
  - scraper spend per day.
- **Fail closed:** a source outage removes its signal and lowers confidence. It never leaves stale prices looking live.

---

## 11. Phases (ship in this order; push each when green)

| Phase | Contents | Ships when |
| --- | --- | --- |
| P1 | §1 snapshot store, identity/market map, ESPN grading; port `packages/edge` from `claude/edge-engine` | 24h of snapshots, match-rate targets met |
| P2 | §2 pricing core with leave-one-out, freshness, learned dispersion/book weights; §4 payout layers for all 7 platforms; basic Edge tab | Per-platform EV tests pass; live board priced on all platforms |
| P3 | §3 steam/stale/news; §6 ranking; §8 push alerts | STALE replay report exists; alerts rate-limited |
| P4 | §9 evaluation + CLV + track-record screen + backtest harness | Metrics visible per platform |
| P5 | §5 projection 2.0 with honesty gate | Backtest beats the current projection on the listed markets |
| P6 | §7 correlation simulation, builder, portfolio, slip checker | Simulation tests pass; builder respects platform rules |

Each phase gets its own commit set, an updated `docs/EDGE_ENGINE.md` section and a short report:
- what shipped;
- line counts priced per platform;
- new diagnostics;
- anything that couldn't be confirmed (payout tables, feeds) and is therefore `null` or labeled.
