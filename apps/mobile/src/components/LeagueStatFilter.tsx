import { useMemo, useState } from 'react';
import { marketLabel } from '../insights';
import { emptyFilter, FilterBar } from './FilterBar';
import type { FilterValue, GameOption } from './FilterBar';
import { picked } from './ui/MultiPick';

type Item = { league: string; eventStartTime: string; eventId?: string; eventName?: string | null };

const countBy = <T,>(items: readonly T[], key: (item: T) => string) => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};
/** A game's key: its id, else its name and start time. */
const gameKey = (item: Item) => item.eventId ?? `${item.eventName ?? ''}|${item.eventStartTime}`;

/**
 * The one filter for a list: league, then that league's games (teams and start time), then stats, several of each. `statOf`
 * and `labelOf` read the stat key and its name. The stat list follows the leagues and games.
 */
export function useLeagueStatFilter<T extends Item>(items: readonly T[], statOf: (item: T) => string,
  labelOf: (key: string) => string = marketLabel) {
  const [filter, setFilter] = useState<FilterValue>(emptyFilter);
  const inLeague = useMemo(() => items.filter((item) => picked(filter.sports, item.league)), [items, filter.sports]);
  const inGame = useMemo(() => inLeague.filter((item) => picked(filter.games, gameKey(item))), [inLeague, filter.games]);
  const shown = useMemo(() => inGame.filter((item) => picked(filter.stats, statOf(item))), [inGame, filter.stats, statOf]);
  const games = useMemo(() => {
    const out = new Map<string, GameOption>();
    for (const item of inLeague) {
      if (!item.eventName) continue;
      const key = gameKey(item), game = out.get(key);
      if (game) game.count = (game.count ?? 0) + 1;
      else out.set(key, { key, name: item.eventName, sport: item.league, startTime: item.eventStartTime, count: 1 });
    }
    return [...out.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name));
  }, [inLeague]);
  const pickers = items.length ? <FilterBar value={filter} onChange={setFilter} statName={labelOf} games={games}
    sports={countBy(items, (item) => item.league).map(([key, count]) => ({ key, label: key, count }))}
    stats={countBy(inGame, statOf).map(([key, count]) => ({ key, label: labelOf(key), count }))} /> : null;
  return { shown, pickers, filter };
}
