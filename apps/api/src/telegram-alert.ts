// Server problem alerts to the owner's Telegram (owner, 2026-10-17: "we need notifications for problems like this" after a
// night of 4.5 GB memory and 20-second freezes nobody saw). Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; without them it
// does nothing. Each kind of alert is sent at most once per cooldown so a long problem doesn't flood the phone.

const COOLDOWN_MS = 3 * 60 * 60_000;
const last = new Map<string, number>();
let send: typeof fetch | null = null;

/** Keeps a fetch that bypasses the memory watch's wrapper, so an alert still goes out while that wrapper is busy. */
export function captureAlertFetch(fetchFn: typeof fetch) { send ??= fetchFn; }

/** Sends one alert of this kind unless one went out within the cooldown. Never throws. */
export async function alertOwner(kind: string, text: string, now = Date.now(), env = process.env): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim(), chat = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) return false;
  if (now - (last.get(kind) ?? -Infinity) < COOLDOWN_MS) return false;
  last.set(kind, now);
  try {
    const response = await (send ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: `CrownIQ: ${text}` }),
      signal: AbortSignal.timeout(10_000) });
    return response.ok;
  } catch { return false; }
}

/**
 * The chat that last messaged the bot (the owner pressed Start), for setting TELEGRAM_CHAT_ID. Null when none or no token.
 */
export async function findOwnerChat(env = process.env): Promise<string | null> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  try {
    const response = await (send ?? fetch)(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { result?: { message?: { chat?: { id?: number } } }[] };
    const id = [...(body.result ?? [])].reverse().map((update) => update.message?.chat?.id).find((value) => value !== undefined);
    return id === undefined ? null : String(id);
  } catch { return null; }
}

/** Test hook: forget the cooldowns. */
export function resetAlerts() { last.clear(); }
