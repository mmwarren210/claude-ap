import type { ScraperSource } from './scraped-line.js';
import { zenPrizePicks } from './zen-studio.js';

// PrizePicks' partner projections address (free; owner, 2026-10-08). The app's main address answers servers with a
// captcha; this one serves the whole board, esports included, as plain JSON. Each projection becomes the same row the
// Apify actor gave, so one reader handles both.

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const relId = (item: Json | null, name: string) => {
  const id = obj(obj(obj(item?.relationships)?.[name])?.data)?.id;
  return id === undefined || id === null ? null : String(id);
};

export const PRIZEPICKS_PARTNER_URL = 'https://partner-api.prizepicks.com/projections?per_page=250&single_stat=true&game_mode=pickem';

/** PrizePicks' JSON:API body turned into one Apify-style row per projection. */
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
    ...zenPrizePicks, id: 'prizepicks-partner', actor: null,
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
