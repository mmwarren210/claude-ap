import type { EdgePick } from '@crowniq/contracts';
import { StyleSheet, Text, View } from 'react-native';
import { marketLabel } from '../edge-format';
import { gameTime } from '../insights';
import { palette, rankAccents } from '../theme';
import { EdgePickCard } from './EdgePickCard';
import { FilterBar } from './FilterBar';
import type { FilterValue } from './FilterBar';
import { choiceParam } from './ui/MultiPick';

type Counts = { sports?: readonly ({ sport: string; picks: number } | string)[];
  markets?: readonly { market: string; picks?: number; lines?: number }[];
  games?: readonly { eventId: string; eventName: string; sport: string; startTime: string; picks: number }[] };

/** The filter as the Edge API's query values (comma-separated lists). */
export const edgeQuery = (filter: FilterValue) => ({ sport: choiceParam(filter.sports), market: choiceParam(filter.stats), event: choiceParam(filter.games) });

/** Edge's one filter (sport, then games, then stats), its options from the server's counts. */
export function EdgeFilters({ value, onChange, counts }: { value: FilterValue; onChange: (next: FilterValue) => void; counts: Counts | null | undefined }) {
  const sports = (counts?.sports ?? []).map((item) => typeof item === 'string' ? { key: item, label: item }
    : { key: item.sport, label: item.sport, count: item.picks });
  return <FilterBar value={value} onChange={onChange} sports={sports} statName={marketLabel}
    games={(counts?.games ?? []).map((game) => ({ key: game.eventId, name: game.eventName, sport: game.sport, startTime: game.startTime, count: game.picks }))}
    stats={(counts?.markets ?? []).map((item) => ({ key: item.market, label: marketLabel(item.market), count: item.picks ?? item.lines }))} />;
}

/** With games picked: each game's best pick (the list is already ranked), right under the filter. */
export function BestPerGame({ picks, games, inSlip }: { picks: readonly EdgePick[]; games: readonly string[]; inSlip: ReadonlySet<string> }) {
  if (!games.length) return null;
  const best = games.map((game) => picks.find((pick) => pick.eventId === game && pick.edge !== null && pick.edge > 0)
    ?? picks.find((pick) => pick.eventId === game) ?? null).filter((pick): pick is EdgePick => !!pick);
  return <View style={styles.section}>
    <Text style={styles.title}>BEST PICK {games.length === 1 ? 'FOR THIS GAME' : 'PER GAME'}</Text>
    {!best.length && <Text style={styles.detail}>No rated pick in {games.length === 1 ? 'that game' : 'those games'} for this filter. Passing is a valid result.</Text>}
    {best.map((pick, index) => <View key={pick.eventId} style={styles.game}>
      <Text style={styles.detail}>{pick.eventName} · {gameTime(pick.eventStartTime)}</Text>
      <EdgePickCard pick={pick} accent={rankAccents[index % rankAccents.length]!} inSlip={inSlip.has(pick.lineId)} />
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  section: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.green, borderRadius: 18, padding: 14, gap: 10 },
  title: { color: palette.green, fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  detail: { color: palette.muted, fontSize: 12, lineHeight: 17 },
  game: { gap: 6 },
});
