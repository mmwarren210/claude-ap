# Fix 05: Crowns save again (team identity + correlation policy)

Give this whole file to ChatGPT, together with `05-crowns-team-identity.patch`. Apply fixes 01–04 first; the patch applies cleanly on top of them.

## Prompt for ChatGPT

You maintain the CrownIQ repository. Apply the following fix. The attached patch is the exact server, engine and contract change made and tested in a reference copy of this repository (on top of fixes 01–04). Try `git apply 05-crowns-team-identity.patch` first (add `--ignore-whitespace` if line endings differ). If it doesn't apply cleanly, implement the same behavior by hand. Never infer a team from a player's name alone, and do not change any scoring gate.

### Problem

Every Crown save and share failed in production:
- `FullPrizePicksProvider.normalize` sets `team` and `opponent` to null, so `auditCrown` (`packages/engine/src/crowns.ts`) always adds `TEAM_IDENTITY_UNAVAILABLE` for any Crown of two or more legs.
- `apps/api/src/main.ts` builds `ProductLedger` without a correlation policy, so `auditCrown` also adds `CORRELATION_AUDIT_UNAVAILABLE`.
Tests passed only because they inject a policy and give lines a team. A side effect: Sleeper status matching could not tell apart players who share a name, because its team filter never ran.

### Changes

- **Contracts** (`packages/contracts/src/index.ts`): optional `homeTeam` / `awayTeam` on `propLineSchema`.
- **Providers**: `full-prizepicks-provider.ts` and `the-odds-api-provider.ts` set `homeTeam` / `awayTeam` from the Odds API event.
- **Engine**:
  - `ResearchTarget` gains optional `homeTeam` / `awayTeam`, filled by `researchTargetsFor`.
  - `analysis.ts` keeps `identity:*` evidence out of model evidence, just like `web:*`.
  - New `correlation.ts` exports `conservativeCorrelationPolicy`: `SAME_EVENT_CONCENTRATION` when more than two legs share an event, and `QB_RECEIVER_STACK` for a same-direction pair of a passing market and a same-team receiving market. It is exported from `index.ts`.
- **`apps/api/src/current-context.ts`**:
  - An `NFL_TEAMS` map (Sleeper code to the Odds API full name).
  - Sleeper candidates are narrowed to players on one of the game's two sides before requiring a unique match, which also fixes shared-name collisions.
  - A unique match emits `identity:team` (finding = full team name, only if it is one of the two sides) and `identity:photo` (`sourceUrl` = `https://sleepercdn.com/content/nfl/players/{id}.jpg`).
  - MLB emits `identity:team` from the exact boxscore side, plus `identity:photo` (`img.mlbstatic.com` by MLB person id). MLB identity is kept out of the MLB diagnostics counts.
- **`apps/api/src/board-service.ts`**: `publish` runs `withIdentity` first.
  - A line gets `team` / `opponent` only when a fresh `identity:team` finding equals its own `homeTeam` or `awayTeam`; anything else is ignored.
  - Photo findings fill `playerMedia` on the board response, for players on the board.
  - The board object is only replaced when a line actually changes.
- **`apps/api/src/main.ts`**: `CROWNIQ_CROWN_CORRELATION_POLICY=conservative` (default) passes `conservativeCorrelationPolicy` to `ProductLedger`; `none` keeps Crown saves fail-closed; any other value fails startup.
- **`apps/api/src/server.ts`**: Crown save (`POST /v1/me/crowns`) and share (`POST /v1/social/crowns`) failures now return `{code, issues}`, with the failed rule codes parsed from the ledger error.
- **Docs**: `README.md` and `.env.example`.

**Mobile (optional, if your app has a Crown save screen):** show `issues` as a sentence instead of a generic failure, for example "This Crown was not saved: more than two legs come from one game."

### Tests

- `packages/engine/test/engine.test.ts`: policy cases (one-game limit, same-team QB stack; opposite directions or the opposing team's receiver are allowed).
- New `apps/api/test/identity.test.ts`:
  - Two Sleeper players named Josh Allen (BUF QB and JAX LB) resolve to the BUF player for a Bills–Dolphins game, with team, photo and QB status. With no game sides, nothing is emitted.
  - The board service sets team and opponent from matching sides, ignores a team that isn't in the game, and publishes the photo.
  - With the policy, a valid 2-leg Crown saves, and a 3-leg single-game Crown is rejected with `SAME_EVENT_CONCENTRATION`.

### Done when

`npm run typecheck`, `npm test` and `npm run lint` all pass. In the reference copy: API 93, engine 42, all passing.
