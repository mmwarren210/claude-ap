# CrownIQ server lockups: audit and fix request

You're helping debug a production outage in the CrownIQ API. Please **audit the code, find the root cause, and propose
a fix as a patch**. Don't push anything. Send back your findings and a unified diff, and we'll review, test and ship it.

## Code

- Repo: `github.com/mmwarren210/claude-ap`, branch `claude/crowniq-redesign`.
- Live right now: commit `0439ce3` (rolled back). Branch head: `2ac3356`, which adds score/evaluation caching. It also
  locked up, so it is not the cause.
- Stack: Node 22, TypeScript, Fastify, `node:sqlite` (synchronous), one Node process on Railway.
  - The container allows 24 vCPU and 24 GB.
  - `NODE_OPTIONS=--max-old-space-size=6144`.
- Entry points: `apps/api/src/main.ts` (wiring) and `apps/api/src/server.ts` (routes and timers).

## Symptom

The server **locks up completely**, which is different from just being slow:
- Every timer stops. The memory watch normally logs every 4 seconds, and it goes silent.
- HTTP requests time out.
- Railway still shows the process as running, so it never restarts on its own.
- It stays locked until someone restarts it by hand (once for 35 minutes).

Three lockups on 2026-10-17 (UTC), across two different builds:

| Started | Last log line | Uptime at lockup |
|---|---|---|
| 06:39 (build 2ac3356) | 06:54:01 | ~15 min |
| 07:29 restart (2ac3356) | 07:29:32 | ~10 s |
| 08:00 (build 0439ce3) | 08:16:01 | ~16 min |

The last log lines before each lockup look like this:

```
08:16:01 [lag] event loop blocked 7.6s | serving ["POST /v1/hooks/propline 64657B 861s"]
08:16:01 [memory] rss 5074 MB, heap 3407 MB | in flight ["api.prop-line.com/v1/sports/soccer_serie_a/events/238332/odds/closing 9s","api.prop-line.com/v1/sports/soccer_epl/players/Eduardo%20Pepe/games 8s", ...]
06:54:01 [memory] rss 4732 MB, heap 3678 MB (climbing ~30 MB per 4s) | in flight ["api.prop-line.com/v1/sports/soccer_championship/players/.../games", ...]
07:29:32 [memory] file write 82 MB /data/board-cache.json.<uuid>.tmp   (last line after the 07:29 restart)
```

What the lockups have in common:
- PropLine soccer **player game logs** (`propline-history.ts`) and **closing odds** (`edge/propline-accuracy.ts`,
  `scrapers/propline-results.ts`) are in flight.
- A PropLine push webhook (`POST /v1/hooks/propline`) has been open for minutes.

## Background: normal freezes (they always recover)

Separately, the event loop blocks for 15–50 seconds every couple of minutes. A CPU profiler
(`apps/api/src/freeze-profiler.ts`) logs the top functions over 60-second windows. Typical windows:

- **Build 0439ce3:**
  - GKR scoring (`packages/engine/src/analysis.ts` evaluateBoard/evaluateLine): 24–44 s
  - `edge/snapshots.ts` SQLite run: 10 s
  - `freshEvidenceFor`: 6 s
  - internal-history: 8–11 s
  - garbage collector: 12–16 s
- **Build 2ac3356**, where GKR scoring is cached:
  - garbage collector: 14–15 s
  - board-service: 5–8 s
  - `runSecondLook`: 7 s
  - internal-history: 7 s
  - `context/match.ts`: 5 s
  - bootstrapInterval/calibrationBuckets: 4–5 s once per hour

Scale:
- The board is about 40k PrizePicks lines and is rebuilt at most every 5 minutes.
- The Edge snapshot SQLite has about 914k rows.
- The heap sits at 3.2–3.7 GB.

## What we need

1. **Root cause of the hard lockup.** Find what can block the single thread indefinitely (or for tens of minutes) about
   15 minutes after startup. Suspects to check, but go wherever the code leads:
   - `apps/api/src/propline-history.ts`, `apps/api/src/player-store.ts`: the SQLite player store. `save()` runs every 10
     minutes (puts every changed player, then `store.prune`). There is also `store.all()` on load, and the in-memory
     cache of players.
   - `apps/api/src/edge/propline-accuracy.ts`, `apps/api/src/scrapers/propline-results.ts`: closing-odds pulls.
   - The PropLine push webhook handler in `server.ts` (`/v1/hooks/propline`), and what it triggers:
     `scrapers/scraper-puller.ts`, `scrapers/line-store.ts`, board rebuild.
   - Heap pressure near the 6 GB limit: GC thrash with no log output. Is anything growing without bound?
   - Any loop that can run forever, for example a `while` over a queue that refills, or a retry with no cap.
2. **A watchdog**, so a lockup costs about 1 minute instead of 30 or more. Our idea:
   - A `worker_threads` worker gets a heartbeat from the main thread.
   - If there's no heartbeat for 60 seconds, the worker writes a diagnostic (a stack or a heap summary if feasible) and
     calls `process.kill(process.pid, 'SIGKILL')`, so Railway's restart-on-failure policy restarts the process.
   - Tell us if there's a better approach, and confirm that Railway restarts on SIGKILL with its default restart policy.
3. **Cut the normal freezes**, in priority order, for anything you find:
   - Large synchronous work on the main thread that could move to a worker or be chunked with `setImmediate`.
   - Heavy allocation that drives GC.

## Rules

- **Don't change any model scores or picks** (GKR, GKR 2, Edge). Speed and stability fixes only. Same inputs, same
  outputs.
- Keep the existing code style: dense TypeScript, comments explain why.
- Checks the patch must pass, from the repo root: `npm run typecheck`, `npm test`, `npm run lint`. Tests use
  `node --import tsx --test`.
- Don't add new paid services or dependencies unless it's necessary, and say why.

## What to send back

1. The root cause, or your top 2–3 candidates with the evidence from the code: file, function, line.
2. A unified diff (patch) against `0439ce3`, or against `2ac3356` if you prefer to keep its caching. Say which one.
3. How to confirm the fix in production: which log lines to watch.
