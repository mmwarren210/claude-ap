# Proposal: game script from Kalshi, Polymarket and Pinnacle

Status: **write-up and shadow run approved** (owner, 2026-10-05). Nothing here changes a GKR score. Step 1 (the shadow
record) is next after the sportsbook and market tabs; step 3 needs the owner's approval and ships as new, opt-in model
versions.

## The idea

How a game is expected to go changes what players do in it. The markets already price that:

- **Big favorite.** A team favored by 7+ points tends to lead, so it runs the ball more late. Its running back's carries
  and rushing yards go up; its QB's pass attempts go down. The underdog's QB throws more while trailing.
- **High or low total.** A game expected to score a lot (total 50+) means more plays, yards and points for both sides. A
  low total (under 40) means fewer.
- **Close game.** A near pick'em keeps starters in for all four quarters, which helps every volume stat.

GKR's history models see a player's recent and season averages, but not the game they are about to play. Game script
is the missing piece.

## Where the numbers come from

| Source | What it gives | How often | Cost |
|---|---|---|---|
| Pinnacle (Apify feed) | No-vig win chance, spread, total | 9 AM and 3 PM ET | Already paid |
| Kalshi (Apify feed) | Win chance per team | 11 AM ET | Already paid |
| Polymarket (Apify feed) | Win chance, spreads, totals | 11 AM ET | Already paid |

Pinnacle is the main input: it has both the spread and the total, and it is the sharpest book. Kalshi and Polymarket are a
check: when all three agree, the read is solid; when they disagree by more than 5 points, the game is left out.

For fresher prices, Kalshi's and Polymarket's free public APIs can be read straight from the server (no Apify cost). This
session's network could not reach them, so that needs one test from the server first.

## The plan

**Step 1. Shadow record, two weeks (no score change).** For every GKR decision on NFL, NBA, WNBA and college football
volume stats (yards, attempts, carries, receptions, points), save the game's expected script at the time of the
decision: favorite and margin, total, and whether the markets agreed. Grading already records each result.

**Step 2. Read the results.** After two weeks (about 600+ graded NFL and college decisions), compare GKR's hit rate when
the script backed its side against when it didn't. For example: GKR said MORE rushing yards and the player's team was a
7+ point favorite.

**Step 3. Only if it earns it.** If picks the script backs hit at least 4 points more often than picks it opposes, over 300+
graded decisions, propose a new opt-in model version (`-GS-1.0`) with a game-script factor. It would carry about 10 of the
100 weight points, taken evenly from the recent-form factors. It runs alongside the current version until the owner
switches it on.

## What it never does

- It never decides a hard gate (lineup, injury, active status).
- It never changes a live GKR score before the owner approves a new version.
- A game the markets disagree on, or one with no price, gets no game-script factor. It never guesses.

## Cost

Nothing new for steps 1 and 2: the feeds already run. Reading Kalshi and Polymarket live would also be free.
