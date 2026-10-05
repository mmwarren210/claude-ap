import type { PropLine, Sport } from '@crowniq/contracts';
import type { PickQuestion } from './ai-picks.js';
import type { GameLine, MarketOdds } from './context/feeds.js';
import { normalizedName } from './context/match.js';

// Prediction-market picks (Kalshi, Polymarket): their game markets (winner, spread) priced below Pinnacle's no-vig chance
// for the same game and number. Pinnacle is the sharpest public book, so a market that is cheaper than Pinnacle's fair
// chance is the better buy. GKR doesn't score these (it scores player props); only sides with an edge are kept.

export type MarketPlatform = 'kalshi' | 'polymarket';
export const marketPlatforms: readonly MarketPlatform[] = ['kalshi', 'polymarket'];

export interface MarketPick {
  readonly id: string; readonly platform: MarketPlatform; readonly league: string; readonly game: string;
  readonly startTime: string; readonly kind: 'WINNER' | 'SPREAD' | 'TOTAL' | 'PROP'; readonly side: string; readonly question: string;
  /** A total pick's side and number (graded on the combined score). */
  readonly total?: { readonly side: 'over' | 'under'; readonly line: number };
  /** What backs the price: the market's fair chance (default) or, for props, the player's history alone. */
  readonly by?: 'MARKET' | 'HISTORY';
  /** Why, in plain words. */
  readonly note?: string;
  /** Pinnacle's names for the two teams, which team the side is, and its spread (null for a winner pick), for grading. */
  readonly home: string; readonly away: string; readonly team: 'home' | 'away'; readonly handicap: number | null;
  /** The market's price for this side, 0-1 (cents on the dollar), and the cost per $1 contract with the platform fee. */
  readonly price: number; readonly cost: number;
  /** Pinnacle's no-vig chance of the same side. */
  readonly fair: number;
  /** fair minus cost: what each $1 contract is worth above its cost, on Pinnacle's numbers. */
  readonly edge: number;
  readonly volume24h: number | null; readonly url: string | null;
}

/** The biggest edge believed on a game market; anything above is treated as a mismatch or a stale price. */
export const MAX_MARKET_EDGE = 0.12;

/** Kalshi's trading fee per contract: 7% of price times (1 - price), rounded up to the cent. Polymarket: none. */
export const platformFee = (platform: MarketPlatform, price: number) =>
  platform === 'kalshi' ? Math.ceil(0.07 * price * (1 - price) * 100 - 1e-9) / 100 : 0;

const words = (value: string) => normalizedName(value).split(' ');
const nickname = (team: string) => words(team).at(-1) ?? '';
/** The team named in a market's text: by nickname ("Raiders") or by city, as Kalshi's own titles do ("Las Vegas"). */
export function teamIn(textWords: readonly string[], team: string): boolean {
  if (textWords.includes(nickname(team))) return true;
  const city = words(team).slice(0, -1);
  if (!city.length) return false;
  const joined = ` ${textWords.join(' ')} `;
  return joined.includes(` ${city.join(' ')} `);
}
/** A market's name for a team: its nickname ("Bills"), or how Kalshi names it, the city with a letter ("Los Angeles R"). */
function names(label: string, team: string): boolean {
  const a = normalizedName(label), b = normalizedName(team);
  if (!a) return false;
  return a === b || a === nickname(team) || (a.length >= 4 && b.startsWith(a)) || words(label).at(-1) === nickname(team);
}
const round = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Picks for one platform: for each upcoming game Pinnacle prices, the platform's winner and spread markets naming both
 * teams; a side shows when its cost (price plus fee) is at least minEdge below Pinnacle's fair chance. Strongest first.
 */
export function marketPicks(platform: MarketPlatform, markets: readonly MarketOdds[], games: readonly GameLine[], now: Date,
  minEdge = 0.02): MarketPick[] {
  const picks: MarketPick[] = [];
  const byGame = new Map<string, GameLine[]>();
  for (const line of games) {
    if (Date.parse(line.startTime) <= now.getTime()) continue;
    const key = JSON.stringify([line.league, line.home, line.away, line.startTime]);
    byGame.set(key, [...byGame.get(key) ?? [], line]);
  }
  for (const lines of byGame.values()) {
    const { league, home, away, startTime } = lines[0]!;
    const start = Date.parse(startTime), title = `${away} @ ${home}`;
    const moneyline = lines.find((line) => line.market === 'moneyline');
    const spread = lines.find((line) => line.market === 'spread');
    const mine = markets.filter((market) => {
      if (market.platform !== platform) return false;
      const text = words(`${market.eventTitle} ${market.question}`);
      const closes = market.closeTime ? Date.parse(market.closeTime) : start;
      return teamIn(text, home) && teamIn(text, away) && closes >= start - 6 * 3600_000 &&
        closes <= start + 7 * 86_400_000;
    });
    for (const market of mine) {
      // Full-game markets only: no first half, quarter, period or inning markets.
      if (/\b(1H|2H|1Q|2Q|3Q|4Q|half|quarter|period|inning|innings|set \d|map \d)\b/i.test(market.question)) continue;
      const sides: { side: string; team: 'home' | 'away'; price: number; kind: MarketPick['kind']; handicap: number | null }[] = [];
      const spreadMatch = /^Spread: (.+) \((-?\d+(?:\.\d+)?)\)$/.exec(market.question);
      if (spreadMatch) {
        // Polymarket: "Spread: Bills (-6.5)"; Pinnacle's spread line is the home team's.
        const [, favorite, handicap] = spreadMatch, line = Number(handicap);
        const favoriteTeam = names(favorite!, home) ? 'home' : names(favorite!, away) ? 'away' : null;
        if (!favoriteTeam || !spread || spread.homeFair === null || spread.awayFair === null ||
          (favoriteTeam === 'home' ? spread.line !== line : spread.line !== -line)) continue;
        for (const outcome of market.outcomes) {
          const team = names(outcome.name, home) ? 'home' : names(outcome.name, away) ? 'away' : null;
          if (!team) continue;
          const teamLine = team === favoriteTeam ? line : -line;
          sides.push({ side: `${outcome.name} ${teamLine > 0 ? '+' : ''}${teamLine}`, team, price: outcome.probability / 100, kind: 'SPREAD',
            handicap: teamLine });
        }
      } else if (!/spread|O\/U|total|yards|points|goals|touchdown|ladder|escalator|\+/i.test(market.question) && moneyline &&
        moneyline.homeFair !== null && moneyline.awayFair !== null && moneyline.homeFair + moneyline.awayFair > 0.98) {
        // Winner markets. Kalshi: "X vs Y — Dallas" with Yes/No; Polymarket: outcomes named by team, or "Will X win?".
        const subject = /— (.+)$/.exec(market.question)?.[1] ?? /^Will (.+?) win/.exec(market.question)?.[1] ?? null;
        if (subject) {
          // A name that fits both teams ("New York" for the Islanders and the Rangers) can't be priced, so it's skipped.
          const team = names(subject, home) && names(subject, away) ? null : names(subject, home) ? 'home' : names(subject, away) ? 'away' : null;
          const yes = market.outcomes.find((outcome) => outcome.name === 'Yes');
          if (team && yes) sides.push({ side: `${subject} to win`, team, price: yes.probability / 100, kind: 'WINNER', handicap: null });
        } else for (const outcome of market.outcomes) {
          const team = names(outcome.name, home) && names(outcome.name, away) ? null
            : names(outcome.name, home) ? 'home' : names(outcome.name, away) ? 'away' : null;
          if (team) sides.push({ side: `${outcome.name} to win`, team, price: outcome.probability / 100, kind: 'WINNER', handicap: null });
        }
      }
      for (const { side, team, price, kind, handicap } of sides) {
        const source = kind === 'SPREAD' ? spread! : moneyline!;
        const fair = team === 'home' ? source.homeFair! : source.awayFair!;
        // Long shots and near-locks are left out, and so is an edge too big to be real: a market that far from fair odds is
        // almost always a different market matched by mistake (a series or futures price) or a stale one.
        if (price < 0.15 || price > 0.85) continue;
        const cost = round(price + platformFee(platform, price)), edge = round(fair - cost);
        if (edge < minEdge || edge > MAX_MARKET_EDGE) continue;
        picks.push({ id: `${platform}:${league}:${title}:${market.question}:${side}`, platform, league, game: title,
          startTime, kind, side, question: market.question, home, away, team, handicap, price: round(price), cost, fair: round(fair), edge,
          volume24h: market.volume24h, url: market.url });
      }
    }
  }
  // One pick per game and kind: the biggest edge.
  const best = new Map<string, MarketPick>();
  for (const pick of picks) {
    const key = `${pick.game}|${pick.startTime}|${pick.kind}`;
    if (!best.has(key) || pick.edge > best.get(key)!.edge) best.set(key, pick);
  }
  return [...best.values()].sort((a, b) => b.edge - a.edge);
}

const leagueSport: Readonly<Record<string, Sport>> = { NFL: 'NFL', NCAAF: 'NCAAFB', NCAAFB: 'NCAAFB', MLB: 'MLB', NBA: 'NBA',
  WNBA: 'WNBA', NHL: 'NHL', ATP: 'TENNIS', WTA: 'TENNIS' };

/**
 * A market pick as a line Scout can read: the side as the "player", "wins" (or covers) as the stat, 0.5 as the number, so
 * MORE means it happens. Null for leagues CrownIQ doesn't cover.
 */
export function marketLine(pick: MarketPick, now: Date): PropLine | null {
  const sport = leagueSport[pick.league.toUpperCase()];
  if (!sport) return null;
  return { id: pick.id, provider: 'prizepicks', sourceLineId: pick.id, sourceLineIdIsSynthetic: true, sport, league: pick.league,
    eventId: `market:${pick.game}:${pick.startTime}`, eventName: pick.game, eventStartTime: new Date(pick.startTime).toISOString(),
    playerId: `market:${pick.side}`, playerName: pick.side, team: null, opponent: null,
    market: pick.kind === 'WINNER' ? 'game_winner' : 'game_spread', threshold: 0.5, availableDirections: ['MORE', 'LESS'],
    lineType: 'REGULAR', fetchedAt: now.toISOString() };
}

/** What Scout is asked about a market pick: does this side win (or cover)? */
export function marketQuestion(pick: MarketPick, line: PropLine): PickQuestion {
  return { sport: line.sport, league: pick.league, event: pick.game, startTime: line.eventStartTime, player: pick.side,
    team: null, opponent: null, stat: pick.kind === 'WINNER' ? 'wins the game' : `covers: ${pick.side}`, line: 0.5,
    lineType: 'REGULAR', sides: ['MORE', 'LESS'],
    facts: ['This is a game outcome market, not a player stat. MORE means this side wins (or covers the spread named); ' +
      'LESS means it does not.', `${pick.platform === 'kalshi' ? 'Kalshi' : 'Polymarket'} price: ${Math.round(pick.price * 100)} cents ` +
      'on the dollar.'] };
}
