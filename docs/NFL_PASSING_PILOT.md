# NFL passing evidence and grading pilot

This pilot covers `passing_yards` and `player_pass_attempts` only. It keeps the existing GKR versions and full-board evaluation. Without owner-approved calibration and *complete* sourced inputs, those lines continue to return PASS. No score or projection is inferred from PrizePicks thresholds or recent box scores alone.

## Pregame evidence

Set `NFL_PASSING_EVIDENCE_FILE` to a server-readable JSON file. The owner maintains this file from attributed pregame sources. It is read during `/v1/admin/refresh` or `/v1/admin/reanalyze`; the latter reevaluates the saved board **without another odds request**. A malformed/missing file makes research `FAILED` and gives no new evidence. Public screen loads do not read the file or run outside research.

Format:

```json
{
  "format": "crowniq-nfl-passing-evidence-v1",
  "evidence": [
    {
      "id": "source-specific-unique-id",
      "entityType": "PLAYER",
      "entityId": "playerId-from-board",
      "eventId": "eventId-from-board",
      "market": "passing_yards",
      "kind": "status:qb_available",
      "finding": "Description of the confirmed finding",
      "sourceName": "Named publisher",
      "sourceUrl": "https://example.org/actual-source-page",
      "sourceType": "OFFICIAL",
      "retrievedAt": "2030-09-24T12:00:00Z",
      "expiresAt": "2030-09-24T14:00:00Z",
      "quality": "HIGH",
      "confidence": 1,
      "numeric": { "value": 1 }
    }
  ]
}
```

The JSON above is a **format example**, not a real finding. Each record must match the exact board event/player and be retrieved before kickoff. Numeric model factors use `kind: "metric:<factor-name>"` with `numeric.value` and `numeric.baseline`; the distribution uses `kind: "projection:<market>"` with `value` as midpoint and `baseline` as standard deviation. Both are owner-supplied, attributable and subject to model review. The current [model guide](MODEL_ENGINE.md) lists required factors and status checks. `AI_STRUCTURED` findings and records without a source URL are rejected. Source expiry and the shorter QB-status freshness ceiling still apply.

The saved September 24 board has 293 passing-yards and 228 pass-attempt directional lines. To audit that saved file offline without spending an odds credit:

```bash
node --import tsx apps/api/scripts/audit-nfl-passing.ts \
  /path/to/board.json 2026-09-24T08:00:49.744Z \
  /path/to/pregame-evidence.json > /path/to/audit.json
```

Omit the evidence path to see the honest missing-evidence reason counts. An explicit `GKR_APPROVED_MODEL_VERSIONS` applies to this offline command too. Only approve a version after its factor normalization and distributions are reviewed against completed games. Keep an audit's `asOf` at or after the board fetch and before kickoff; post-kickoff findings cannot be used for a pregame selection.

## Saved selections and results

Set `CROWNIQ_SELECTIONS_FILE` to a path on **persistent, private server storage**. It is a single-process atomic JSON ledger. With a running board, `POST /v1/admin/selections` with `{"lineId":"..."}` saves the exact eligible line, direction, score, version and evidence snapshot. A selection after kickoff or evidence expiry is rejected. `GET /v1/admin/selections` shows the saved ledger; `GET /v1/admin/performance` groups counts by sport, market, line type, score band and model version. All routes require the owner token. There is no public per-user save flow yet.

Manual results may be submitted to `POST /v1/admin/results` as `{"results":[...]}` with exact `eventId`, `playerId`, market, `status` (`FINAL`, `DNP`, `VOID`), integer `observedValue` (null for DNP/VOID), source name and URL, and `completedAt`/`retrievedAt` times. The grader uses the original saved threshold and direction. Equal integer thresholds push; a legitimate zero is a result; a missing row is never assumed to be zero or DNP. Duplicate result keys or attempts to regrade a settled selection are rejected.

For the public NFL weekly player-stat feed, set `NFLVERSE_MAPPING_FILE` to a server-only JSON map. The same verified mapping is now reused by the product auto-grader for the supported NFL volume markets; this pilot section still documents the original passing-only selection ledger:

```json
{
  "format": "crowniq-nflverse-map-v1",
  "mappings": [{
    "eventId": "odds-event-id",
    "playerId": "odds-player-id",
    "nflverseGameId": "2030_03_AAA_BBB",
    "nflversePlayerId": "verified-nflverse-player-id",
    "team": "BBB",
    "season": 2030,
    "completedAt": "2030-09-25T04:00:00Z"
  }]
}
```

Those values are **format placeholders**. Verify the two IDs, team, game and final completion time before adding a mapping. `POST /v1/admin/grade/nflverse` downloads the corresponding season's weekly CSV, matches all three source IDs (game, player, team), then grades pending selections with published pass attempts and passing yards. No result for a mapped QB stays PENDING. DNP and void need an explicitly sourced manual result. A failed download or malformed CSV publishes no grades. The feed URL follows the [nflreadr implementation](https://github.com/nflverse/nflreadr/blob/main/R/load_stats.R), and the [player-stat documentation](https://nflreadr.nflverse.com/reference/load_player_stats) describes the game, player, attempts and passing-yards fields. Results are available after the provider publishes them; the feed is not a pregame role/injury/weather source.

## Limits before live rankings

- The odds-provider player IDs do not automatically match nflverse player IDs. Explicit owner mappings prevent name-only guesses.
- NFL weekly stats supply observed outcomes and historical box scores. They do not confirm current QB availability, weather, offensive line, game script, calibrated distributions, or payout. The evidence file is a controlled pilot input; collection from live trusted context feeds is still needed.
- No historical PrizePicks board plus verified contemporaneous evidence and settled results has been imported for a real backtest. Performance groups remain empty until actual eligible selections are saved and graded; fixture test outcomes are never used as live performance.
- The current score conversion and approval gates have not been calibrated against completed games. Leave `GKR_APPROVED_MODEL_VERSIONS` empty on production until review. Ratings are rank indices, not hit probabilities.
- The JSON ledger is for one API process on durable storage. Multi-instance deployment needs a transactional database and an event/result reconciliation job. The live board itself remains memory-only until that storage work is done.
