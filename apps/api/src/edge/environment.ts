import type { PropLine } from '@crowniq/contracts';
import { marketProfiles, profileKey, scoringMarket } from '@crowniq/edge';
import type { StatRow } from '@crowniq/edge';
import type { GameLine } from '../context/feeds.js';
import { teamsMatch } from './market-map.js';

// Edge projection 2.0 (spec §5), the parts CrownIQ's data supports today:
// - §5.1 team environment: Pinnacle's game total and spread give each team's implied points / runs / goals; a team expected
//   to score more than the league's typical game lifts its players' volume stats (and an opponent expected to score more
//   lifts a pitcher's "allowed" stats). Elasticity 1 for scoring events (TDs, goals; ±25%), 0.5 for volume stats, 0.2 for
//   the rest (±10%).
// - §5.5 rest: back-to-back games, with the effect learned from CrownIQ's own game rows per sport and stat, used only when
//   its 90% interval excludes "no effect" (n ≥ 30).
// Opponent defense (§5.2), usage when a teammate is out (§5.3) and minutes mixtures (§5.4) need team and opponent on each
// game row, which CrownIQ's history doesn't carry yet.

const volume = /points|pts|yds|yards|reception|rec_|hits|bases|runs|rbis|shots|goals|assists|fantasy|threes|rebounds|attempts|completions|targets|saves|sot/;
const allowed = /hits_allowed|earned_runs|walks_allowed|pitcher_hits|pitcher_earned|pitcher_walks/;

// Pinnacle's league names → CrownIQ sports, so board lines (whose league labels vary by app) find their games. Other leagues
// (soccer) are matched on the line's own league label.
const leagueSports: Readonly<Record<string, string>> = { NFL: 'NFL', NCAAF: 'NCAAFB', NCAAFB: 'NCAAFB', CFB: 'NCAAFB', NBA: 'NBA',
  WNBA: 'WNBA', MLB: 'MLB', NHL: 'NHL' };
const groupOf = (league: string) => leagueSports[league.toUpperCase()] ?? league.toUpperCase();
const groupForLine = (line: PropLine) => Object.values(leagueSports).includes(line.sport) ? line.sport : line.league.toUpperCase();

export interface Adjustment { readonly factor: number; readonly reasons: string[] }

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]!; };
const fmt = (value: number) => (Math.round(value * 10) / 10).toString();

export class GameEnvironment {
  private readonly games = new Map<string, { home: string; away: string; start: number; total: number; spread: number }[]>();
  private readonly baselines = new Map<string, number>();

  constructor(lines: readonly GameLine[]) {
    const byGame = new Map<string, { league: string; home: string; away: string; start: number; total?: number; spread?: number }>();
    for (const line of lines) {
      if (line.line === null || (line.market !== 'total' && line.market !== 'spread')) continue;
      const key = `${groupOf(line.league)}|${line.home}|${line.away}|${line.startTime.slice(0, 13)}`;
      const game = byGame.get(key) ?? { league: groupOf(line.league), home: line.home, away: line.away, start: Date.parse(line.startTime) };
      if (line.market === 'total') game.total = line.line; else game.spread = line.line;
      byGame.set(key, game);
    }
    for (const game of byGame.values()) {
      if (game.total === undefined || game.spread === undefined) continue;
      const list = this.games.get(game.league) ?? [];
      list.push({ home: game.home, away: game.away, start: game.start, total: game.total, spread: game.spread });
      this.games.set(game.league, list);
    }
    for (const [league, games] of this.games) if (games.length >= 4)
      this.baselines.set(league, median(games.flatMap((game) => [game.total / 2 - game.spread / 2, game.total / 2 + game.spread / 2])));
  }

  /** Leagues with a baseline, and the games each has. */
  summary(): Record<string, number> {
    return Object.fromEntries([...this.baselines.keys()].map((league) => [league, this.games.get(league)?.length ?? 0]));
  }

  /** The stats-projection multiplier for a line's game, or null without a Pinnacle game, a team, or a league baseline. */
  factor(line: PropLine): Adjustment | null {
    const league = groupForLine(line), baseline = this.baselines.get(league);
    if (!baseline || !line.team) return null;
    const start = Date.parse(line.eventStartTime);
    const game = (this.games.get(league) ?? []).find((item) => Math.abs(item.start - start) <= 6 * 3600_000 &&
      (teamsMatch(line.team!, item.home) || teamsMatch(line.team!, item.away)));
    if (!game) return null;
    const home = teamsMatch(line.team, game.home) && !teamsMatch(line.team, game.away);
    // Pinnacle's spread is the home team's handicap (negative = favourite).
    const own = home ? game.total / 2 - game.spread / 2 : game.total / 2 + game.spread / 2;
    const opponent = game.total - own;
    const pitcherAllowed = allowed.test(line.market);
    const implied = pitcherAllowed ? opponent : own;
    // Scoring events (TDs, goals) rise and fall with the team's expected scoring one for one, within ±25%.
    const scoring = scoringMarket(line.market);
    const elasticity = scoring ? 1 : pitcherAllowed || volume.test(line.market) ? .5 : .2;
    const factor = Math.min(scoring ? 1.25 : 1.1, Math.max(scoring ? .75 : .9, (implied / baseline) ** elasticity));
    if (Math.abs(factor - 1) < .01) return null;
    return { factor, reasons: [`Game total ${fmt(game.total)}: ${pitcherAllowed ? 'the opponent' : 'the team'} is expected to score ${fmt(implied)} vs ` +
      `${fmt(baseline)} in a typical ${league} game today, so the stats projection is ×${factor.toFixed(2)}.`] };
  }
}

export interface RestEffect { readonly coefficient: number; readonly n: number; readonly low: number; readonly high: number }

/**
 * The back-to-back effect per profile sport:market, learned from CrownIQ's game rows: each back-to-back game's value over
 * the player's own average. Kept only when n ≥ 30 and the 90% interval excludes 1 (spec §5.5).
 */
export function restEffects(players: Iterable<{ sport: string; rows: readonly StatRow[] }>): Map<string, RestEffect> {
  const ratios = new Map<string, number[]>();
  for (const { sport, rows } of players) {
    if (sport !== 'NBA' && sport !== 'WNBA' && sport !== 'NHL') continue;
    if (rows.length < 10) continue;
    const sorted = [...rows].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const times = sorted.map((row) => Date.parse(row.occurredAt));
    for (const [key, profile] of Object.entries(marketProfiles)) {
      if (!key.startsWith(sport + ':')) continue;
      const market = key.slice(sport.length + 1);
      // Each game's value: the stored market value, else the stat from the box score; DNPs (zero opportunity) are skipped.
      const value = (row: StatRow) => profile.stat?.opportunity?.(row.metrics) === 0 ? null
        : Number.isFinite(row.marketValues?.[market]) ? row.marketValues![market]! : profile.stat?.value(row.metrics) ?? null;
      let sum = 0, count = 0;
      const values = sorted.map((row) => { const v = value(row); if (v !== null && Number.isFinite(v)) { sum += v; count++; return v; } return null; });
      if (count < 10 || sum <= 0) continue;
      const mean = sum / count;
      let list = ratios.get(key);
      let previous: number | null = null;
      for (let index = 0; index < sorted.length; index++) {
        const current = values[index];
        if (current === null || current === undefined) continue;
        if (previous !== null && times[index]! - previous < 30 * 3600_000) {
          if (!list) { list = []; ratios.set(key, list); }
          list.push(current / mean);
        }
        previous = times[index]!;
      }
    }
  }
  const effects = new Map<string, RestEffect>();
  for (const [key, list] of ratios) {
    if (list.length < 30) continue;
    const mean = list.reduce((a, b) => a + b, 0) / list.length;
    const se = Math.sqrt(list.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (list.length - 1) / list.length);
    const low = mean - 1.645 * se, high = mean + 1.645 * se;
    if (low > 1 || high < 1) effects.set(key, { coefficient: Math.min(1.08, Math.max(.92, mean)), n: list.length, low, high });
  }
  return effects;
}

/** The rest multiplier for a line: its learned back-to-back effect when the player's last game was under 30 hours before. */
export function restFactor(line: PropLine, lastGameAt: number | null, effects: ReadonlyMap<string, RestEffect>): Adjustment | null {
  if (lastGameAt === null || Date.parse(line.eventStartTime) - lastGameAt >= 30 * 3600_000) return null;
  const effect = effects.get(profileKey(line.sport, line.market) ?? `${line.sport}:${line.market}`);
  if (!effect) return null;
  return { factor: effect.coefficient, reasons: [`Second game of a back-to-back: CrownIQ's history has players at ×${effect.coefficient.toFixed(2)} ` +
    `of their average in these (${effect.n} games).`] };
}
