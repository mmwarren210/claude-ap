# Profile-first sign-in

## Current behavior

The app opens on **Create your profile** or **Sign in**. Registration asks for a unique display username (3–24 letters, numbers or underscores), email and a password of at least 12 characters. No access code is required. The username is public if the user deliberately shares a Crown to Social; email and account IDs are private. Profiles begin on a `FREE` plan. The plan field prepares an eventual owner-approved entitlement system; it does not enforce a paywall.

The server stores salted scrypt password hashes and hashed 30-day session tokens in the existing `CROWNIQ_PRODUCT_LEDGER_FILE`. That file is server only (mode 0600), and the v1 ledger is migrated to v2 without removing historical decisions. Running multiple API processes against one JSON file is **not supported**; use a durable volume and a single API process. Back up this file: losing it loses account access and saved private picks. This is the same persistent product ledger used for canonical result grades.

Registration and login are public; normal Board, Rankings, history, Social reads and private records require a signed-in account in the deployed API. The owner API remains separate and only accepts `ADMIN_TOKEN`. A user profile cannot trigger a provider pull. Read and save operations use only the latest already-published board. Requests that save an expired, stale or PASS line are rejected.

**Save pick** on Board or Player Detail saves the current exact line and analysis to the user's private profile. **Add to Crown** creates a profile-scoped draft on that device. **Save private Crown** validates all current legs through the existing Crown audit and saves the immutable selection snapshots to the account. The My Picks tab retrieves selections and private Crowns from the server after sign-in, including canonical grades. Repeating a save returns the existing record. Removal hides an item from the profile and leaves the original canonical result archive intact. **Share to Social** is a distinct, explicit public action.

Device-local filters and unsaved Crown drafts are keyed by the public profile ID; they do not automatically follow users to another device. The previous anonymous device draft is not imported into any newly created account, so it cannot become another person's private Crown by accident.

## Lite and Full board views

The Board header and Settings offer a **Lite / Full** choice. New profiles begin in Lite. The choice is stored with that profile's device-local preferences and survives app restarts after the user signs in again. Earlier saved drafts load as Lite while retaining their filters and Crown legs. Switching views does not fetch a new provider board, start research, modify a GKR result or change saved picks.

- **Lite:** shows up to 20 lines in the server's current `rankedLineIds` order after sport and market filters. It displays only currently graded PLAYABLE, CROWN_STRONG or CROWN_ELITE lines, with their exact direction, GKR score, evidence quality, board freshness and danger flag. A missing qualifying result produces an honest empty state with a path to Full. A line chosen from Full's ladder cannot replace Lite's ranked best line.
- **Full:** retains every available provider line, including PASS, with direction, grade, line type, evidence and event filters. Player Detail reveals breakdown, risks, line ladder and verified tracked history; Lite offers a one-tap switch to this detail.

Both views use the identical saved board and engine decisions. Normal Refresh retrieves the server's latest saved board and does not spend Odds API credits. Account access and future paid entitlements are independent of the view setting.

## Sessions and sign-in providers

The current Expo Go, Android and web implementation supports **email + password**. **Web (owner decision, 2026-10-04):** the web app keeps the session token in browser localStorage and stays signed in until **Log Out**; the server ends every session after 30 days. The tradeoff, accepted by the owner: anyone using that browser can open the account, and malware or a malicious script on the device could read the token. A secure-cookie design remains the stronger option later. **Native builds** still keep the token in app memory only (never AsyncStorage or Expo FileSystem) until an SDK-compatible secure native store is installed, checked and shipped. Signing out revokes the token on the server and clears it from the browser.

The server also implements `/v1/auth/nonce`, `/v1/auth/provider` and `/v1/auth/link` for Apple and Google ID tokens. Verification pins the provider's published JWKS URL, checks signature, issuer, exact configured audience, expiry and a short-lived single-use nonce. Linking requires an existing authenticated profile. A provider login whose email matches an existing password account must explicitly link; it cannot silently take over that account. **The mobile Apple and Google buttons are not yet enabled.** They require SDK-compatible native modules, provider registrations/client IDs, redirect/entitlement configuration and actual-device testing. Never put a provider client secret or private key in Expo. `CROWNIQ_GOOGLE_CLIENT_IDS` and `CROWNIQ_APPLE_CLIENT_IDS` are comma-separated allowed token audiences on the server. Leave them empty to disable provider login. Native package installation was blocked by a package-source proxy timeout during implementation; no untested module was added to the bundle.

Email verification, password reset, account recovery, session management and multi-process transactional storage remain necessary before treating this as a production-ready account system or enabling paid subscriptions. Current server rate limiting is in process; production ingress should provide persistent per-IP abuse controls and TLS. App login via local IP is for throwaway test credentials only.

## Run on iPhone, Android or web

1. Set a **persistent** `CROWNIQ_PRODUCT_LEDGER_FILE` in `apps/api/.env`; do not put it in mobile environment variables. Run one API process.
2. For Expo Go on a phone, set `API_HOST=0.0.0.0` on the API and `EXPO_PUBLIC_API_URL=http://YOUR_COMPUTER_LAN_IP:3000` in `apps/mobile/.env`. Keep the phone and computer on the same reachable network. Use test credentials only with local HTTP.
3. Start `npm run dev:api` and `npm run dev:mobile`; scan the Expo QR code in Expo Go on iPhone or Android. Create a profile, select a username and sign in. The API must be reachable before registration succeeds.
4. To test the web build or PWA, set `EXPO_PUBLIC_API_URL` to the HTTPS API URL and set `CROWNIQ_ALLOWED_WEB_ORIGINS` to the exact HTTPS origin serving the app. Build with `npx expo export --platform web` from `apps/mobile` if needed. A public deployment needs a proper web host and TLS; static export alone does not publish the app.
5. If the Board is empty after sign-in, this means the server has not published a current board. Only the owner's existing refresh flow can pull odds. Profile registration, opening My Picks and the normal app refresh do not spend provider credits.

API routes: `POST /v1/auth/register`, `POST /v1/auth/login`, `GET /v1/auth/me`, `POST /v1/auth/logout`; authenticated `GET/POST /v1/me/picks`, `DELETE /v1/me/picks/:id`, `GET/POST /v1/me/crowns`, `DELETE /v1/me/crowns/:id`. The same bearer token authorizes Social profile, share and follow operations, with private selections hidden from public API views.
