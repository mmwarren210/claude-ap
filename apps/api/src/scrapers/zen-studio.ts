import { z } from 'zod';
import type { PlayableDirection } from '@crowniq/contracts';
import { prizePicksSides } from './scraped-line.js';
import type { ReadResult, ScrapedTier, ScraperSource, TeamSide } from './scraped-line.js';

const id = z.union([z.string(), z.number()]).transform(String);
const text = z.string().nullish();
const isHeadshot = (url: string | null | undefined) =>
  !!url && url.startsWith('https://') && !/placeholder|\/images\/teams\//.test(url);
const side = (abbreviation: string | null | undefined, name: string | null | undefined): TeamSide | null =>
  abbreviation ? { abbreviation, name: name ?? null } : null;
const tiers: Readonly<Record<string, ScrapedTier>> = { standard: 'REGULAR', balanced: 'REGULAR', goblin: 'GOBLIN', demon: 'DEMON' };

const prizePicksRow = z.object({
  projection_id: id, line: z.number().finite(), stat: z.string().min(1), stat_short: text, odds_tier: text,
  status: text, is_live: z.boolean().nullish(), in_game: z.boolean().nullish(), event_type: text,
  allowed_wager_types: text, player_name: z.string().min(1), player_team: text, player_team_name: text,
  player_image: text, player_combo: z.boolean().nullish(), league: z.string().min(1),
  game_external_id: text, game_id: id.nullish(), game_start: z.iso.datetime({ offset: true }).nullish(),
  start_time: z.iso.datetime({ offset: true }), home_team: text, home_team_name: text, away_team: text, away_team_name: text,
}).passthrough();

/** Apify actor `zen-studio/prizepicks-player-props`: the full PrizePicks board with home and away teams. */
export const zenPrizePicks: ScraperSource = {
  id: 'zen-studio-prizepicks', actor: 'zen-studio/prizepicks-player-props', apps: ['prizepicks'], rowCap: null,
  input: () => ({ leagues: ['All'] }),
  read(raw: unknown, now: Date): ReadResult {
    const parsed = prizePicksRow.safeParse(raw);
    if (!parsed.success) return { skip: 'INVALID_ROW' };
    const row = parsed.data;
    const tier = tiers[(row.odds_tier ?? 'standard').toLowerCase()];
    if (!tier) return { skip: 'UNKNOWN_TIER' };
    if (row.player_combo || row.event_type === 'combo') return { skip: 'COMBO_PLAYER' };
    const start = row.game_start ?? row.start_time;
    if (row.is_live || row.in_game || (row.status && row.status !== 'pre_game') || Date.parse(start) <= now.getTime())
      return { skip: 'LIVE_OR_STARTED' };
    const gameId = row.game_external_id ?? row.game_id;
    if (!gameId) return { skip: 'NO_GAME' };
    const allowed = (row.allowed_wager_types ?? '').toLowerCase();
    const directions = prizePicksSides(tier, allowed === 'over' ? ['MORE'] : allowed === 'under' ? ['LESS'] : ['MORE', 'LESS']);
    const home = side(row.home_team, row.home_team_name), away = side(row.away_team, row.away_team_name);
    const opponent = row.player_team && home && away
      ? row.player_team === home.abbreviation ? away.abbreviation : row.player_team === away.abbreviation ? home.abbreviation : null
      : null;
    return { line: { app: 'prizepicks', appLineId: row.projection_id, league: row.league.toUpperCase(), gameId,
      player: row.player_name.trim(), team: row.player_team ?? null, teamName: row.player_team_name ?? null, opponent,
      // The short label matches the app's board (and lergassy), e.g. "Rec Yards".
      stat: (row.stat_short ?? row.stat).trim(), line: row.line, tier, directions,
      startTime: new Date(start).toISOString(), imageUrl: isHeadshot(row.player_image) ? row.player_image! : null,
      home, away } };
  },
};

/** The same actor for esports only (CS2, LoL, Valorant, Dota 2, Rocket League, Call of Duty, plus R6): SharpAPI carries no
 * PrizePicks esports, and this pull costs cents where the full board costs a dollar or two. */
export const zenPrizePicksEsports: ScraperSource = {
  ...zenPrizePicks, id: 'zen-studio-prizepicks-esports', input: () => ({ leagues: ['Esports'], extraLeagues: 'R6' }),
};

const underdogRow = z.object({
  projection_id: id, line: z.number().finite(), stat: z.string().min(1), stat_display: text, status: text,
  is_live: z.boolean().nullish(), player_name: z.string().min(1), player_team: text, player_team_name: text,
  player_image: text, league: z.string().min(1), game_start: z.iso.datetime({ offset: true }), game_status: text,
  home_team: text, away_team: text, home_team_name: text, away_team_name: text, line_type: text, category: text,
  higher_payout_multiplier: z.union([z.string(), z.number()]).nullish(), lower_payout_multiplier: z.union([z.string(), z.number()]).nullish(),
}).passthrough();

const payout = (value: string | number | null | undefined) => {
  const number = Number(value); return value != null && Number.isFinite(number) && number > 0 ? number : null;
};

/** Apify actor `zen-studio/underdog-player-props`: Underdog's pregame board with payouts per side. */
export const zenUnderdog: ScraperSource = {
  id: 'zen-studio-underdog', actor: 'zen-studio/underdog-player-props', apps: ['underdog'], rowCap: null,
  input: () => ({ leagues: ['All'] }),
  read(raw: unknown, now: Date): ReadResult {
    const parsed = underdogRow.safeParse(raw);
    if (!parsed.success) return { skip: 'INVALID_ROW' };
    const row = parsed.data;
    if (row.category && row.category !== 'player_prop') return { skip: 'NOT_PLAYER_PROP' };
    const tier = tiers[(row.line_type ?? 'balanced').toLowerCase()];
    if (!tier) return { skip: 'UNKNOWN_TIER' };
    if (row.is_live || (row.status && row.status !== 'active') || (row.game_status && row.game_status !== 'scheduled') ||
      Date.parse(row.game_start) <= now.getTime()) return { skip: 'LIVE_OR_STARTED' };
    if (!row.home_team || !row.away_team) return { skip: 'NO_GAME' };
    // A side with no payout is not on offer.
    const higher = payout(row.higher_payout_multiplier), lower = payout(row.lower_payout_multiplier);
    const directions: PlayableDirection[] = [...(higher ? ['MORE' as const] : []), ...(lower ? ['LESS' as const] : [])];
    if (!directions.length) return { skip: 'NO_SIDES' };
    const home = side(row.home_team, row.home_team_name), away = side(row.away_team, row.away_team_name);
    const opponent = row.player_team === row.home_team ? row.away_team : row.player_team === row.away_team ? row.home_team : null;
    return { line: { app: 'underdog', appLineId: row.projection_id, league: row.league.toUpperCase(),
      gameId: `${row.away_team}@${row.home_team}@${row.game_start}`, player: row.player_name.trim(),
      team: row.player_team ?? null, teamName: row.player_team_name ?? null, opponent,
      stat: (row.stat_display ?? row.stat).trim(), line: row.line, tier, directions,
      startTime: new Date(row.game_start).toISOString(), imageUrl: isHeadshot(row.player_image) ? row.player_image! : null,
      home, away, multipliers: { ...(higher ? { MORE: higher } : {}), ...(lower ? { LESS: lower } : {}) } } };
  },
};

const pick6Row = z.object({
  projection_id: id, line: z.number().finite(), stat: z.string().min(1), stat_display: text, status: text,
  is_live: z.boolean().nullish(), player_name: z.string().min(1), player_team: text, player_team_name: text,
  player_image: text, league: z.string().min(1), game_id: z.union([z.string(), z.number()]).nullish(),
  game_start: z.string().min(10), home_team: text, away_team: text, home_team_name: text, away_team_name: text,
  market_type: text, is_alternate_line: z.boolean().nullish(),
  over_multiplier: z.union([z.string(), z.number()]).nullish(), under_multiplier: z.union([z.string(), z.number()]).nullish(),
  is_gimme: z.boolean().nullish(), original_line: z.number().finite().nullish(),
}).passthrough();

/** Apify actor `zen-studio/draftkings-pick6-player-props`: DraftKings Pick6's pregame board, stored for its own board. */
export const zenPick6: ScraperSource = {
  id: 'zen-studio-pick6', actor: 'zen-studio/draftkings-pick6-player-props', apps: ['pick6'], rowCap: null,
  input: () => ({ leagues: ['All'] }),
  read(raw: unknown, now: Date): ReadResult {
    const parsed = pick6Row.safeParse(raw);
    if (!parsed.success) return { skip: 'INVALID_ROW' };
    const row = parsed.data;
    // Standard lines only; boosted or alternate projections are not stored yet.
    if (row.is_alternate_line || (row.market_type && row.market_type !== 'standard')) return { skip: 'ALTERNATE_LINE' };
    const start = Date.parse(row.game_start);
    if (!Number.isFinite(start)) return { skip: 'INVALID_ROW' };
    if (row.is_live || (row.status && row.status !== 'pre_game') || start <= now.getTime()) return { skip: 'LIVE_OR_STARTED' };
    if (!row.home_team || !row.away_team) return { skip: 'NO_GAME' };
    const more = payout(row.over_multiplier), less = payout(row.under_multiplier);
    const directions: PlayableDirection[] = [...(more ? ['MORE' as const] : []), ...(less ? ['LESS' as const] : [])];
    if (!directions.length) return { skip: 'NO_SIDES' };
    const home = side(row.home_team, row.home_team_name), away = side(row.away_team, row.away_team_name);
    const opponent = row.player_team === row.home_team ? row.away_team : row.player_team === row.away_team ? row.home_team : null;
    return { line: { app: 'pick6', appLineId: row.projection_id, league: row.league.toUpperCase(),
      gameId: String(row.game_id ?? `${row.away_team}@${row.home_team}@${row.game_start}`), player: row.player_name.trim(),
      team: row.player_team ?? null, teamName: row.player_team_name ?? null, opponent,
      stat: (row.stat_display ?? row.stat).trim(), line: row.line, tier: 'REGULAR', directions,
      startTime: new Date(start).toISOString(), imageUrl: isHeadshot(row.player_image) ? row.player_image! : null,
      home, away, multipliers: { ...(more ? { MORE: more } : {}), ...(less ? { LESS: less } : {}) },
      ...(row.is_gimme || (row.original_line != null && row.original_line !== row.line)
        ? { promo: { gimme: !!row.is_gimme, originalLine: row.original_line ?? null } } : {}) } };
  },
};
