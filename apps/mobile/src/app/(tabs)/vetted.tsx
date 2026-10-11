import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../auth';
import { AppHeader } from '../../components/ui/AppHeader';
import { ModelBanner } from '../../components/ui/ModelBanner';
import { colors, radius } from '../../theme';

// Vetted (owner, 2026-10-11): outside tips CrownIQ checked and rated PLAY, for everyone. Who posted a tip is never shown.
type VettedPick = { id: string; sport: string | null; league: string | null; selection: string; opponent: string | null; market: string;
  line: number | null; side: 'OVER' | 'UNDER' | null; stat: string | null; eventDate: string | null;
  status: 'PENDING' | 'WON' | 'LOST' | 'PUSH' | 'VOID'; createdAt: string; chance: number; price: number | null; ev: number | null;
  event: string | null; start: string | null; reasons?: string[] };
type Vetted = { picks: VettedPick[]; record: { won: number; lost: number } };

const odds = (price: number) => price > 0 ? `+${price}` : `${price}`;
const marketText = (pick: VettedPick) => {
  if (pick.market === 'PLAYER_PROP') return `${pick.side === 'UNDER' ? 'Under' : 'Over'} ${pick.line ?? ''} ${pick.stat ?? ''}`.trim();
  if (pick.market === 'TOTAL') return `${pick.side === 'UNDER' ? 'Under' : 'Over'} ${pick.line ?? ''}`.trim();
  if (pick.market === 'SPREAD') return `Spread ${pick.line !== null && pick.line > 0 ? '+' : ''}${pick.line ?? ''}`;
  if (pick.market === 'MONEYLINE') return 'To win';
  return pick.market.replace(/_/g, ' ').toLowerCase();
};
const when = (pick: VettedPick) => {
  const time = pick.start ?? pick.eventDate;
  if (!time) return null;
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric',
    ...(pick.start ? { hour: 'numeric', minute: '2-digit' } : {}) });
};
const statusColor = (status: VettedPick['status']) => status === 'WON' ? colors.mint : status === 'LOST' ? colors.red : colors.textMuted;

export default function VettedTab() {
  const { request } = useAuth();
  const [data, setData] = useState<Vetted | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { const response = await request('/v1/vetted'); if (!response.ok) throw new Error();
      setData(await response.json() as Vetted); setError(''); }
    catch { setError('Could not load Vetted picks. Pull down to try again.'); }
    finally { setLoading(false); }
  }, [request]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const upcoming = data?.picks.filter((pick) => pick.status === 'PENDING') ?? [];
  const settled = data?.picks.filter((pick) => pick.status !== 'PENDING') ?? [];
  const total = data ? data.record.won + data.record.lost : 0;
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={colors.mint} />}>
      <AppHeader subtitle="Vetted" />
      <ModelBanner title="Crown Approved" text="Outside tips CrownIQ checked against the market and rated PLAY. Only the plays make this list." />
      {total > 0 && <Text style={styles.record}>Last 14 days: {data!.record.won}–{data!.record.lost} · {Math.round(data!.record.won / total * 100)}% hit</Text>}
      {!!error && <Text style={styles.muted}>{error}</Text>}
      {data && !upcoming.length && <Text style={styles.muted}>No vetted plays right now. New ones show up here as CrownIQ approves them.</Text>}
      {upcoming.map((pick) => <PickCard key={pick.id} pick={pick} />)}
      {settled.length > 0 && <Text style={styles.section}>RECENT RESULTS</Text>}
      {settled.map((pick) => <PickCard key={pick.id} pick={pick} />)}
    </ScrollView>
  </SafeAreaView>;
}

function PickCard({ pick }: { pick: VettedPick }) {
  const time = when(pick);
  return <View style={styles.card}>
    <View style={styles.row}>
      <Text style={styles.league}>{pick.league ?? pick.sport ?? ''}</Text>
      <Text style={[styles.badge, { color: statusColor(pick.status) }]}>{pick.status === 'PENDING' ? 'PLAY' : pick.status}</Text>
    </View>
    <Text style={styles.selection}>{pick.selection}</Text>
    <Text style={styles.market}>{marketText(pick)}{pick.opponent ? ` · vs ${pick.opponent}` : ''}</Text>
    {(pick.event || time) && <Text style={styles.muted}>{[pick.event, time].filter(Boolean).join(' · ')}</Text>}
    <Text style={styles.numbers}>{Math.round(pick.chance * 100)}% to hit{pick.price !== null ? ` · ${odds(pick.price)}` : ''}
      {pick.ev !== null ? ` · EV ${pick.ev >= 0 ? '+' : ''}${(pick.ev * 100).toFixed(1)}%` : ''}</Text>
    {pick.reasons?.slice(0, 2).map((reason) => <Text key={reason} style={styles.reason}>• {reason}</Text>)}
  </View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  record: { color: colors.mint, fontSize: 14, fontWeight: '800' },
  section: { color: colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 1.5, marginTop: 8 },
  muted: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  card: { gap: 4, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  league: { color: colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  badge: { fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  selection: { color: colors.text, fontSize: 17, fontWeight: '800' },
  market: { color: colors.text, fontSize: 14 },
  numbers: { color: colors.mint, fontSize: 13, fontWeight: '700', marginTop: 2 },
  reason: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
});
