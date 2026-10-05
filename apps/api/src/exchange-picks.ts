import type { PropLine } from '@crowniq/contracts';
import { syntheticLine } from './book-picks.js';
import { normalizedName } from './context/match.js';
import type { FairPrice, GamePrice, OverOnlyPrice } from './context/sharp-props.js';
import type { GameLine } from './context/feeds.js';
import type { HistoryRead } from './history-read.js';
import { platformFee } from './market-picks.js';
import type { MarketPick } from './market-picks.js';
import { sameGame } from './team-match.js';

// More Kalshi and Polymarket picks (owner, 2026-10-05). Kalshi's winner, spread and total markets in every league
// SharpAPI carries, and its player props (Yes on an over), priced below the sportsbooks' no-vig chance of the same side
// at the same number. Player props also use the same History Read every tab uses: a prop with no book price can still
// show when the player's history clears it by a wide margin, and a prop is dropped when history points the other way.
// Display and shadow tracking only; none of this is a GKR score.

/** The edge a pick needs when the fair chance comes from the sportsbooks (less sharp than Pinnacle, so above 2%). */
export const BOOK_EDGE = 0.03;
/** The edge a prop needs when only the player's history backs it. */
export const HISTORY_EDGE = 0.06;

const exchanges = new Set(['kalshi', 'polymarket']);
const round = (value: number) => Math.round(value * 10_000) / 10_000;
const opposite = { home: 'away', away: 'home', over: 'under', under: 'over' } as const;

/** The books' average no-vig chance of one side of a game line, at the same number; null when no book prices both sides. */
export function bookFair(games: readonly GamePrice[], target: Pick<GamePrice, 'home' | 'away' | 'startTime' | 'market' | 'line' | 'side'>): number | null {
  const books = games.filter((game) => !exchanges.has(game.book) && game.market === target.market && sameGame(game, target));
  const chances: number[] = [];
  for (const book of new Set(books.map((game) => game.book))) {
    const mine = books.filter((game) => game.book === book);
    // A spread side's other half is the other team at the opposite number; a total's is the other side at the same number.
    const line = (side: GamePrice['side']) => target.market === 'spread' && side !== target.side ? -(target.line ?? 0) : target.line;
    const find = (side: GamePrice['side']) => mine.find((game) => game.side === side && game.line === line(side));
    const side = find(target.side), other = find(opposite[target.side]);
    if (side && other) chances.push(side.probability / (side.probability + other.probability));
  }
  return chances.length ? round(chances.reduce((sum, value) => sum + value, 0) / chances.length) : null;
}

/** Kalshi's game markets priced below the books' fair chance: one per game and kind, the biggest edge. */
export function exchangeGamePicks(platform: 'kalshi' | 'polymarket', games: readonly GamePrice[], now: Date): MarketPick[] {
  const best = new Map<string, MarketPick>();
  for (const game of games) {
    if (game.book !== platform || Date.parse(game.startTime) <= now.getTime() || game.probability < 0.15 || game.probability > 0.85) continue;
    const fair = bookFair(games, game);
    if (fair === null) continue;
    const cost = round(game.probability + platformFee(platform, game.probability)), edge = round(fair - cost);
    if (edge < BOOK_EDGE) continue;
    const team = game.side === 'home' || game.side === 'away' ? game.side : 'home';
    const name = game.side === 'home' ? game.home : game.away;
    const kind: MarketPick['kind'] = game.market === 'moneyline' ? 'WINNER' : game.market === 'spread' ? 'SPREAD' : 'TOTAL';
    const side = kind === 'WINNER' ? `${name} to win` : kind === 'SPREAD' ? `${name} ${game.line! > 0 ? '+' : ''}${game.line}`
      : `${game.side === 'over' ? 'Over' : 'Under'} ${game.line} total`;
    const title = `${game.away} @ ${game.home}`;
    const pick: MarketPick = { id: `${platform}:sa:${game.eventId}:${game.market}:${game.side}:${game.line ?? ''}`, platform,
      league: game.league.toUpperCase(), game: title, startTime: game.startTime, kind, side, question: `${title} · ${side}`,
      home: game.home, away: game.away, team, handicap: kind === 'SPREAD' ? game.line : null,
      ...(kind === 'TOTAL' ? { total: { side: game.side as 'over' | 'under', line: game.line! } } : {}),
      price: round(game.probability), cost, fair, edge, volume24h: null, url: platform === 'kalshi' ? 'https://kalshi.com/sports' : null,
      note: `Sportsbooks’ fair chance ${Math.round(fair * 100)}% vs ${Math.round(cost * 100)}¢ with the fee` };
    const key = `${game.eventId}|${kind}`, current = best.get(key);
    if (!current || pick.edge > current.edge) best.set(key, pick);
  }
  return [...best.values()];
}

/**
 * The real start of the game a Kalshi prop is about. Kalshi stamps props with the market's close time (often days after the
 * game), so it's the player's next game the books or PrizePicks list, up to that close time.
 */
export function propStart(offer: OverOnlyPrice, starts: ReadonlyMap<string, readonly string[]>, now: Date): string | null {
  const close = Date.parse(offer.startTime) + 3 * 3600_000;
  const next = (starts.get(JSON.stringify([offer.sport, normalizedName(offer.player)])) ?? [])
    .filter((start) => Date.parse(start) > now.getTime() && Date.parse(start) <= close).sort()[0];
  return next ?? null;
}
/** Each player's game starts across the books' props and the PrizePicks board, for propStart. */
export function playerStarts(prices: readonly FairPrice[], boardLines: readonly PropLine[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (sport: string, player: string, start: string) => {
    const key = JSON.stringify([sport, normalizedName(player)]);
    out.set(key, (out.get(key) ?? new Set()).add(new Date(start).toISOString()));
  };
  for (const price of prices) if (!exchanges.has(price.book)) add(price.sport, price.player, price.startTime);
  for (const line of boardLines) add(line.sport, line.playerName, line.eventStartTime);
  return new Map([...out].map(([key, set]) => [key, [...set]]));
}

/**
 * Board lines for over-only props at their real game time (the PrizePicks player's game when listed, else synthetic), for
 * History Reads. Props whose game can't be found are left out.
 */
export function propLines(offers: readonly OverOnlyPrice[], boardLines: readonly PropLine[], now: Date,
  starts: ReadonlyMap<string, readonly string[]> = playerStarts([], boardLines)): Map<OverOnlyPrice, PropLine> {
  const byPlayer = new Map<string, PropLine[]>();
  for (const line of boardLines) {
    const key = JSON.stringify([line.sport, normalizedName(line.playerName), line.market]);
    byPlayer.set(key, [...byPlayer.get(key) ?? [], line]);
  }
  const out = new Map<OverOnlyPrice, PropLine>();
  for (const offer of offers) {
    const start = propStart(offer, starts, now);
    if (!start) continue;
    const id = `${offer.book}:prop:${offer.sport}:${normalizedName(offer.player)}:${offer.market}:${offer.line}:${start.slice(0, 13)}`;
    const research = (byPlayer.get(JSON.stringify([offer.sport, normalizedName(offer.player), offer.market])) ?? [])
      .find((line) => Math.abs(Date.parse(line.eventStartTime) - Date.parse(start)) <= 3 * 3600_000);
    if (research) {
      const { payoutMultiplier: _payout, ...base } = research;
      out.set(offer, { ...base, id, sourceLineId: id, threshold: offer.line, availableDirections: ['MORE', 'LESS'], lineType: 'REGULAR' });
    } else out.set(offer, syntheticLine(id, { ...offer, startTime: start }, now));
  }
  return out;
}

/**
 * Kalshi's player props (Yes on the over) worth buying: the books' no-vig chance of the over at the same number beats the
 * price plus fee by BOOK_EDGE, or, with no book price there, the History Read backs the over by HISTORY_EDGE. A prop
 * the History Read backs the other way is left out. One per player and stat: the biggest edge.
 */
export function exchangePropPicks(offers: readonly OverOnlyPrice[], prices: readonly FairPrice[],
  lines: ReadonlyMap<OverOnlyPrice, PropLine>, history: ReadonlyMap<string, HistoryRead>, now: Date): MarketPick[] {
  const fairAt = new Map<string, FairPrice[]>();
  for (const price of prices) {
    if (exchanges.has(price.book)) continue;
    const key = JSON.stringify([price.sport, normalizedName(price.player), price.market, price.line]);
    fairAt.set(key, [...fairAt.get(key) ?? [], price]);
  }
  const best = new Map<string, MarketPick>();
  for (const offer of offers) {
    const line = lines.get(offer);
    // Long shots and near-locks are left out: the books' no-vig chance isn't reliable that far from even.
    if (!line || Date.parse(line.eventStartTime) <= now.getTime() || offer.price < 0.2 || offer.price > 0.85) continue;
    // The books' prices for the same game (by its real start), player, stat and number.
    const books = (fairAt.get(JSON.stringify([offer.sport, normalizedName(offer.player), offer.market, offer.line])) ?? [])
      .filter((price) => Math.abs(Date.parse(price.startTime) - Date.parse(line.eventStartTime)) <= 3 * 3600_000).map((price) => price.fairOver);
    const read = history.get(line.id);
    if (read && read.direction === 'LESS' && !read.lean) continue;
    const cost = round(offer.price + platformFee('kalshi', offer.price));
    const fromBooks = books?.length ? round(books.reduce((sum, value) => sum + value, 0) / books.length) : null;
    const fromHistory = read && read.direction === 'MORE' && !read.lean && read.score !== null ? read.score / 100 : null;
    const fair = fromBooks ?? fromHistory;
    if (fair === null) continue;
    const edge = round(fair - cost);
    if (edge < (fromBooks !== null ? BOOK_EDGE : HISTORY_EDGE)) continue;
    const side = `${offer.player} over ${offer.line} ${line.market.replace(/^(player|batter|pitcher)_/, '').replace(/_/g, ' ')}`;
    const pick: MarketPick = { id: line.id, platform: 'kalshi', league: line.league, game: line.eventName, startTime: line.eventStartTime,
      kind: 'PROP', side, question: side, home: offer.home ?? '', away: offer.away ?? '', team: 'home', handicap: null,
      price: round(offer.price), cost, fair, edge, volume24h: null, url: 'https://kalshi.com/sports',
      by: fromBooks !== null ? 'MARKET' : 'HISTORY',
      note: [fromBooks !== null ? `Sportsbooks’ fair chance ${Math.round(fromBooks * 100)}%` : null,
        read ? `History: ${read.text}` : null].filter(Boolean).join(' · ') };
    const key = `${line.eventId}|${line.playerId}|${line.market}`, current = best.get(key);
    if (!current || pick.edge > current.edge) best.set(key, pick);
  }
  return [...best.values()];
}

/**
 * The sportsbooks' no-vig game lines in Pinnacle's shape, for Polymarket and Kalshi winner and spread checks when Pinnacle
 * is out of date or doesn't carry the game.
 */
export function consensusGameLines(games: readonly GamePrice[]): GameLine[] {
  const out: GameLine[] = [];
  for (const game of games) {
    if (exchanges.has(game.book) || game.market === 'total' || game.side !== 'home') continue;
    // Books can file the same game under different ids: one line per game (by teams and start) and number.
    if (out.some((line) => line.market === game.market && line.line === game.line && sameGame(line, game))) continue;
    const homeFair = bookFair(games, game);
    if (homeFair === null) continue;
    out.push({ league: game.league.toUpperCase(), home: game.home, away: game.away, startTime: game.startTime, market: game.market,
      line: game.line, homePrice: null, awayPrice: null, homeFair, awayFair: round(1 - homeFair), sourceUrl: null } as GameLine);
  }
  return out;
}
