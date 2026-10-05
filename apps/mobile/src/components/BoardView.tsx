import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Window } from '../insights';
import { boardLinesForMode, evidenceExpired, playCounts, withBooksPicks } from '../state';
import { useBooksPicks } from '../use-books';
import { useAiPicks } from '../use-ai-picks';
import type { Filters } from '../state';
import { colors, radius, rankAccents } from '../theme';
import { useBoard } from '../use-board';
import { useDraft } from '../use-draft';
import { AppBoard, pickApps } from './AppBoard';
import type { PickApp } from './AppBoard';
import { BoardCard } from './BoardCard';
import { CrownTray } from './CrownTray';
import { FilterSheet, optionLabel } from './FilterSheet';
import { Notice } from './Screen';
import { Sheet } from './Sheet';
import { AppHeader } from './ui/AppHeader';
import { ChipRow, FilterChip, PrimaryButton, Segmented } from './ui/Controls';
import { Icon } from './ui/Icon';

export const windows: readonly { value: Window; label: string }[] = [
  { value: 'L5', label: 'L5' }, { value: 'L10', label: 'L10' }, { value: 'L15', label: 'L15' },
  { value: 'H2H', label: 'H2H' }, { value: 'AVG', label: 'Avg' }];

const chipKeys: readonly (keyof Filters)[] = ['sport', 'market', 'lineType', 'evidence', 'date'];
const chipNames: Readonly<Partial<Record<keyof Filters, string>>> = { sport: 'All Sports', market: 'Market',
  lineType: 'Line Style', evidence: 'Evidence', date: 'Date' };

function freshnessLine(freshness: string, fetchedAt: string | undefined, nowMs: number): string {
  if (freshness === 'DEMO') return 'Demo sample board';
  if (!fetchedAt) return freshness.toLowerCase();
  const minutes = Math.max(0, Math.round((nowMs - Date.parse(fetchedAt)) / 60_000));
  const age = minutes < 1 ? 'just now' : minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
  return freshness === 'DEMO_LIVE' ? `Next 3 days · captured ${age}` : `Captured ${age}`;
}

// The chosen pick'em app survives leaving and returning to the Board tab.
let lastApp: PickApp = 'prizepicks';

export default function BoardView() {
  const [app, setAppState] = useState<PickApp>(lastApp);
  const setApp = useCallback((next: PickApp) => { lastApp = next; setAppState(next); }, []);
  return app === 'prizepicks' ? <PrizePicksBoard onApp={setApp} /> : <AppBoard app={app} onApp={setApp} />;
}

function PrizePicksBoard({ onApp }: { onApp: (app: PickApp) => void }) {
  const { status, data, message, freshness, refreshing, nowMs, reload, needsBootstrap, bootstrapPull } = useBoard();
  const { filters, setFilters, viewMode, ready } = useDraft();
  // While the Board is on screen, reread the saved board every 5 minutes (free; picks up context refreshes).
  useFocusEffect(useCallback(() => {
    if (freshness === 'DEMO') return;
    const timer = setInterval(reload, 5 * 60_000);
    return () => clearInterval(timer);
  }, [reload, freshness]));
  const [sheet, setSheet] = useState<keyof Filters | 'ALL' | null>(null);
  const [window, setWindow] = useState<Window>('L5');
  const [confirmPull, setConfirmPull] = useState(false);
  const { reads: aiReads } = useAiPicks();
  const booksPicks = useBooksPicks();
  // Where GKR can't score: the Scout read, else the Books pick.
  const plays = useMemo(() => withBooksPicks(aiReads ?? undefined, booksPicks ?? undefined), [aiReads, booksPicks]);
  const lines = useMemo(() => data && ready ? boardLinesForMode(data, filters, viewMode, nowMs, plays) : [],
    [data, filters, viewMode, ready, nowMs, plays]);
  const counts = useMemo(() => data ? playCounts(data, plays, nowMs) : new Map<string, number>(),
    [data, plays, nowMs]);
  // Player search reaches every player on the board, including those with no play (their page shows every stat).
  const [query, setQuery] = useState('');
  const found = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    if (!data || wanted.length < 2) return null;
    const players = new Map<string, { line: (typeof data.board.lines)[number]; stats: number }>();
    for (const line of data.board.lines) {
      if (Date.parse(line.eventStartTime) <= nowMs || !line.playerName.toLowerCase().includes(wanted)) continue;
      const key = line.eventId + '|' + line.playerId, current = players.get(key);
      players.set(key, { line: current?.line ?? line, stats: (current?.stats ?? 0) + 1 });
    }
    return [...players.values()].slice(0, 30);
  }, [data, query, nowMs]);
  const analyses = useMemo(() => new Map(data?.analyses.map((item) => [item.lineId, item])), [data]);
  const open = useCallback((lineId: string) => router.push({ pathname: '/player/[lineId]', params: { lineId } }), []);
  const warn = ['STALE', 'UNREACHABLE', 'OFFLINE'].includes(freshness);

  const header = <View style={styles.header}>
    <AppHeader subtitle="Sports Intelligence · Powered by GKR" />
    <Segmented label="Pick'em app" options={pickApps} value={'prizepicks' as PickApp} onChange={onApp} />
    {data && <TextInput value={query} onChangeText={setQuery} placeholder="Search any player" placeholderTextColor={colors.textFaint}
      accessibilityLabel="Search players" style={styles.search} autoCorrect={false} />}
    {found && <View style={styles.results}>
      {found.length === 0 && <Text style={styles.note}>No player by that name on this board.</Text>}
      {found.map(({ line, stats }) => <Pressable key={line.eventId + line.playerId} accessibilityRole="button"
        onPress={() => { setQuery(''); open(line.id); }} style={styles.result}>
        <Text style={styles.resultName}>{line.playerName}</Text>
        <Text style={styles.note}>{line.league} · {line.eventName} · {stats} {stats === 1 ? 'stat' : 'stats'}</Text>
      </Pressable>)}
    </View>}
    {data && <ChipRow>
      {chipKeys.map((key) => <FilterChip key={key} active={filters[key] !== 'ALL'} onPress={() => setSheet(key)}
        label={filters[key] === 'ALL' ? chipNames[key]! : optionLabel(key, filters[key])} />)}
    </ChipRow>}
    <View style={styles.windowRow}>
      <View style={styles.windows}><Segmented label="Hit-rate window" options={windows} value={window} onChange={setWindow} /></View>
      {data && <Pressable accessibilityRole="button" onPress={() => setSheet('ALL')} style={styles.more}>
        <Icon name="tune-variant" size={18} color={colors.text} /><Text style={styles.moreText}>More</Text></Pressable>}
    </View>
    <View style={styles.statusRow}>
      <Text style={[styles.status, warn && styles.warning]} numberOfLines={1}>
        {viewMode === 'LITE' ? `Top ${lines.length} qualified` : `${lines.length} players with a play`} · {data
          ? freshnessLine(freshness, data.board.fetchedAt, nowMs) : message || 'Loading'}</Text>
      <Pressable accessibilityRole="button" disabled={refreshing || status === 'loading'}
        onPress={() => needsBootstrap ? setConfirmPull(true) : reload()} hitSlop={8}>
        <Text style={styles.refresh}>{refreshing ? 'Building…' : status === 'loading' ? 'Loading…'
          : needsBootstrap ? 'Pull first board' : 'Refresh'}</Text>
      </Pressable>
    </View>
    {data && freshness !== 'DEMO' && <Text style={styles.note}>Saved snapshot. Lines can move near game time; confirm the exact line and direction in
      PrizePicks within an hour of the start.</Text>}
    {!!message && !!data && <Text style={styles.warning}>{message} Showing the last saved board.</Text>}
  </View>;

  return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={lines} keyExtractor={(line) => line.id} initialNumToRender={6} maxToRenderPerBatch={8} windowSize={7}
      contentContainerStyle={styles.content} ListHeaderComponent={header}
      renderItem={({ item, index }) => <BoardCard line={item} analysis={analyses.get(item.id)} ai={aiReads?.get(item.id)}
        booksPick={booksPicks?.get(item.id)}
        more={(counts.get(item.eventId + '|' + item.playerId) ?? 1) - 1}
        photoUrl={data?.playerMedia?.[item.playerId]?.photoUrl} accent={rankAccents[index % rankAccents.length]}
        window={window} expired={(() => { const analysis = analyses.get(item.id);
          return analysis?.direction !== 'PASS' && evidenceExpired(analysis, nowMs); })()} onPress={() => open(item.id)} />}
      ListEmptyComponent={<Notice title={!ready || status === 'loading' ? 'Loading board' : data && viewMode === 'LITE'
        ? 'No qualified plays yet' : data ? 'No matching lines' : 'Board unavailable'}
        detail={!ready ? 'Loading your saved view.' : status === 'loading' ? 'Looking for the latest saved board.'
          : data && viewMode === 'LITE' ? 'Nothing on this board qualifies for these filters. PASS is a valid result. Full view in More shows every play.'
            : data ? 'Reset filters or try another sport.' : message} />} />
    <CrownTray />
    {data && sheet && <FilterSheet key={sheet} visible onClose={() => setSheet(null)} mode={viewMode} data={data}
      value={filters} onApply={setFilters} only={sheet === 'ALL' ? undefined : sheet} />}
    <Sheet visible={confirmPull} title="Pull the first board?" onClose={() => setConfirmPull(false)}>
      <Text style={styles.sheetText}>The server has no PrizePicks board yet. Pulling one uses Odds API credits. Only the
        owner profile can start it, and the server refuses once any board exists.</Text>
      <PrimaryButton label="Use credits and pull" onPress={() => { setConfirmPull(false); bootstrapPull(); }} />
    </Sheet>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 24, gap: 14 },
  header: { gap: 12, marginBottom: 2 },
  windowRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  windows: { flex: 1 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, paddingHorizontal: 12,
    borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, backgroundColor: colors.surface },
  moreText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  status: { color: colors.textMuted, fontSize: 13, flex: 1 },
  refresh: { color: colors.mint, fontSize: 13, fontWeight: '800' },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  warning: { color: colors.red, fontSize: 12 },
  sheetText: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  search: { minHeight: 46, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, paddingHorizontal: 14,
    color: colors.text, fontSize: 15, backgroundColor: colors.surface },
  results: { gap: 6 },
  result: { padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, gap: 2 },
  resultName: { color: colors.text, fontSize: 16, fontWeight: '800' },
});
