// What a web link asks for. Kept free of device APIs so it runs anywhere, tests included.

/** A web link with `?demo` in it (for example `https://<server>/?demo`) opens straight into demo mode. */
export function startsInDemo(search=typeof window!=='undefined'?window.location?.search:undefined):boolean{
  return !!search && new URLSearchParams(search).has('demo') && !guestCode(search);
}

/** The code in a guest link (`https://<server>/?guest=<code>`), or null. */
export function guestCode(search=typeof window!=='undefined'?window.location?.search:undefined):string|null{
  return search ? new URLSearchParams(search).get('guest')?.trim() || null : null;
}
