# Fix 06: Apply fixes 03, 04 and 05 (rebased onto crowniq-ai main 9a77b06)

## Audit of what is already done (checked 2026-10-02)
- Fix 01 (paid-pull safeguards) is merged as PR #6, and fix 02 (health lockdown) as PR #7. Both match the handoff. Two differences, both fine:
  - `saveJob` now writes through a queue, so job records are saved in order. This is an improvement.
  - The explanatory comments were dropped.
- Typecheck passes and 134/134 tests pass on main.
- Fixes 03, 04 and 05 are **not** applied. The original `03` patch no longer applies cleanly, because removing those comments shifted its context. `05` depends on `03`.

## Prompt for ChatGPT
Apply `06-fixes-03-05-rebased.patch` to `main` (it was built against commit 9a77b06) on a new branch, then open a PR. It contains, unchanged in substance:
- **03:** web findings are display-only (`contextEvidenceIds`), and web research starts only through `POST /v1/owner/board/web-research` with `acknowledgeResearchCost: true`.
- **04:** `GET /v1/players/:sport/:playerId/:market/games`, which returns up to 15 logged games, deduped by game day.
- **05:** Crowns save again. This adds team identity from `identity:team` evidence matched to the event's sides, `homeTeam`/`awayTeam` on lines, `playerMedia` on the board, and `conservativeCorrelationPolicy` (`CROWNIQ_CROWN_CORRELATION_POLICY`, default `conservative`).

### Done when
- `git apply --check` passes on main. Verified.
- `npm run typecheck` passes, and `npm test` passes 141/141 (93 api, 6 contracts, 42 engine). Verified on a copy of main with the patch applied.
- The PR description lists the three fixes above.
