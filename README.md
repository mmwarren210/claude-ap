# CrownIQ AI

Mobile-first CrownIQ foundation: Expo/React Native app, server API, shared schemas, a PrizePicks-only full-board adapter and a deterministic GKR engine. The [model engine guide](docs/MODEL_ENGINE.md) describes the 69 versioned market definitions, scoring audit, fantasy registry, and required evidence. Model calibration is not yet owner-approved and the odds feed does not supply its required context; live imported lines return PASS without invented rankings.

The [NFL passing pilot](docs/NFL_PASSING_PILOT.md) adds attributed, server-side pregame evidence import, no-odds-credit reanalysis, exact saved-line grading, an optional nflverse weekly-stat results feed with explicit ID mappings, and an offline saved-board audit. These features do not approve an uncalibrated model or create synthetic production picks.

The [full-board web research guide](docs/WEB_RESEARCH.md) explains owner-triggered searches across sports, the saved query and cited-website catalog, and the September 24 saved-board audit of all 20,081 lines. The live web pass requires an OpenAI API key in the server runtime.

The [product tracking and Social V1 guide](docs/PRODUCT_TRACKING_SOCIAL.md) explains credit-free app refresh, saved boards after restart, immutable auto-tracked decisions, sourced result grading, verified recent history and public Top 10 rules. The [profile sign-in guide](docs/PROFILE_SIGNIN.md) describes account creation, private picks, Lite/Full views, sessions, mobile setup and limits.

The [private stat-api Research Desk guide](docs/OWNER_STAT_API_RESEARCH.md) explains NFL/NBA/MLB/PGA personal research for one signed-in owner, watched-player auto refresh, an editable private JSON notebook, and server-only key setup. It is disconnected from public board scoring and grading.

## Requirements

Node.js 22.13 or newer, npm and [Expo Go](https://expo.dev/go) for phone testing.

## Install and run

```bash
npm install
cp .env.example apps/api/.env
cp apps/mobile/.env.example apps/mobile/.env
npm run dev:api
```

In a second terminal:

```bash
npm run dev:mobile
```

Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to the running API. On a phone, use your computer's reachable LAN IP and set `API_HOST=0.0.0.0` in `apps/api/.env`. Scan Expo's QR code with Expo Go. `http://127.0.0.1:3000/health` checks the backend; it only reports liveness and whether a board exists. The owner profile reads full server status at `/v1/owner/board/health`, and the admin token at `/v1/admin/status`. Create a profile in the app to reach the Board. If no server-side board exists yet, authenticated `/v1/board` returns `503 BOARD_UNAVAILABLE`; that is an available server with no snapshot, not a network outage. Set `CROWNIQ_OWNER_PUBLIC_ID` to the owner's profile UUID. When the server reports it has no board, the Board button changes to **Pull first board** and asks the owner to confirm the credit cost. It calls `POST /v1/owner/board/bootstrap`, which the server refuses with `409 BOARD_EXISTS` once any board exists, so this path can never repeat a paid pull. **Refresh board** only rereads the saved board and never spends provider credits. `ADMIN_TOKEN` still protects terminal/admin endpoints and must never be copied into the mobile environment. Use HTTPS for real account credentials.

To connect The Odds API, put `THE_ODDS_API_KEY` in **the server's** `apps/api/.env` (or your deployed backend's environment). `ODDS_PROVIDER=auto` is the default and activates the PrizePicks adapter whenever that key exists; set `ODDS_PROVIDER=none` only when you intentionally want provider pulls disabled. Set `CROWNIQ_OWNER_PUBLIC_ID` for in-app first-board recovery, and optionally set a locally chosen `ADMIN_TOKEN` for terminal/admin endpoints. These values are never read from the mobile app. With the API running, you can also trigger an owner refresh from a terminal:

```bash
curl -X POST http://127.0.0.1:3000/v1/admin/refresh \
  -H "Authorization: Bearer YOUR_LOCAL_ADMIN_TOKEN" \
  -H "x-confirm-provider-cost: yes"
curl http://127.0.0.1:3000/health
```

Every paid pull, from the app or a terminal, runs as one server job: a second request while one is running gets `409 PULL_RUNNING` (admin) or `started: false` (owner). Admin pulls require the `x-confirm-provider-cost: yes` header and return `428` without it. The job record, including Odds API credits spent and remaining, is saved to `CROWNIQ_OWNER_JOB_FILE` (default `tmp/owner-pull-job.json`); if the server stops mid-pull, the next start reports the job as failed with `INTERRUPTED_BY_RESTART`.

Crowns are checked against `CROWNIQ_CROWN_CORRELATION_POLICY` (default `conservative`: at most two legs from one game, and no quarterback paired with his own team's receiver in the same direction) plus the existing same-player, same-team and minimum-score rules. A Crown also needs every leg's team confirmed: the server sets a line's team only when an exact source match (Sleeper for NFL, the MLB Stats API boxscore) names one of that game's two sides, and the same match supplies the player's photo link. A rejected save returns the failed rule codes in `issues`.

After a restart, CrownIQ restores the saved board immediately and rebuilds expired historical evidence in the background from its local internal-history store. Startup recovery uses no Odds API or external research calls; it preserves the original board fetch time and never extends expired availability, lineup or other current facts. Owner Board Analysis reports active/expired evidence and recovery status, with a diagnostics reload control. Rankings reloads after saved-board reanalysis, on tab focus and every minute while visible, with retry controls for failed reads.

For an existing saved board, the signed-in owner can use **Settings → Owner Board Analysis** (or `GET /v1/owner/board/diagnostics`) to inspect board age, support/approval/pass-reason counts, evidence, Second Look and fresh-context health without dumping thousands of lines. The screen's **Reanalyze saved board** action calls `POST /v1/owner/board/reanalyze` with explicit research-cost acknowledgement. It reevaluates the saved board with **zero Odds API credits**; a configured research source such as Stat API may consume its own quota. After success the mobile app rereads the saved board. This action never calls the paid odds-provider refresh. Failed optional research does not erase the last validated evidence snapshot.

Set `GKR_MODEL_PRESET=stat_history_v1` to activate CrownIQ's first expanded model-ready cohort: 20 history-backed NFL/NBA/MLB markets. The cohort now uses v1.2/v1.3 partial-coverage modules; every included market has at least 60% of its non-quality model weight mapped to factors directly derivable from Stat API rows and the CrownIQ internal-history store. The 60% gate itself was not lowered. Current lineup, player availability, probable starter and other hard facts remain separate requirements, so missing current context still produces PASS instead of guessed evidence. `GKR_APPROVED_MODEL_VERSIONS` can still add exact custom versions on top of the preset.

CrownIQ also keeps a durable, server-owned internal history file. `GET /v1/owner/history/status` reports stored rows and backfill state, while `GET /v1/owner/history/learning` summarizes tracked model performance, projection error and factor diagnostics. `POST /v1/owner/history/backfill` can seed selected NFL/NBA/MLB sports from historical Stat API rows for players already present on the saved board. Backfill is explicitly cost-acknowledged, uses zero Odds API credits, is capped by `maxPlayersPerSport`, and stores seed rows separately from future live graded outcomes. Future Stat API evidence lookups are archived into the same store with separate provenance, so recent games naturally push older seed rows out of the rolling sample instead of mixing all eras forever.

For approved Stat-API-supported NFL/NBA/MLB markets, an initial non-structural PASS can now trigger **Second Look** automatically. CrownIQ checks persistent internal history first, but only skips a targeted Stat API lookup when the cached rows can actually produce the model's required 60% attributed-factor coverage; having five projection samples alone is not enough. Newly retrieved rows are saved and GKR reruns without any score bonus. The board, rankings, ladder and player detail surfaces retain a `2ND LOOK` designation so users can see that the line required extra research and may warrant their own additional review. Structural PASS states such as unsupported models/alternates, started events, unavailable directions or invalid model output do not trigger Second Look.

The full refresh lists all active sports, checks every listed event for **PrizePicks** prop markets, then fetches their numeric player props and alternate thresholds. It excludes team spreads/totals and match winners without a numeric prop threshold. Market discovery costs one credit per event; the adapter checks account quota before discovery and before odds requests. The GitHub Actions repository secret is named `THE_ODDS_API` and maps to the server process variable `THE_ODDS_API_KEY` inside the manual workflow. It does **not** automatically configure your local or deployed backend. Never commit the secret value.

For an independent full-board export, run `npm run pull:prizepicks -w @crowniq/api` with `THE_ODDS_API_KEY` in the server process environment. The normalized `board.json` and a `coverage.json` report go to ignored `tmp/prizepicks-pull/`. The manual [PrizePicks board pull workflow](.github/workflows/prizepicks-pull.yml) uploads the same files as a short-lived GitHub Actions artifact when its repository secret is available. It does not run automatically. The [live pull report](docs/LIVE_ODDS_PULL_2026-09-24.md) records the September 24, 2026 PrizePicks snapshot, its limits, and provider credit use. Exporting does not configure the running API or generate scored plays.

After normalizing the complete board, CrownIQ compares each `_alternate` threshold with the matching Regular threshold for the same player, event, and market. For MORE, lower is Goblin and higher is Demon; for LESS, higher is Goblin and lower is Demon. Missing, equal, or conflicting Regular references remain `UNKNOWN_ALTERNATE`. The provider's `multiplier` field is not used to identify line type or infer payout.

## Environment variables

| Variable | Location | Use |
| --- | --- | --- |
| `API_HOST`, `API_PORT` | `apps/api/.env` | Local bind address and port; default `127.0.0.1:3000`. |
| `ADMIN_TOKEN` | Server only | Enables protected owner endpoints. |
| `ODDS_PROVIDER`, `THE_ODDS_API_KEY` | Server only | `auto` (default) activates the PrizePicks adapter when the provider key is present; `the_odds_api` forces that adapter and `none` disables provider pulls. |
| `THE_ODDS_API_SCOPE` | Server only | `full` (default) or `nfl_passing_yards` for the original limited adapter. |
| `THE_ODDS_API_MARKETS` | Server only | Only used in `nfl_passing_yards` scope. |
| `THE_ODDS_API_MAX_EVENTS`, `THE_ODDS_API_MAX_CREDITS_PER_REFRESH` | Server only | Full-scope safety ceilings; defaults to 5,000 events / 10,000 estimated credits, always bounded by the actual account balance. Set lower limits to control costs. |
| `SPORTSGAMEODDS_API_KEY` | Server only | Reserved for a future provider adapter. |
| `RESEARCH_PROVIDER`, `OPENAI_API_KEY` | Server only | `auto` (default), `openai_web`, or `none`; a server key enables owner-triggered web search. `AI_API_KEY` is also accepted as a legacy key name. |
| `STAT_API_KEY`, `CROWNIQ_OWNER_PUBLIC_ID`, `CROWNIQ_STAT_API_DAILY_RECORD_LIMIT`, `CROWNIQ_OWNER_RESEARCH_FILE`, `CROWNIQ_OWNER_RESEARCH_REFRESH_MINUTES` | Server only | Owner-only personal stat-api research. Set the signed-in owner's UUID and a rotated private Pro key; default 100,000 returned rows per process/UTC day. The watched-player notebook uses a private persistent file and refreshes hourly. Never copy the key into Expo. |
| `GKR_STAT_EVIDENCE`, `GKR_STAT_EVIDENCE_MAX_PLAYERS`, `GKR_STAT_EVIDENCE_CONCURRENCY` | Server only | Opt-in historical GKR evidence builder using the same server-side Stat API key. Defaults off / 1,500 exact-name players / 6 workers. It creates attributed rolling distributions and only directly derivable numeric factors for supported NFL/NBA/MLB markets; it never creates lineup, injury, weather, opponent, or role confirmations. Reanalysis uses zero Odds API credits but can consume Stat API row quota. |
| `GKR_PUBLIC_NFL_EVIDENCE` | Server only | Key-free public NFL evidence for passing yards, pass attempts and completions. Defaults `true`. It uses nflverse completed-game history plus the public Sleeper player-status feed, never the PrizePicks threshold. Reanalysis uses zero Odds API credits. |
| `GKR_PLAYER_IDENTITY` | Server only | Key-free team and headshot for every player in NFL, college football, MLB, NBA, WNBA, NHL and the major soccer leagues. Sources: Sleeper (NFL) then ESPN public team rosters. Defaults `true`. A player is matched only on the two teams in their game; the result fills the line's team and the player photo and never changes a score. Sources live in `apps/api/src/identity/`. |
| `WEB_RESEARCH_MODEL`, `WEB_RESEARCH_MAX_SEARCHES`, `WEB_RESEARCH_CONCURRENCY` | Server only | Defaults: `gpt-5.4-mini`, 1,500 search groups and four parallel searches per owner run. |
| `CROWNIQ_RESEARCH_CATALOG_FILE` | Server only | Exact searches, cited websites and expiring context cache. Default `tmp/research-catalog.json`; set to a durable mounted path in deployment. |
| `DATABASE_URL` | Server only | Reserved for durable storage. |
| `GKR_APPROVED_MODEL_VERSIONS` | Server only | Exact comma-separated module versions, only after owner calibration review; empty by default, so modules PASS. Listing a LESS-aware version (the current version with its minor number raised by one, for example `GKR-NBA-PLAYER-POINTS-1.4`) switches that market to LESS-aware scoring; see `docs/MODEL_ENGINE.md`. Unknown versions are reported at startup. |
| `NFL_PASSING_EVIDENCE_FILE` | Server only | Optional attributed NFL passing evidence JSON read on owner refresh/reanalysis. |
| `NFLVERSE_MAPPING_FILE` | Server only | Optional verified odds-to-nflverse event/player/team overrides for postgame grading. Exact automatic resolution is used when no override exists. |
| `CROWNIQ_SELECTIONS_FILE` | Server only | Persistent private JSON ledger for the single-process NFL grading pilot. |
| `CROWNIQ_BOARD_CACHE_FILE` | Server only | Validated board/evidence persisted across server restarts; default `tmp/board-cache.json`. |
| `CROWNIQ_PRODUCT_LEDGER_FILE`, `CROWNIQ_INTERNAL_HISTORY_FILE`, `CROWNIQ_AUTO_TRACK_MIN_BAND` | Server only | Durable tracked decisions plus CrownIQ-owned historical observations; defaults `tmp/product-ledger.json`, `tmp/internal-history.json`, `CROWN_STRONG`. Seed backfills and live graded outcomes are tagged separately. Optional `PLAYABLE` includes playable decisions. |
| `CROWNIQ_ALLOWED_WEB_ORIGINS` | Server only | Comma-separated allowed browser origins for the web/PWA client. |
| `CROWNIQ_GOOGLE_CLIENT_IDS`, `CROWNIQ_APPLE_CLIENT_IDS` | Server only | Optional allowed OIDC ID-token audiences. Native client activation needs separate owner setup. |
| `CROWNIQ_NFLVERSE_AUTO_GRADE` | Server only | `true` enables hourly verified nflverse grading for mapped NFL passing/completion, rushing, reception and target markets when `NFLVERSE_MAPPING_FILE` is set; default `false`. |
| `EXPO_PUBLIC_API_URL` | `apps/mobile/.env` | Public API address; never put credentials here. |

## Verify

```bash
npm run typecheck
npm test
npm run lint
```

The tests use labeled synthetic fixtures for full-board discovery, quota preflight, provider normalization and refresh, MORE/LESS alternate thresholds, PASS, adversarial review, stale evidence, unsupported markets, Crown constraints, web citation and cache behavior, AI/provider failure and owner authorization. They do not call a live odds API or consume credits. See [the architecture and remaining work](docs/ARCHITECTURE.md).

Responsible gaming: no pick is guaranteed. The app links to the [National Problem Gambling Helpline](https://www.ncpgambling.org/help-treatment/about-the-national-problem-gambling-helpline/).

### Fresh pregame context

Targeted Second Look now adds a direct current-context layer after the first PASS. Key-free MLB context verifies posted batting orders and listed probable starters from the MLB Stats API. NFL current player/QB availability comes from the structured Sleeper status feed. NBA availability reuses the existing server-only `STAT_API_KEY` player-status feed. These findings expire quickly and never survive event start. CrownIQ does not convert AI/web summaries into hard status flags, and it does not pretend projected minutes, workload, target share, game script, or pitch limits are officially confirmed facts.
