import type { PropLine } from '@crowniq/contracts';
import type { GameLine, InjuryNote, MarketOdds } from './feeds.js';

// Matches display-only context to one board line. Matching is conservative: when it is unclear, nothing is attached.

export const normalizedName = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[.'’]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const leagueAliases: Readonly<Record<string, string>> = { CFB: 'NCAAF', NCAAFB: 'NCAAF' };
const leagueOf = (value: string) => leagueAliases[value.toUpperCase()] ?? value.toUpperCase();
/** A team's nickname (the last word of its full name, e.g. "Bears"), used to match names across sources. */
const nickname = (value: string) => normalizedName(value).split(' ').at(-1) ?? '';
const sameTeam = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a || !b) return false;
  const x = normalizedName(a), y = normalizedName(b);
  return x === y || (x.split(' ').length > 1 && y.split(' ').length > 1 && nickname(a) === nickname(b));
};
const lineTeams = (line: PropLine) => [line.homeTeam, line.awayTeam, line.team, line.opponent]
  .filter((value): value is string => !!value);

export function injuryFor(line: PropLine, injuries: readonly InjuryNote[]): InjuryNote | null {
  const name = normalizedName(line.playerName);
  const found = injuries.filter((item) => leagueOf(item.league) === leagueOf(line.league) &&
    normalizedName(item.player) === name);
  const onTeam = found.filter((item) => !line.team || sameTeam(item.team, line.team) ||
    item.teamAbbreviation?.toUpperCase() === line.team.toUpperCase());
  return onTeam.length === 1 ? onTeam[0] : null;
}

export function gameLinesFor(line: PropLine, lines: readonly GameLine[]): GameLine[] {
  const start = Date.parse(line.eventStartTime), teams = lineTeams(line);
  return lines.filter((item) => leagueOf(item.league) === leagueOf(line.league) &&
    Math.abs(Date.parse(item.startTime) - start) <= 6 * 3600_000 &&
    teams.some((team) => sameTeam(team, item.home)) && teams.some((team) => sameTeam(team, item.away)));
}

/** Prediction markets whose title names both of the game's teams (by nickname) and that close near the game. */
export function marketsFor(line: PropLine, markets: readonly MarketOdds[], games: readonly GameLine[]): MarketOdds[] {
  const game = games[0];
  if (!game) return [];
  const names = [nickname(game.home), nickname(game.away)];
  const start = Date.parse(line.eventStartTime);
  return markets.filter((item) => {
    const title = normalizedName(`${item.eventTitle} ${item.question}`);
    const closes = item.closeTime ? Date.parse(item.closeTime) : start;
    return names.every((name) => name && title.split(' ').includes(name)) &&
      closes >= start - 6 * 3600_000 && closes <= start + 7 * 86_400_000;
  }).slice(0, 4);
}
