import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth';
import { formatLine, gameTime, marketLabel } from '../insights';
import { appNames } from '../port';
import { colors, radius } from '../theme';
import { BoardPicker } from './BoardPicker';
import type { BoardSource } from './BoardPicker';
import { Notice } from './Screen';
import { AppHeader } from './ui/AppHeader';
import { ChipRow, FilterChip } from './ui/Controls';

// Line shopping: the same player and stat on PrizePicks, Underdog and DK Pick’em, with the easiest number per side and the
// sportsbooks' line. Biggest gaps first. Display only.

type Side = 'MORE' | 'LESS';
type Source = 'prizepicks' | 'underdog' | 'pick6';
type Best = { source: Source; threshold: number } | null;
export type ShopEntry = { key: string; league: string; playerName: string; team: string | null; market: string;
  eventStartTime: string; eventName: string | null;
  offers: { source: Source; lineId: string; threshold: number; sides: Side[]; multipliers: Partial<Record<Side, number>> | null }[];
  bestMore: Best; bestLess: Best; spread: number; booksLine: number | null; booksOver: number | null;
  books: { book: string; line: number; fairOver: number }[];
  pick: { side: Side; by: 'GKR' | 'HISTORY'; score: number; best: Best } | null };

const short: Readonly<Record<Source, string>> = { prizepicks: 'PrizePicks', underdog: 'Underdog', pick6: 'DK Pick’em' };
const word = (side: Side) => side === 'MORE' ? 'More' : 'Less';

/** One player and stat across the apps. Used on the Line Shop board and the player screen. */
export function ShopCard({ entry, compact }: { entry: ShopEntry; compact?: boolean }) {
  const isBest = (source: Source, threshold: number) => ({
    more: entry.bestMore?.source === source && entry.bestMore.threshold === threshold && entry.spread > 0,
    less: entry.bestLess?.source === source && entry.bestLess.threshold === threshold && entry.spread > 0 });
  return <View style={[styles.card, compact && styles.compact]}>
    {!compact && <View style={styles.head}>
      <View style={styles.grow}><Text style={styles.name} numberOfLines={1}>{entry.playerName}</Text>
        <Text style={styles.meta} numberOfLines={1}>{entry.league} · {marketLabel(entry.market)} · {gameTime(entry.eventStartTime)}</Text></View>
      {entry.spread > 0 && <Text style={styles.gap}>{formatLine(entry.spread)} apart</Text>}
    </View>}
    <View style={styles.offers}>{entry.offers.map((offer) => {
      const best = isBest(offer.source, offer.threshold);
      return <View key={offer.lineId} style={[styles.offer, (best.more || best.less) && styles.offerBest]}>
        <Text style={styles.app}>{short[offer.source]}</Text>
        <Text style={styles.number}>{formatLine(offer.threshold)}</Text>
        <Text style={styles.tag}>{best.more ? 'Best More' : best.less ? 'Best Less' : offer.sides.length === 1 ? `${word(offer.sides[0])} only` : ' '}
          {offer.multipliers?.MORE && offer.multipliers.MORE !== 1 ? ` · M ${offer.multipliers.MORE}x` : ''}
          {offer.multipliers?.LESS && offer.multipliers.LESS !== 1 ? ` · L ${offer.multipliers.LESS}x` : ''}</Text>
      </View>;
    })}</View>
    {entry.booksLine !== null && <Text style={styles.books}>Sportsbooks: {formatLine(entry.booksLine)}
      {entry.booksOver !== null ? ` · ${Math.round(entry.booksOver * 100)}% over (no vig)` : ''}</Text>}
    {entry.pick?.best && <Text style={styles.pick}>{entry.pick.by === 'GKR' ? `GKR ${entry.pick.score}` : `History ${entry.pick.score}`}
      {' '}backs {word(entry.pick.side)}: easiest on {appNames[entry.pick.best.source]} at {formatLine(entry.pick.best.threshold)}</Text>}
  </View>;
}

/** The line shop for one PrizePicks line, on the player screen (nothing when no other app lists it). */
export function LineShopFor({ lineId }: { lineId: string }) {
  const { request, demo } = useAuth();
  const [entry, setEntry] = useState<ShopEntry | null>(null);
  useEffect(() => {
    if (demo) return;
    let active = true;
    void request(`/v1/line-shop?lineId=${encodeURIComponent(lineId)}`).then(async (response) => {
      const body = response.ok ? await response.json() as { entry: ShopEntry | null } : null;
      if (active) setEntry(body?.entry ?? null);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [request, demo, lineId]);
  if (!entry) return null;
  return <View style={styles.forLine}>
    <Text style={styles.forTitle}>Line shop{entry.spread > 0 ? ` · ${formatLine(entry.spread)} apart` : ' · same number everywhere'}</Text>
    <ShopCard entry={entry} compact />
  </View>;
}

export function LineShopBoard({ onSource }: { onSource: (source: BoardSource) => void }) {
  const { request, demo } = useAuth();
  const [entries, setEntries] = useState<ShopEntry[]>([]), [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [league, setLeague] = useState('ALL'), [backedOnly, setBackedOnly] = useState(false);
  useFocusEffect(useCallback(() => {
    if (demo) { setState('ready'); return; }
    let active = true;
    void request('/v1/line-shop').then(async (response) => {
      const body = response.ok ? await response.json() as { entries: ShopEntry[] } : null;
      if (active) { setEntries(body?.entries ?? []); setState(body ? 'ready' : 'error'); }
    }).catch(() => { if (active) setState('error'); });
    return () => { active = false; };
  }, [request, demo]));
  const leagues = useMemo(() => [...new Set(entries.map((entry) => entry.league))].sort(), [entries]);
  const shown = entries.filter((entry) => (league === 'ALL' || entry.league === league) && (!backedOnly || entry.pick?.best));
  const header = <View style={styles.header}>
    <AppHeader subtitle="Line shop" />
    <BoardPicker value="shop" onChange={onSource} />
    {leagues.length > 1 && <ChipRow>
      <FilterChip label="All leagues" active={league === 'ALL'} chevron={false} onPress={() => setLeague('ALL')} />
      <FilterChip label="Backed sides" icon="check-decagram-outline" active={backedOnly} chevron={false} onPress={() => setBackedOnly(!backedOnly)} />
      {leagues.map((item) => <FilterChip key={item} label={item} active={league === item} chevron={false} onPress={() => setLeague(item)} />)}
    </ChipRow>}
    <Text style={styles.explain}>The same player and stat on each app. For More, the lowest number is easiest; for Less, the
      highest. Biggest gaps first. PrizePicks Goblins and Demons are left out because they pay differently.</Text>
  </View>;
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={shown} keyExtractor={(entry) => entry.key} contentContainerStyle={styles.content} ListHeaderComponent={header}
      initialNumToRender={8} windowSize={7} renderItem={({ item }) => <ShopCard entry={item} />}
      ListEmptyComponent={<Notice title={demo ? 'Sign in to shop lines' : state === 'loading' ? 'Loading lines'
        : state === 'error' ? 'Line shop unavailable' : 'Nothing to compare right now'}
        detail={demo ? 'The demo shows PrizePicks only.' : 'Lines show once two apps list the same player and stat.'} />} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 12 },
  header: { gap: 12 },
  explain: { color: colors.textMuted, fontSize: 12.5, lineHeight: 18 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 12, gap: 10 },
  compact: { padding: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: colors.text, fontSize: 16, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: 12.5 },
  gap: { color: colors.gold, fontSize: 13, fontWeight: '900' },
  offers: { flexDirection: 'row', gap: 8 },
  offer: { flex: 1, alignItems: 'center', gap: 2, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    paddingVertical: 8, backgroundColor: colors.surfaceSunken },
  offerBest: { borderColor: colors.mint },
  app: { color: colors.textMuted, fontSize: 11.5, fontWeight: '800' },
  number: { color: colors.text, fontSize: 20, fontWeight: '900' },
  tag: { color: colors.mint, fontSize: 10.5, fontWeight: '800', textAlign: 'center' },
  books: { color: colors.textMuted, fontSize: 12.5 },
  pick: { color: colors.mint, fontSize: 13, fontWeight: '800' },
  forLine: { gap: 8 },
  forTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
});
