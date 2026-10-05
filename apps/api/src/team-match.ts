import { normalizedName } from './context/match.js';

// Team names differ by source: "Chicago White Sox", "Chicago WS", "CHW White Sox", "White Sox". Two names are the same
// team when they match whole, by nickname, by one starting the other, or by city plus the nickname's initials.

// Names repeat thousands of times per refresh, so each is normalized once.
const wordCache = new Map<string, string[]>();
const words = (name: string) => {
  let found = wordCache.get(name);
  if (!found) { found = normalizedName(name).split(' ').filter(Boolean); if (wordCache.size > 20_000) wordCache.clear(); wordCache.set(name, found); }
  return found;
};

export function sameTeam(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return false;
  const joinedX = x.join(' '), joinedY = y.join(' ');
  if (joinedX === joinedY || joinedX.startsWith(`${joinedY} `) || joinedY.startsWith(`${joinedX} `)) return true;
  // Same nickname (last word), unless it's a one-letter or generic word.
  const lastX = x.at(-1)!, lastY = y.at(-1)!;
  if (lastX === lastY && lastX.length > 2 && !['city', 'united', 'fc', 'sc', 'cf'].includes(lastX)) return true;
  // City plus initials: "chicago ws" and "chicago white sox".
  for (const [short, long] of [[x, y], [y, x]] as const) {
    if (short.length === 2 && long.length >= 3 && short[0] === long[0] &&
      short[1] === long.slice(1).map((word) => word[0]).join('')) return true;
  }
  return false;
}

/** Same game: same teams (either order of home and away is not accepted) starting within three hours. */
export function sameGame(a: { home: string; away: string; startTime: string }, b: { home: string; away: string; startTime: string }) {
  return Math.abs(Date.parse(a.startTime) - Date.parse(b.startTime)) <= 3 * 3600_000 && sameTeam(a.home, b.home) &&
    sameTeam(a.away, b.away);
}
