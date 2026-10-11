# Before CrownIQ goes paid: launch checklist

Decisions the owner asked to settle **before** paid subscriptions go live. Nothing here is decided yet.

## 1. Screenshot submissions per paid tier (owner, 2026-10-11)

Beta rule today: **2 screenshots a day for everyone** (lifetime testers, members, 2-day trial users), **unlimited for the owner**.
The limit lives in `USER_DAILY_UPLOADS` (`apps/api/src/tips.ts`).

To decide before launch:
- Screenshots a day for each paid tier (e.g. a basic tier vs a premium tier).
- Whether 2-day trial users keep any screenshots.
- Prices per plan: the end-of-trial poll asks trial users which length (1 week to lifetime) and what price range feels fair (admin `/v1/admin/trial-poll`).
- A daily spending cap for the AI that checks screenshots (cost is about $0.25–0.45 per screenshot; duplicates are free).

## 2. Seats and trials

- 20 lifetime testers, 100 member seats, 10 two-day trial keys (outside the seats). Trial users who sign up from their key
  take a seat. Decide how a trial converts to a *paid* plan once payments exist.

## 3. Trial protection

- Trial accounts see a watermark and no explanations on screen. Before launch, decide whether the server should also strip
  the explanations from what it sends trial accounts (today they are hidden on screen only).

## 4. Draft prices (owner, 2026-10-11): not public yet

Base: **1 month = $25**. Longer plans cost less per month. Final numbers wait for the trial poll. When set, they go in the
Railway variable `CROWNIQ_PLAN_PRICES` (e.g. `{"WEEK":9,"MONTH":25,"QUARTER":65,"HALF_YEAR":120,"YEAR":210}`);
until then the Subscribe screen says prices are being finalized. Trial users get 10% off.

| Plan | Days | Price | Per month | Saving vs monthly | With 10% sign-up discount |
|---|---|---|---|---|---|
| 1 week | 7 | $9 | ~$39 | — | $8.10 |
| 1 month | 31 | $25 | $25 | — | $22.50 |
| 3 months | 93 | $65 | ~$21.67 | 13% | $58.50 |
| 6 months | 186 | $120 | $20 | 20% | $108 |
| 1 year | 365 | $210 | $17.50 | 30% | $189 |
| ~~Lifetime~~ | removed (owner, 2026-10-11) | | | | |

No lifetime plan (owner, 2026-10-11).
Payment approval: members tap "I've paid"; the owner approves in More › Account › Member access (Waiting for approval),
picking the time frame; time stacks on any plan already running.
