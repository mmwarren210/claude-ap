import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { marketLabel } from '../insights';
import { MultiPick, picked } from './ui/MultiPick';

const countBy = <T,>(items: readonly T[], key: (item: T) => string) => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

/**
 * League and stat pickers for a list (several of each at once, e.g. NFL + CFB, Pass Yds + Rush TDs). The stat list
 * follows the leagues picked. `statOf` and `labelOf` read the stat key and its name.
 */
export function useLeagueStatFilter<T extends { league: string }>(items: readonly T[], statOf: (item: T) => string,
  labelOf: (key: string) => string = marketLabel) {
  const [leagues, setLeagues] = useState<string[]>([]);
  const [stats, setStats] = useState<string[]>([]);
  const inLeague = useMemo(() => items.filter((item) => picked(leagues, item.league)), [items, leagues]);
  const shown = useMemo(() => inLeague.filter((item) => picked(stats, statOf(item))), [inLeague, stats, statOf]);
  const leagueOptions = countBy(items, (item) => item.league).map(([key, count]) => ({ key, label: key, count }));
  const statOptions = countBy(inLeague, statOf).map(([key, count]) => ({ key, label: labelOf(key), count }));
  const pickers = items.length ? <View style={styles.wrap}>
    {(leagueOptions.length > 1 || !!leagues.length) && <MultiPick label="LEAGUE" allLabel="All leagues" options={leagueOptions}
      selected={leagues} onChange={setLeagues} />}
    {(statOptions.length > 1 || !!stats.length) && <MultiPick label="STAT" allLabel="All stats" options={statOptions}
      selected={stats} onChange={setStats} labelFor={labelOf} />}
  </View> : null;
  return { shown, pickers };
}

const styles = StyleSheet.create({ wrap: { gap: 10 } });
