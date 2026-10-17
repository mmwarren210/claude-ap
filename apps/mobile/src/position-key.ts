/** The server's name key (apps/api/src/context/match.ts normalizedName): accents, dots and Jr./III dropped, lower case. */
export const positionKey = (name: string) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[.'’]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
