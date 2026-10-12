// What a web link asks for. Kept free of device APIs so it runs anywhere, tests included.

const current = () => typeof window !== 'undefined' ? window.location?.search : undefined;
// The address the page was opened with, read once when the app loads (owner, 2026-10-12): a guest link opened while signed out
// is sent on to the sign-in page, and that move drops `?guest=…`. Read later (at the Start tap), the code was gone and the
// pass never showed.
const opened = current();

/** A web link with `?demo` in it (for example `https://<server>/?demo`) opens straight into demo mode. */
export function startsInDemo(search = opened ?? current()): boolean {
  return !!search && new URLSearchParams(search).has('demo') && !guestCode(search);
}

/** The code in a guest link (`https://<server>/?guest=<code>`), or null: from the given address, else the one the page opened with. */
export function guestCode(search: string | undefined = opened ?? current()): string | null {
  return search ? new URLSearchParams(search).get('guest')?.trim() || null : null;
}
