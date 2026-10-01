# CrownIQ AI architecture — foundation and full-board provider

The new repository began with only a one-line README. This foundation follows the CrownIQ AI brief and does not copy code from `gkr-cloud-beta`. `FullPrizePicksProvider` discovers the provider's active sports and currently listed PrizePicks player-prop markets, including alternate thresholds. Two live full-board pulls have been validated; the [live pull report](LIVE_ODDS_PULL_2026-09-24.md) records their coverage and limits. The [model engine guide](MODEL_ENGINE.md) describes versioned definitions and audit output. The [NFL passing pilot](NFL_PASSING_PILOT.md) adds a sourced pregame evidence path and exact postgame grader; the calibration inputs remain unapproved.

## Data flow

1. A server-only `OddsProvider` fetches **PrizePicks lines only** and normalizes its own raw format to validated `PropLine` records. Full scope discovers all active sports and each event's PrizePicks markets. The earlier `TheOddsApiProvider` remains available as an explicit NFL passing-yards scope.
2. `BoardService.refresh()` validates **every** normalized line, classifies alternates against the complete board's matching Regular thresholds, then assembles a timestamped board. If refresh fails, the previous validated in-memory snapshot remains available. Public screens never trigger a provider call.
3. Optional file evidence receives deduplicated targets from the current board. With a server-side OpenAI key, the owner can start a background web job (it never starts with a pull) that groups all markets and thresholds by event and player. The job checkpoints a persistent catalog of exact searches and consulted URLs; only cited, short-lived `AI_STRUCTURED` findings enter the board, as display-only context that never changes a score. Partial failures are reported without crashing refresh. [Research guide](WEB_RESEARCH.md).
4. `ModelRegistry` maps `(sport, market)` to a versioned **code** module. Candidate lines get initial, adversarial, and final assessments. Unsupported markets, stale required evidence, unavailable directions, invalid scoring, and model exceptions produce `PASS`. AI does not choose picks.
5. Only **after every line** is assessed does the ladder choose the strongest result per event/player/market/direction. The adapter preserves Regular/Goblin/Demon and `UNKNOWN_ALTERNATE` line identities. An unclassified alternate always gets PASS even when a future model is installed. Higher final score wins; tied scores prefer lower MORE or higher LESS thresholds. Real modules must account for payout and Demon tax when payout data is available. Payout is never guessed from indicative odds.
6. The Crown audit enforces no duplicate player, Apex team limits and a required correlation policy. The 2–6 pick contract exists; user-facing generation waits for real models and an implemented correlation policy.
7. The Expo app reads the validated API snapshot. The owner-only NFL passing pilot saves exact selections to an optional private, single-process JSON ledger and grades them from explicitly mapped nflverse weekly results or sourced manual outcomes. No public per-user selection flow or multi-instance database exists yet.

## Repository map

| Location | Responsibility |
| --- | --- |
| `apps/mobile/src/app` | Expo Router tabs: Board, Rankings, Crowns, My Picks, Settings. No normal-user login. |
| `apps/mobile/src/use-board.ts` | Fetch and validate the public board response. |
| `apps/api/src/server.ts` | Fastify public endpoints and protected owner refresh/status. |
| `apps/api/src/board-service.ts` | Atomic refresh and current in-memory board snapshot. |
| `apps/api/src/nfl-evidence-file.ts` | Optional attributed NFL passing evidence from an owner-managed file. |
| `apps/api/src/web-research.ts` | Cross-sport event-player web queries, citation checks, expiring findings and persistent source catalog. |
| `apps/api/src/research-build.ts` | Background owner research job, progress and snapshot matching. |
| `apps/api/scripts/plan-web-research.ts`, `run-web-research.ts` | Complete saved-board offline plan or keyed live research and output export. |
| `apps/api/src/nflverse-results.ts` | NFL weekly player-stat results with explicit game/player/team mappings. |
| `apps/api/src/selection-ledger.ts` | Private JSON selection snapshots, atomic grading, owner performance groups. |
| `apps/api/scripts/audit-nfl-passing.ts` | Offline saved-board audit; never calls the odds provider. |
| `apps/api/src/the-odds-api-provider.ts` | PrizePicks-only event odds adapter, source IDs, line types and quota telemetry. |
| `apps/api/src/full-prizepicks-provider.ts` | Dynamic active-sport/event/market discovery, complete player-prop ingestion and credit preflight. |
| `apps/api/src/prizepicks-line-types.ts` | Pure whole-board Regular versus alternate comparison with direction-aware Goblin/Demon labels. |
| `apps/api/scripts/pull-prizepicks.ts` | Owner/server-side normalized board and coverage export. |
| `.github/workflows/prizepicks-pull.yml` | Manual short-lived Actions artifact for a complete pull using the `THE_ODDS_API` repository secret. |
| `.github/workflows/prizepicks-shape-probe.yml` | Manual small paid response-shape check; run only when investigating provider changes. |
| `packages/contracts` | Zod runtime schemas and shared TypeScript types. |
| `packages/engine/src/interfaces.ts` | Provider, research, model, Crown, store and grader interfaces. |
| `packages/engine/src/registry.ts` | Versioned sport/market module registry. |
| `packages/engine/src/analysis.ts` | Three-pass contract, separate Context and Line Scores, full-board analysis and line ladder. |
| `packages/engine/src/models` | Versioned per-market weights, attributed numeric evidence scoring, model approval boundary. |
| `packages/engine/src/fantasy` | User-specified versioned scoring tables and correlated joint-scenario scoring. |
| `packages/engine/src/selections.ts` | Snapshots exact line, scores, evidence, and version at save time. |
| `packages/engine/src/grading.ts` | Grades the original saved NFL passing threshold against a matched, time-valid result. |
| `packages/engine/src/research.ts` | Active-board targets and evidence freshness filtering. |
| `packages/engine/src/crowns.ts` | Structural Crown audit and correlation-policy boundary. |

`PropLine` preserves provider line ID, league, sport, event/start, player/team/opponent, market, exact threshold, directions, line type, fetch time and optional payout. The full adapter also preserves `sourceSportKey`; unknown sports map to `OTHER` while retaining the exact provider sport key and league, and their props PASS until a model is registered. The Odds API's `sid` becomes `sourceLineId` when present; a stable surrogate is explicitly marked `sourceLineIdIsSynthetic=true` otherwise. The adapter leaves team/opponent null because event participants do not establish each player's team. Each provider outcome becomes a directional line so only offered directions appear playable. The `_alternate` source market identifies an alternate independently of the optional `multiplier` field. CrownIQ compares its threshold against the unique Regular threshold for the same event, player, and market. For MORE, lower is Goblin and higher is Demon; for LESS, higher is Goblin and lower is Demon. Same-direction Regular thresholds take precedence when available. Without a clear Regular reference, on an equal threshold, or on a combined multi-direction outcome, the alternate remains unknown and unplayable. This direction-aware rule follows [PrizePicks' examples](https://www.prizepicks.com/playbook-article/demons-and-goblins-explained-introducing-less-and-more-picks). No payout is inferred. An assessment stores components, danger-zone indicator, rule checks, supporting/opposing factors and rationale. The score is the sum of final components (0–100); `PASS` has a null score. Initial PASS is terminal for that line, while other thresholds still run. `SavedSelection` snapshots the exact line, score, version and evidence; outcomes include WIN, LOSS, PUSH and DNP/void. All test odds/projections are synthetic fixtures isolated in test files.

## Provider scope and quota

Full scope calls `/sports`, then each active sport's free `/events` endpoint. After confirming enough credits to discover **every** event, it calls `/events/{eventId}/markets?bookmakers=prizepicks` (one credit per event). It filters out featured team markets, spreads, totals and outrights that cannot represent a numeric player prop. It checks the remaining account quota against the *maximum* possible cost of the discovered PrizePicks prop markets before requesting any event odds. Each odds request names only `prizepicks`, includes source IDs and DFS multipliers, and is split into batches of at most 20 markets. Account quota headers and a configured ceiling protect each request. If discovery or odds fail, no partial snapshot is published; the last successful board remains with its original fetched timestamp. Owner status includes quota and coverage; the public health endpoint omits it. The app never makes provider calls while opening a screen.

The export script writes only a complete normalized board and a coverage report. GitHub Actions uploads them to a short-lived artifact. Actual PrizePicks prop coverage depends on the provider's currently exposed sports, events, market keys and outcome shape; skipped nonnumeric or non-player outcomes appear in coverage counts. Dynamic discovery's market listing is described by the provider as recently seen keys, so even a completed pull cannot prove that every prop on PrizePicks itself is in the feed. A repository secret does not set the local or hosted backend runtime variables.

The provider's advertised DFS prices are indicative; they are ignored for scoring and line type. The optional `multiplier` field may be null even for alternate outcomes, so presence is not proof of a Regular line. The live account returned actual `sid` identifiers for every exported line, but no numeric payout multipliers. An offline reclassification of the saved snapshot found 2,540 Goblin, 4,527 Demon, and 8,161 still unknown alternates; see the [live pull report](LIVE_ODDS_PULL_2026-09-24.md). Payout-aware comparison still requires genuine payout data. Repository Actions secret `THE_ODDS_API` does not populate the backend runtime: set `THE_ODDS_API_KEY` in the deployed server environment or in a local ignored `.env` file. `ADMIN_TOKEN` is also server-side, and only protected owner routes can trigger refresh or view quota telemetry. Both diagnostic GitHub workflows are manual-only to avoid automatic credit use on PR changes.

## Security and current limits

- Only `EXPO_PUBLIC_API_URL` is in the mobile environment. Provider, AI, database and owner credentials belong server-side. Env examples contain no secrets.
- Paid/admin endpoints remain server-only. The signed-in owner profile can access protected board diagnostics/reanalysis and the private Research Desk without exposing provider or research credentials to Expo; terminal/admin endpoints still use the server-side admin token. Production deployment still needs hardened ingress rate limits, account recovery/session operations, audit logging and shared transactional storage.
- 69 sport/market weight layouts are registered on the server. The `stat_history_v1` preset activates only the explicitly approved history-backed cohort; other modules remain PASS until their exact versions and evidence paths are validated. Unmapped markets return `PASS / MODEL_SUPPORT_INCOMPLETE`. The app does not fabricate picks.
- The validated board, applied evidence and Second Look audits persist through `CROWNIQ_BOARD_CACHE_FILE`; tracked decisions/profile data and internal history also have server-owned JSON persistence. These files are **single-process storage** and require durable mounted paths in deployment. They are not a substitute for a shared multi-instance database. Short-lived pregame evidence can legitimately expire after restart. Local internal history is rebuilt in the background without blocking startup or contacting external research providers; current injury/lineup facts retain their original expiry. Owner diagnostics distinguishes active and expired evidence. The owner can run research-only saved-board reanalysis with zero Odds API credits. Full provider refresh remains explicit because it may consume paid credits and will not publish a partial board when quota is insufficient.
- Exact saved-line grading, verified rolling history, model-version tracking and performance diagnostics exist for the supported result pipelines. Coverage is still sport/provider dependent; unavailable results remain pending rather than guessed.
- No validated production correlation policy or verified payout feed exists yet, so automatic Crown generation remains intentionally unavailable. Manual Crown review/save behavior continues to fail closed when correlation validation is unavailable.

## Next slices

1. Resolve missing Regular references for unknown alternates and obtain verified PrizePicks payout/multiplier data; validate sport/market mappings against actual provider outcomes.
2. Backtest and calibrate each provisional model version against verified historical outcomes before widening the approved cohort; keep Data Confidence separate from hit probability.
3. Extend trusted direct numeric/current-context evidence beyond the current NFL/NBA/MLB cohort and validate sport-specific source mappings without allowing web/AI summaries to satisfy hard factual gates.
4. Migrate board/evidence/profile/tracking/history persistence from single-instance JSON files to shared transactional storage for multi-instance deployment, with production account recovery, session management and audit logs.
5. Define and validate a conservative correlation policy plus reliable team/event identity before enabling automatic 2–6 leg Crowns; keep manual user-selected Crowns available independently.
