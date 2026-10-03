import { z } from 'zod';
import type { PlayableDirection } from '@crowniq/contracts';
import type { DfsApp, ScrapedLine, ScrapedTier } from './scraped-line.js';

/** Apify actor `lergassy/dfs-props-scraper` (PrizePicks and Underdog, one row per prop). */
export const LERGASSY_ACTOR = 'lergassy/dfs-props-scraper';

export const lergassyInput = (maxRows: number) =>
  ({ mode: 'props', platforms: ['prizepicks', 'underdog'], maxRows, maxLeagues: 20 });

const rowSchema = z.object({
  type: z.string().optional(), platform: z.string(), propId: z.union([z.string(), z.number()]).transform(String),
  league: z.string().min(1), player: z.string().min(1), team: z.string().nullish(), teamName: z.string().nullish(),
  market: z.string().min(1), line: z.number().finite(), oddsType: z.string().nullish(),
  allowedPicks: z.string().nullish(), live: z.boolean().nullish(), status: z.string().nullish(),
  gameId: z.union([z.string(), z.number()]).nullish().transform((value) => value == null ? null : String(value)),
  opponent: z.string().nullish(), startTime: z.iso.datetime({ offset: true }), image: z.string().nullish(),
}).passthrough();

const tiers: Readonly<Record<string, ScrapedTier>> = { standard: 'REGULAR', balanced: 'REGULAR', goblin: 'GOBLIN', demon: 'DEMON' };
const apps: Readonly<Record<string, DfsApp>> = { prizepicks: 'prizepicks', underdog: 'underdog' };

export type SkipReason = 'INVALID_ROW' | 'UNKNOWN_APP' | 'UNKNOWN_TIER' | 'COMBO_PLAYER' | 'LIVE_OR_STARTED' | 'NO_GAME';

/**
 * One scraped row as a line, or why it was skipped. Fails closed: anything the models cannot read
 * exactly (multi-player combos, live or started games, unknown tiers) is left out.
 */
export function readLergassyRow(raw: unknown, now: Date): { line: ScrapedLine } | { skip: SkipReason } {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) return { skip: 'INVALID_ROW' };
  const row = parsed.data;
  const app = apps[row.platform.toLowerCase()];
  if (!app) return { skip: 'UNKNOWN_APP' };
  const tier = tiers[(row.oddsType ?? 'standard').toLowerCase()];
  if (!tier) return { skip: 'UNKNOWN_TIER' };
  if (row.team?.includes('/') || /\s\+\s/.test(row.player)) return { skip: 'COMBO_PLAYER' };
  if (row.live || (row.status && row.status !== 'pre_game') || Date.parse(row.startTime) <= now.getTime())
    return { skip: 'LIVE_OR_STARTED' };
  if (!row.gameId) return { skip: 'NO_GAME' };
  const allowed = (row.allowedPicks ?? '').toLowerCase();
  // Goblins and Demons are MORE-only on PrizePicks; a Regular line with no stated sides offers both.
  const directions: PlayableDirection[] = allowed === 'over' ? ['MORE'] : allowed === 'under' ? ['LESS']
    : allowed ? ['MORE', 'LESS'] : tier === 'REGULAR' ? ['MORE', 'LESS'] : ['MORE'];
  // Only real headshots: PrizePicks also serves team logos (/images/teams/) and a placeholder in this field.
  const image = row.image && row.image.startsWith('https://') && !/placeholder|\/images\/teams\//.test(row.image) ? row.image : null;
  // Underdog's opponent field reads "OSU @ IOWA"; keep only the other side.
  const opponent = row.opponent?.includes(' @ ')
    ? row.opponent.split(' @ ').map((side) => side.trim()).find((side) => side !== row.team) ?? null : row.opponent ?? null;
  return { line: { app, appLineId: row.propId, league: row.league.toUpperCase(), gameId: row.gameId,
    player: row.player.trim(), team: row.team ?? null, teamName: row.teamName ?? null, opponent,
    stat: row.market.trim(), line: row.line, tier, directions, startTime: new Date(row.startTime).toISOString(),
    imageUrl: image } };
}
