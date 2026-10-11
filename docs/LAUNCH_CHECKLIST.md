# Before CrownIQ goes paid: launch checklist

Decisions the owner asked to settle **before** paid subscriptions go live. Nothing here is decided yet.

## 1. Screenshot submissions per paid tier (owner, 2026-10-11)

Beta rule today: **2 screenshots a day for everyone** (lifetime testers, members, 2-day trial users), **unlimited for the owner**.
The limit lives in `USER_DAILY_UPLOADS` (`apps/api/src/tips.ts`).

To decide before launch:
- Screenshots a day for each paid tier (e.g. a basic tier vs a premium tier).
- Whether 2-day trial users keep any screenshots.
- A daily spending cap for the AI that checks screenshots (cost is about $0.25–0.45 per screenshot; duplicates are free).

## 2. Seats and trials

- 20 lifetime testers, 100 member seats, 10 two-day trial keys (outside the seats). Trial users who sign up from their key
  take a seat. Decide how a trial converts to a *paid* plan once payments exist.

## 3. Trial protection

- Trial accounts see a watermark and no explanations on screen. Before launch, decide whether the server should also strip
  the explanations from what it sends trial accounts (today they are hidden on screen only).
