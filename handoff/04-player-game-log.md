# Fix 04: Player game log endpoint

Give this whole file to ChatGPT, together with `04-player-game-log.patch`. Apply fixes 01–03 first.

## Prompt for ChatGPT

You maintain the CrownIQ repository. Add the following backend feature. The attached patch is the exact change made and tested in a reference copy of this repository (on top of fixes 01–03). Try `git apply 04-player-game-log.patch` first (add `--ignore-whitespace` if line endings differ). If it doesn't apply cleanly, implement the same behavior by hand. Do not change scoring or evidence.

### Why

The redesigned app shows L5/L10/L15 hit rates, averages, streaks, the difference from the line, and a game-by-game bar chart for each player and market. The server had no endpoint for a player's recent values, so all of these would be blank on real data.

### Changes

- `packages/contracts/src/index.ts`:
  - `playerMediaSchema` `{ photoUrl: url | null, source: string | null }` and an optional `playerMedia: Record<playerId, PlayerMedia>` on `boardResponseSchema`. Nothing fills it yet; it is for player photos later.
  - `playerGameLogSchema`: `{ sport, playerId, playerName, market, source: 'CROWNIQ_INTERNAL_HISTORY' | 'DEMO', unit: string | null, games: { date: 'YYYY-MM-DD', opponent: string | null, value: number }[] (max 40) }`, plus the `PlayerMedia` and `PlayerGameLog` types.
- `apps/api/src/internal-history.ts`: `InternalHistoryStore.gameLog(sport, playerId, playerName, market, before)`. It reads rows through `rowsFor` (same player-id or exact-name match, only rows before `before`), takes the market value with `internalHistorySpecs[sport][market].value`, skips rows without a finite value, keeps one value per game day (so a graded result and a stat row for the same game count once), and returns up to 15, newest first. It returns null for markets without a spec.
- `apps/api/src/server.ts`: `GET /v1/players/:sport/:playerId/:market/games` behind the normal profile check. It finds the player's name from the current board when available, calls `gameLog`, and returns the log, or `404 {code:'NO_HISTORY'}` when there is no store, no spec or no games. `opponent` is always null until team identity exists.
- New test `apps/api/test/player-game-log.test.ts`: 18 weekly rows plus a duplicate graded row for the newest day give exactly 15 games, newest first (217 then 216). An unsupported market and an unknown player both return 404.

### Done when

`npm run typecheck`, `npm test` and `npm run lint` all pass. In the reference copy: API 90 tests, all passing.
