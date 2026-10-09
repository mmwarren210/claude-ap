import { z } from 'zod';
import { prizePicksSides } from './scraped-line.js';
import type { ReadResult, ScrapedTier, ScraperSource, TeamSide } from './scraped-line.js';

// PrizePicks' partner projections address (free; owner, 2026-10-08). The app's main address answers servers with a
// captcha; this one serves the whole board, esports included, as plain JSON. Each projection becomes one flat row, read below.

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

/** One PrizePicks projection row (from the partner address) as a stored line. */
export function readPrizePicksRow(raw: unknown, now: Date): ReadResult {
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
    // The short label matches the app's board, e.g. "Rec Yards".
    stat: (row.stat_short ?? row.stat).trim(), line: row.line, tier, directions,
    startTime: new Date(start).toISOString(), imageUrl: isHeadshot(row.player_image) ? row.player_image! : null,
    home, away } };
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const relId = (item: Json | null, name: string) => {
  const id = obj(obj(obj(item?.relationships)?.[name])?.data)?.id;
  return id === undefined || id === null ? null : String(id);
};

export const PRIZEPICKS_PARTNER_URL = 'https://partner-api.prizepicks.com/projections?per_page=250&single_stat=true&game_mode=pickem';

/** PrizePicks' JSON:API body turned into one flat row per projection. */
export function prizePicksPartnerRows(body: unknown): Json[] {
  const root = obj(body) ?? {};
  const included = new Map<string, Json>();
  for (const item of Array.isArray(root.included) ? root.included : []) {
    const record = obj(item);
    if (record) included.set(`${String(record.type)}:${String(record.id)}`, record);
  }
  const find = (type: string, id: string | null) => id === null ? null : included.get(`${type}:${id}`) ?? null;
  const attrs = (item: Json | null) => obj(item?.attributes) ?? {};
  return (Array.isArray(root.data) ? root.data : []).flatMap((item) => {
    const projection = obj(item);
    if (!projection) return [];
    const a = attrs(projection);
    const player = find('new_player', relId(projection, 'new_player')), p = attrs(player);
    const league = str(attrs(find('league', relId(projection, 'league'))).name) ?? str(p.league);
    const game = find('game', relId(projection, 'game')), g = attrs(game);
    const teams = obj(obj(obj(g.metadata)?.game_info)?.teams);
    const teamName = (side: 'home' | 'away') => str(attrs(find('team', relId(game, `${side}_team_data`))).name);
    const wager = a.allowed_wager_types;
    return [{
      projection_id: String(projection.id), line: a.line_score, stat: str(a.stat_type), stat_short: str(a.stat_display_name),
      odds_tier: str(a.odds_type), status: str(a.status), is_live: a.is_live === true, in_game: a.in_game === true,
      event_type: str(a.event_type),
      allowed_wager_types: typeof wager === 'string' ? wager : Array.isArray(wager) && wager.length === 1 ? String(wager[0]) : null,
      player_name: str(p.display_name) ?? str(p.name), player_team: str(p.team), player_team_name: str(p.team_name),
      player_image: str(p.image_url), player_combo: p.combo === true, league,
      game_external_id: str(a.game_id) ?? str(g.external_game_id), game_id: relId(projection, 'game'),
      game_start: str(g.start_time) ?? str(a.start_time), start_time: str(a.start_time),
      home_team: str(obj(teams?.home)?.abbreviation), away_team: str(obj(teams?.away)?.abbreviation),
      home_team_name: teamName('home'), away_team_name: teamName('away'),
    }];
  });
}

/** PrizePicks straight from its partner address: no Apify cost, so it can refresh through the day. */
export function prizePicksPartner(fetchFn: typeof fetch = (...args) => fetch(...args)): ScraperSource {
  return {
    id: 'prizepicks-partner', actor: null, apps: ['prizepicks'], rowCap: null, input: () => ({}), read: readPrizePicksRow,
    async run() {
      const response = await fetchFn(PRIZEPICKS_PARTNER_URL, { headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`PRIZEPICKS_PARTNER_HTTP_${response.status}`);
      const rows = prizePicksPartnerRows(await response.json());
      // A feed with no projections proves nothing was taken down.
      return { rows, complete: rows.length > 0 };
    },
  };
}
