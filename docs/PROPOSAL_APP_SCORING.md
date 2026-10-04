# Proposal: GKR scores on Underdog and Pick6 lines

Status: **Phase 1 approved and running** (owner, 2026-10-04): shadow run on, A and B both included ("all lines need to
score"), go-live bars approved as written. Users see no change until an app passes and the owner turns it on. Anything that
changes model scores needs the owner's approval and ships as new, opt-in model versions.

## Where things stand

- Underdog and Pick6 boards are live. GKR does not score their lines. When PrizePicks has the same player and stat,
  the card shows PrizePicks' number and its GKR score for reference.
- Picks on those apps are saved as the user's own slips and graded from box scores (built 2026-10-04).

Today's boards (Sunday evening, 2026-10-04):

| | Underdog | Pick6 |
|---|---|---|
| Lines (all standard) | 1,587 | 1,991 |
| Same player and stat on PrizePicks | 925 (58%) | 924 (46%) |
| Same player, stat **and number** | 808 (51%) | 793 (40%) |
| PrizePicks line has a GKR play | 5 | 7 |

By league, the matches are mostly MLB (Underdog 420 of 472, Pick6 438 of 618), NHL (300 of 534; 356 of 979) and NFL
(205 of 551; 130 of 394). Esports and the apps' special props ("first TD scorer", period props) don't match.

The GKR play count is low tonight because most of the day's NFL games had started and MLB/NHL lines mostly pass. It
will be higher on a full slate.

## The three ways to score them

**A. Same number, same score.** When the app's line is the same player, stat, number and day as a PrizePicks line,
and the app offers GKR's side, show the PrizePicks GKR score on it. The model is not run again; the inputs are identical.
- Covers about half of each board.
- No extra cost.
- Lowest risk.

**B. Different number, same research.** When the app's number differs (for example, Underdog 58.5 and PrizePicks 56.5),
run the same approved model on the app's number, using the research already gathered for the PrizePicks line.
- Covers the rest of the matched lines.
- No extra cost.
- The score moves with the number, which is the whole point for line shopping.

**C. App-only players.** Research players PrizePicks doesn't list.
- Uses Stat API lookups and context refresh.
- Has a real cost.
- Leave this for later.

## Payouts are different, and that matters

PrizePicks pays a fixed table, so one bar works for every pick: about 54.2% per pick for a 5–6 pick Flex. Underdog and
Pick6 put a multiplier on each side (for example Higher 1.82x, Lower 1.9x), so the bar to break even moves from pick to
pick. A GKR score says how strong the read is. It does not say whether that app's payout makes the pick worth it.

Proposal: the score stays the model's score, unchanged. The card also shows the app's multiplier, and the go-live
check below measures hit rate against each app's own break-even.

## Plan

**Phase 1: shadow run, 2 weeks, nothing visible to users**
- Score app lines with A and B under shadow versions (the approved model name plus `-UD-SHADOW` or `-P6-SHADOW`).
- Keep these in a separate shadow record, never in GKR's tracked record, Top Picks or Social.
- Grade them from box scores, like everything else.

**Phase 2: go-live check (around 2026-10-19)**

Turn on scoring for an app only if, on its shadow picks scoring 80 or higher:
1. at least 150 are graded,
2. they hit at least 56%. That clears the 3–5 pick break-even on standard payouts, about 55% per pick; a 2-pick
   entry needs about 57.7%. And
3. they hit within 3 points of GKR's PrizePicks picks over the same two weeks.

If an app passes, its lines show GKR scores and Top Picks gets an app filter, as opt-in versions you approve. If it
fails, it stays reference-only and I report why.

## What I need from you

1. **Approve Phase 1?** It's a shadow run only. Users see no change and there's no extra cost.
2. **Include B (different numbers)**, or start with A (same number) only?
3. **Are the go-live bars OK?** At least 150 graded, at least 56% hit rate, within 3 points of PrizePicks GKR.

## Picks in the apps themselves

None of the three apps publishes a link that pre-fills an entry. CrownIQ copies the picks and opens the app (see the
Crown tab's **Play it on**). Pre-filled entries would need a partner agreement with each app. That's a business step
for you to pursue if you want it.

## Decisions (owner, 2026-10-04)

1. Phase 1 approved. Built in `apps/api/src/app-shadow.ts`, record in `app-shadow.json`, report at `/v1/admin/app-shadow`.
   Scores every 15 minutes, grades hourly.
2. All lines score: same-number (A) and different-number (B) lines are both in the shadow. App-only players (C) need
   Stat API research for players PrizePicks doesn't list; next step, inside the existing Stat API row budget.
3. Go-live bars approved: at least 150 graded plays scoring 80+, at least 56% hit rate, within 3 points of PrizePicks GKR.

## Owner override: score everything (2026-10-04)

The owner asked for GKR to score every line now, Underdog and Pick6 included, without waiting for the go-live check:

- **App boards:** GKR scores show on every Underdog/Pick6 line PrizePicks also lists, at the app's own number, with a
  GKR picks filter (`CROWNIQ_APP_GKR_SCORES=true`). The shadow record keeps measuring them against the bars above.
- **Stat-history set 2** (`GKR_MODEL_PRESET=stat_history_v2`): 59 more stats, each a new `-SH2-` model version.
  MLB and NFL from Stat API game logs (total bases, singles, doubles, triples, RBIs, runs, stolen bases, hitter
  strikeouts, pitcher hits/walks/earned runs/outs/pitches/batters faced; rush+rec and pass+rush yards, TDs,
  interceptions, tackles, sacks, kicking, longest plays, punts, completion %). NHL, soccer and college football from
  ESPN's public game logs (shots, goals, assists, points, plus/minus; soccer shots, shots on target, goals, assists,
  fouls; college passing, rushing and receiving).
- **Gates kept:** batters need the posted lineup and pitchers the probable start; NFL, NHL, soccer and college players
  must be active and uninjured on the roster; NHL goalies need a confirmed start (no source yet, so saves wait) and
  soccer keepers the posted lineup.
- **Still unscored:** quarter/half/inning splits, esports, tennis, NASCAR, fantasy scores, and stats no source carries
  (NHL hits, blocks, faceoffs; soccer tackles and passes; app-only players without a PrizePicks match).
