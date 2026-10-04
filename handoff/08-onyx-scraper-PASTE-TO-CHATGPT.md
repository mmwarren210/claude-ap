# Onyx pick'em scraper: prompt for ChatGPT

Paste everything below the line into ChatGPT. When it is done, bring back the actor's name, its input JSON and one
real run's output (Apify run link), and Claude audits it before CrownIQ uses it.

---

Build an **Apify actor** that collects the **pregame player picks** board from **Onyx** (Onyx Odds, the pick'em /
social sportsbook app at onyxodds.com, offered in California and other states). It will run in my Apify account and
feed CrownIQ, a pick'em research app, as one more line source next to PrizePicks, Underdog and DraftKings Pick6. You
decide how to build it where these requirements leave room; the must-haves below are not optional.

## Must-haves

1. **Allowed access only.** Use public, unauthenticated web or app endpoints that Onyx serves to any visitor. Do not log
   in with anyone's account, bypass a paywall, CAPTCHA, geofence or bot protection, or spoof an app signature. Read
   Onyx's terms of use and robots.txt first and tell me in plain words anything that limits automated collection. If the
   board is only reachable by breaking one of these rules, stop and tell me instead of building it.
2. **Polite.** One full board pull at most every 15 minutes, a few requests per second at most, retries with backoff,
   a clear User-Agent. No proxies unless I turn them on in the input.
3. **Fail closed.** If a page or response shape changes and fields cannot be read with certainty, skip that row and
   count the reason; never guess a line, side, multiplier, team or start time. An empty or broken run must end with a
   clear status message, not with partial guesses.
4. **Pregame only by default.** Skip live, in-game, started, suspended and settled picks (an input flag may include
   live picks for testing; default off).
5. **No secrets in code.** Any key or cookie (there should be none) comes only from actor input marked secret.
6. **One output row per pick option** (one player, one stat, one number), with exactly these fields; use `null` when
   Onyx does not show a value, never a made-up default:

| Field | Type | Meaning |
|---|---|---|
| `platform` | `"onyx"` | Always `onyx` |
| `projectionId` | string | Onyx's own stable id for this pick (stays the same while the pick is up, even if the number moves) |
| `league` | string | Onyx's league label, e.g. `NFL`, `NBA`, `CFB`, `MLB`, `NHL`, `SOCCER` |
| `gameId` | string or null | Onyx's game id |
| `startTime` | ISO 8601 with offset | Scheduled start |
| `homeTeam`, `awayTeam` | string or null | Team abbreviations as Onyx shows them |
| `homeTeamName`, `awayTeamName` | string or null | Full team names when shown |
| `player` | string | Player name exactly as shown |
| `team` | string or null | Player's team abbreviation |
| `position` | string or null | As shown |
| `stat` | string | Onyx's stat label, e.g. `Passing Yards`, `Rush + Rec Yards` |
| `line` | number | The number |
| `tier` | `"standard"`, `"discount"`, `"boost"` or Onyx's own word | Line type (Onyx's equivalent of standard / goblin / demon); keep Onyx's wording in `tierLabel` |
| `tierLabel` | string or null | Onyx's own label for the tier |
| `sides` | array of `"more"` / `"less"` | Only the sides Onyx actually lets you pick for this line |
| `moreMultiplier`, `lessMultiplier` | number or null | Payout multiplier per side when shown |
| `status` | string | Onyx's status for the pick (e.g. `open`) |
| `isLive` | boolean | True for in-game picks |
| `isPlayerCombo` | boolean | True for multi-player combo picks |
| `imageUrl` | string or null | Player headshot URL only (not team logos or placeholders) |
| `sourceUrl` | string | The page or endpoint the row came from |
| `scrapedAt` | ISO 8601 | When this row was read |

Team picks (game winner, totals) are optional: if you include them, put them in rows with `type: "team_pick"` and
keep player rows as `type: "player_pick"`.

## Input (actor input schema)

`leagues` (array, default all), `includeLive` (boolean, default false), `maxRows` (integer, default 50,000),
`proxyConfiguration` (optional, default off). Keep the default run cheap.

## Deliverables

1. The actor code (TypeScript or JavaScript, Node 20+) with its `INPUT_SCHEMA.json`, `Dockerfile` /
   `.actor/actor.json`, and a README covering: where the data comes from, the terms-of-use findings, the fields, known
   gaps, and how it fails.
2. Tests that parse **recorded sample responses** (saved fixtures with synthetic or anonymized values) into rows,
   including a changed-shape fixture that must produce zero rows plus a skip reason.
3. Push it to my Apify account as a **private** actor, run it once on a live board, and send me: the actor name
   (`username/actor-name`), the run link, the item count and the cost of that run.
4. A short note listing every assumption you made and anything you could not confirm.

Do not change the CrownIQ repository; Claude adds the reader on the CrownIQ side after auditing your actor.
