// The matchup line on cards and the player page, kept free of React so tests can load it.

export function matchup(line: { opponent: string | null; eventName: string; league?: string }): string {
  if (line.opponent) return `vs ${line.opponent}`;
  // Some feeds send an internal id as the event name ("LOL JDGSR46300.2916666667"); show a plain label instead.
  return /\d{4,}|\d\.\d{3,}/.test(line.eventName) ? `${line.league ?? ''} match`.trim() : line.eventName;
}
