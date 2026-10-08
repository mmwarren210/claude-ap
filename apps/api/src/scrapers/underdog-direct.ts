import type { ScraperSource } from './scraped-line.js';
import { zenUnderdog } from './zen-studio.js';

// Underdog's own public lines feed (free; owner, 2026-10-08: Apify's plan stops at $100 a month). The newer beta
// addresses answer "upgrade required"; v1 still serves the whole pick'em board from a server. Each line becomes the same
// row the Apify actor gave, so one reader handles both.

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const list = (value: unknown): Json[] => Array.isArray(value) ? value.flatMap((item) => obj(item) ? [item as Json] : []) : [];
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

export const UNDERDOG_LINES_URL = 'https://api.underdogfantasy.com/v1/over_under_lines';

/** Underdog's feed turned into one Apify-style row per line (player, game, stat, number and each side's payout). */
export function underdogRows(body: unknown): Json[] {
  const root = obj(body) ?? {};
  const byId = (items: Json[]) => new Map(items.map((item) => [String(item.id), item]));
  const appearances = byId(list(root.appearances)), players = byId(list(root.players));
  const games = byId(list(root.games)), soloGames = byId(list(root.solo_games));
  return list(root.over_under_lines).flatMap((line) => {
    const overUnder = obj(line.over_under), stat = obj(overUnder?.appearance_stat);
    const appearance = appearances.get(String(stat?.appearance_id));
    const player = appearance ? players.get(String(appearance.player_id)) : undefined;
    const value = Number(line.stat_value);
    if (!overUnder || !stat || !appearance || !player || !Number.isFinite(value)) return [];
    const options = list(line.options);
    const payout = (choice: string) => {
      const option = options.find((item) => item.choice === choice && (item.status ?? 'active') === 'active');
      return option ? str(option.payout_multiplier) : null;
    };
    const name = [str(player.first_name), str(player.last_name)].filter(Boolean).join(' ');
    const solo = appearance.match_type === 'SoloGame';
    const game = solo ? soloGames.get(String(appearance.match_id)) : games.get(String(appearance.match_id));
    if (!game || !name) return [];
    let home: string | null, away: string | null, homeName: string | null, awayName: string | null, team: string | null;
    if (solo) {
      // Tennis and fights: the two players stand in for teams, so the opponent is the other name.
      home = str(game.home_player_name); away = str(game.away_player_name); homeName = home; awayName = away; team = name;
    } else {
      const [awayAbbr, homeAbbr] = (str(game.abbreviated_title) ?? '').split(' @ ');
      const [awayFull, homeFull] = (str(game.full_team_names_title) ?? '').split(' @ ');
      home = str(homeAbbr); away = str(awayAbbr); homeName = str(homeFull); awayName = str(awayFull);
      team = appearance.team_id === game.home_team_id ? home : appearance.team_id === game.away_team_id ? away : null;
    }
    const teamName = team === home ? homeName : team === away ? awayName : null;
    return [{
      projection_id: String(line.id), line: value, stat: str(stat.stat) ?? str(stat.display_stat) ?? '',
      stat_display: str(stat.display_stat), status: str(line.status), is_live: line.live_event === true,
      player_name: name, player_team: team, player_team_name: teamName,
      player_image: str(player.image_url), league: str(game.sport_id) ?? str(player.sport_id) ?? '',
      game_start: str(game.scheduled_at) ?? '', game_status: str(game.status),
      home_team: home, away_team: away, home_team_name: homeName, away_team_name: awayName,
      line_type: str(line.line_type), category: str(overUnder.category),
      higher_payout_multiplier: payout('higher'), lower_payout_multiplier: payout('lower'),
    }];
  });
}

/** Underdog straight from its own feed: no Apify cost, so it can refresh through the day. */
export function underdogDirect(fetchFn: typeof fetch = (...args) => fetch(...args)): ScraperSource {
  return {
    ...zenUnderdog, id: 'underdog-direct', actor: null,
    async run() {
      const response = await fetchFn(UNDERDOG_LINES_URL, { headers: { accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' },
        signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`UNDERDOG_HTTP_${response.status}`);
      const rows = underdogRows(await response.json());
      // A feed with no lines proves nothing was taken down.
      return { rows, complete: rows.length > 0 };
    },
  };
}
