# Deploying the CrownIQ API server

The API server runs all day: it pulls lines on a schedule, refreshes player context every 15 minutes and serves the app.
It keeps its data as files, so the host needs a **permanent disk**. Supabase is a database and login service, not a host
for a long-running server, so it is not used here (it could hold the data later if we move off files).

## Railway (recommended: simplest)

1. Sign in at railway.com with GitHub, then **New Project → Deploy from GitHub repo → `mmwarren210/claude-ap`**.
   Pick the branch to run (`claude/crowniq-redesign` until it is merged); `main` does not have the server setup yet.
   `railway.json` tells Railway to build with the `Dockerfile` and check `/health`.
2. **Add a volume** to the service and mount it at **`/data`**. Everything the server saves goes there
   (board, lines, picks, accounts, spend counters), so it survives restarts and redeploys.
3. **Variables** (service → Variables). Paste values in Railway, never in chat or the repo:
   - `ODDS_PROVIDER=scrapers`
   - `APIFY_TOKEN` (Apify → Settings → API & Integrations)
   - `THE_ODDS_API_KEY` (optional third PrizePicks source, used on the owner's pull)
   - `CROWNIQ_OWNER_PUBLIC_ID` (your profile id in the app) and `ADMIN_TOKEN` (any long random string)
   - `OPENAI_API_KEY` for web research, and later `ANTHROPIC_API_KEY`
   - Optional schedule and spend settings from `.env.example` (`CROWNIQ_SCRAPER_*`, `CROWNIQ_CONTEXT_*`)
4. **Settings → Networking → Generate domain.** That gives a URL like `https://crowniq-api.up.railway.app`.
5. Check `https://<your-domain>/health` shows `{"status":"ok", ...}`. The live server is
   `https://claude-ap-production.up.railway.app`.
6. Open the app: the server also hosts the web version of the app at its own address
   (`https://claude-ap-production.up.railway.app`). On a phone, open it in the browser and use **Share → Add to Home
   Screen**. The Docker build exports it with `npx expo export -p web`; with `EXPO_PUBLIC_API_URL` unset, the web app
   calls the server it was loaded from.
7. For the phone app (Expo Go or a store build): set `EXPO_PUBLIC_API_URL=https://<your-domain>` in `apps/mobile/.env` (and in the app's build
   settings when it is published). A web app hosted somewhere else needs its address in `CROWNIQ_ALLOWED_WEB_ORIGINS`.

## Render (alternative)

New **Web Service** from the repo (Docker), a paid instance with a **Disk** mounted at `/data`, the same variables,
and Render's URL in `EXPO_PUBLIC_API_URL`.

## Notes

- One server instance only: the scheduled pulls and data files assume a single running copy.
- The server takes its port from `PORT`, which the host sets; `API_PORT` overrides it.
- `CROWNIQ_DATA_DIR` (set to `/data` in the Dockerfile) moves every data file at once.
