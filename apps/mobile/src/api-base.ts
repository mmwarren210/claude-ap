/**
 * The CrownIQ server address: EXPO_PUBLIC_API_URL when set; otherwise, in a browser, the site the
 * web app was loaded from (the server hosts the web app itself).
 */
export function apiBaseUrl(configured=process.env.EXPO_PUBLIC_API_URL,
  location:{origin?:string}|undefined=(globalThis as {location?:{origin?:string}}).location):string|undefined{
  const set=configured?.trim().replace(/\/$/,'');
  if(set)return set;
  return location?.origin?.startsWith('http')?location.origin:undefined;
}
