import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../auth';
import { Notice } from '../../components/Screen';
import { AppHeader } from '../../components/ui/AppHeader';
import { alpha } from '../../components/ui/color';
import { ChipRow, Segmented } from '../../components/ui/Controls';
import type { IconName } from '../../components/ui/Icon';
import { Icon } from '../../components/ui/Icon';
import { PlayerAvatar } from '../../components/ui/PlayerAvatar';
import { UnitsChart } from '../../components/ui/UnitsChart';
import { crownOutcome, formatLine, marketAbbrev, signed } from '../../insights';
import type { CrownStatus } from '../../insights';
import { colors, lineStyleOf, lineStyles, radius } from '../../theme';
import { useBoard } from '../../use-board';

type Pick = { id: string; savedAt: string; playerName: string; market: string; sport: string; threshold: number;
  direction: string; lineType: string; lineScore: number; result: string; actual: number | null; eventStartTime?: string };
type Leg = { playerName: string; market: string; threshold: number; direction: string; lineType?: string; score: number | null;
  grade: string; actual?: number | null; opponent?: string | null; playerId?: string };
/** `personal` Crowns hold the user's own calls; they are kept but not graded as GKR picks. */
type Crown = { id: string; savedAt: string; name?: string; personal?: boolean; legs: Leg[] };
type Range = 7 | 30 | 0;
const DAY = 86_400_000;

const statusStyle: Readonly<Record<CrownStatus, { color: string; label: string }>> = {
  CASHED: { color: colors.mint, label: 'CASHED' }, SPLIT: { color: colors.magenta, label: 'SPLIT' },
  MISSED: { color: colors.red, label: 'MISSED' }, PENDING: { color: colors.textMuted, label: 'PENDING' },
};

function crownTitle(crown: Crown): { title: string; icon: IconName; color: string } {
  const counts = { KINGS: 0, GOBLIN: 0, DEMON: 0, UNKNOWN: 0 };
  for (const leg of crown.legs) counts[lineStyleOf((leg.lineType ?? 'REGULAR') as 'REGULAR')]++;
  const named = crown.name === lineStyles.DEMON.label ? 'DEMON' : crown.name === lineStyles.GOBLIN.label ? 'GOBLIN' : null;
  const style = named ?? (counts.DEMON > crown.legs.length / 2 ? 'DEMON' : counts.GOBLIN > crown.legs.length / 2 ? 'GOBLIN' : 'KINGS');
  const pending = crown.legs.some((leg) => leg.grade === 'PENDING');
  return { title: crown.name ?? (style === 'KINGS' ? "King's Crown" : lineStyles[style].label),
    icon: pending ? 'clock-outline' : lineStyles[style].icon, color: pending ? colors.textMuted : lineStyles[style].color };
}

function WinRing({ rate }: { rate: number | null }) {
  const size = 64, stroke = 7, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return <Svg width={size} height={size}>
    <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.border} strokeWidth={stroke} fill="none" />
    {rate !== null && <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.mint} strokeWidth={stroke} fill="none"
      strokeDasharray={`${c * rate} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
  </Svg>;
}

const shortName = (name: string) => { const parts = name.split(' '); return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : name; };

export default function ResultsScreen() {
  const { request } = useAuth();
  const { nowMs, data: board } = useBoard();
  const [picks, setPicks] = useState<Pick[]>([]), [crowns, setCrowns] = useState<Crown[]>([]);
  const [busy, setBusy] = useState(true), [notice, setNotice] = useState('');
  const [range, setRange] = useState<Range>(7);
  const [filter, setFilter] = useState<CrownStatus | 'ALL'>('ALL');
  const [chartRange, setChartRange] = useState<Range>(7);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const responses = await Promise.all([request('/v1/me/picks?limit=50'), request('/v1/me/crowns')]);
      if (responses.some((item) => !item.ok)) throw new Error('unavailable');
      const [selected, saved] = await Promise.all(responses.map((item) => item.json())) as [{ picks: Pick[] }, { crowns: Crown[] }];
      setPicks(selected.picks); setCrowns(saved.crowns); setNotice('');
    } catch { setNotice('Could not reach your saved results. Reconnect and try again.'); }
    finally { setBusy(false); }
  }, [request]);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  const remove = async (path: string) => {
    try { const response = await request(path, { method: 'DELETE' });
      if (response.status === 403) { setNotice('Demo mode is read-only. Sign in to manage saved results.'); return; }
      if (!response.ok) throw new Error('Remove failed'); await refresh(); }
    catch { setNotice('Could not remove that item. Try again.'); }
  };

  const inRange = (iso: string, days: Range) => days === 0 || nowMs - Date.parse(iso) <= days * DAY;
  const when = (pick: Pick) => pick.eventStartTime ?? pick.savedAt;
  const ranged = picks.filter((pick) => inRange(when(pick), range));
  const graded = ranged.filter((pick) => pick.result === 'WIN' || pick.result === 'LOSS');
  const wins = graded.filter((pick) => pick.result === 'WIN').length;
  const rate = graded.length ? wins / graded.length : null;
  const yesterday = picks.filter((pick) => { const age = nowMs - Date.parse(when(pick)); return age > 0 && age <= DAY * 1.5; });
  const yWins = yesterday.filter((pick) => pick.result === 'WIN').length, yLosses = yesterday.filter((pick) => pick.result === 'LOSS').length;
  const ordered = [...picks].filter((pick) => pick.result === 'WIN' || pick.result === 'LOSS')
    .sort((a, b) => when(b).localeCompare(when(a)));
  let streak = 0; for (const pick of ordered) { if (pick.result !== 'WIN') break; streak++; }

  const outcomes = useMemo(() => crowns.map((crown) => ({ crown, ...crownOutcome(crown.legs.map((leg) => leg.grade)) })), [crowns]);
  const rangedCrowns = outcomes.filter((item) => inRange(item.crown.savedAt, range));
  const settled = rangedCrowns.filter((item) => item.units !== null);
  const units = settled.reduce((sum, item) => sum + (item.units ?? 0), 0);
  const roi = settled.length ? units / settled.length : null;
  const yUnits = outcomes.filter((item) => item.units !== null && nowMs - Date.parse(item.crown.savedAt) <= DAY * 1.5)
    .reduce((sum, item) => sum + (item.units ?? 0), 0);
  const counts = { CASHED: 0, SPLIT: 0, MISSED: 0, PENDING: 0 };
  for (const item of rangedCrowns) counts[item.status]++;
  const shown = rangedCrowns.filter((item) => filter === 'ALL' || item.status === filter);

  const chart = useMemo(() => {
    const days = chartRange || Math.max(7, Math.ceil((nowMs - Math.min(nowMs, ...outcomes.map((item) =>
      Date.parse(item.crown.savedAt)))) / DAY));
    const points = [];
    let total = 0;
    for (let index = days - 1; index >= 0; index--) {
      const start = nowMs - (index + 1) * DAY, end = nowMs - index * DAY;
      total += outcomes.filter((item) => item.units !== null && Date.parse(item.crown.savedAt) > start &&
        Date.parse(item.crown.savedAt) <= end).reduce((sum, item) => sum + (item.units ?? 0), 0);
      const date = new Date(end);
      points.push({ label: `${date.getMonth() + 1}/${date.getDate()}`, value: Math.round(total * 100) / 100 });
    }
    return points;
  }, [outcomes, chartRange, nowMs]);
  const photo = (leg: Leg) => leg.playerId ? board?.playerMedia?.[leg.playerId]?.photoUrl : null;
  const rangeLabel = range === 0 ? 'All time' : `Last ${range} days`;

  return <SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView contentContainerStyle={styles.content}>
      <AppHeader subtitle="Results & Performance" />
      <Pressable accessibilityRole="button" style={styles.range} onPress={() => setRange(range === 7 ? 30 : range === 30 ? 0 : 7)}>
        <Icon name="calendar-blank-outline" size={18} color={colors.mint} /><Text style={styles.rangeText}>{rangeLabel}</Text>
        <Icon name="chevron-down" size={16} color={colors.text} /></Pressable>

      <View style={styles.summary}>
        <View style={styles.cell}><Text style={styles.cellLabel}>Win Rate</Text>
          <View style={styles.winRow}><WinRing rate={rate} /><View>
            <Text style={styles.big}>{rate === null ? '—' : `${Math.round(rate * 100)}%`}</Text>
            <Text style={styles.cellSub}>{wins} / {graded.length}</Text></View></View></View>
        <View style={[styles.cell, styles.divider]}><Text style={styles.cellLabel}>Yesterday</Text>
          <Text style={styles.big}>{yWins} - {yLosses}</Text>
          <Text style={[styles.cellSub, { color: yUnits >= 0 ? colors.mint : colors.red }]}>{signed(yUnits)} u</Text></View>
        <View style={[styles.cell, styles.divider]}><Text style={styles.cellLabel}>Streak</Text>
          <Text style={styles.big}>{streak >= 3 ? '🔥 ' : ''}{streak}</Text>
          <Text style={styles.cellSub}>wins in a row</Text></View>
        <View style={[styles.cell, styles.divider]}><Text style={styles.cellLabel}>Est. Units</Text>
          <Text style={[styles.big, { color: units >= 0 ? colors.mint : colors.red }]}>{signed(units)}u</Text>
          <Text style={styles.cellSub}>{roi === null ? 'no settled Crowns' : `${signed(roi * 100)}% ROI`}</Text></View>
      </View>

      <ChipRow>
        {(['ALL', 'CASHED', 'SPLIT', 'MISSED', 'PENDING'] as const).map((key) => <Pressable key={key} accessibilityRole="button"
          accessibilityState={{ selected: filter === key }} onPress={() => setFilter(key)}
          style={[styles.filter, filter === key && styles.filterActive]}>
          <Text style={[styles.filterText, filter === key && styles.filterTextActive]}>{key === 'ALL' ? 'All Results'
            : `${key.charAt(0)}${key.slice(1).toLowerCase()} (${counts[key]})`}</Text></Pressable>)}
      </ChipRow>

      {!!notice && <Text accessibilityRole="alert" style={styles.warning}>{notice}</Text>}
      {busy && !crowns.length && <Notice title="Loading results" detail="Retrieving your saved Crowns and picks." />}
      {!busy && !shown.length && !notice && <Notice title="No Crowns here yet"
        detail="Save a Crown from the Crown tab and it will be graded here once its games finish." />}

      {shown.map(({ crown, status, units: crownUnits }) => {
        const title = crownTitle(crown), state = statusStyle[status];
        const scored = crown.legs.flatMap((leg) => leg.score === null ? [] : [leg.score]);
        const average = crown.personal ? 0 : scored.reduce((sum, score) => sum + score, 0) / Math.max(1, scored.length);
        return <View key={crown.id} style={[styles.crown, { borderColor: alpha(title.color, 0.55) }]}>
          <View style={styles.crownHead}>
            <Icon name={title.icon} size={40} color={title.color} />
            <View style={styles.grow}><Text style={styles.crownName}>{title.title}</Text>
              <Text style={styles.pickSub}>{crown.legs.length} Legs · {new Date(crown.savedAt).toLocaleDateString('en-US',
                { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
              {average >= 90 && <Text style={styles.confidence}>High confidence</Text>}
              {crown.personal && <Text style={styles.yourCall}>Your call · not graded by GKR</Text>}</View>
            <View style={[styles.status, { borderColor: state.color, backgroundColor: alpha(state.color, 0.1) }]}>
              <Text style={[styles.statusText, { color: state.color }]}>{state.label}</Text></View>
            <Text style={[styles.units, { color: crownUnits === null ? colors.textMuted : crownUnits >= 0 ? colors.mint : colors.red }]}>
              {crownUnits === null ? '—' : `${signed(crownUnits)}u`}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${title.title}`} hitSlop={8}
              onPress={() => void remove(`/v1/me/crowns/${crown.id}`)}><Icon name="close" size={18} color={colors.textFaint} /></Pressable>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.legs}>
            {crown.legs.map((leg, index) => <View key={index} style={styles.leg}>
              <View><PlayerAvatar name={leg.playerName} photoUrl={photo(leg)} size={48}
                ring={leg.grade === 'WIN' ? colors.mint : leg.grade === 'LOSS' ? colors.red : colors.borderStrong} />
                {leg.grade !== 'PENDING' && <View style={[styles.mark, { backgroundColor: leg.grade === 'WIN' ? colors.mint : colors.red }]}>
                  <Icon name={leg.grade === 'WIN' ? 'check' : 'close'} size={12} color={colors.mintInk} /></View>}</View>
              <View><Text style={styles.legName} numberOfLines={1}>{shortName(leg.playerName)}</Text>
                <Text style={styles.legLine}>{marketAbbrev(leg.market)} {formatLine(leg.threshold)}{leg.direction === 'MORE' ? '+' : '−'}</Text>
                {leg.actual !== null && leg.actual !== undefined && <Text style={[styles.legActual,
                  { color: leg.grade === 'WIN' ? colors.mint : colors.red }]}>{leg.actual} {marketAbbrev(leg.market)}</Text>}
                {leg.opponent ? <Text style={styles.legLine}>vs {leg.opponent}</Text> : null}</View>
            </View>)}
          </ScrollView>
        </View>;
      })}

      <View style={styles.chartCard}>
        <View style={styles.chartHead}><Icon name="chart-bar" size={22} color={colors.mint} />
          <Text style={styles.chartTitle}>Cumulative Units</Text>
          <View style={styles.chartToggle}><Segmented label="Chart range" value={chartRange} onChange={setChartRange}
            options={[{ value: 7 as Range, label: '7D' }, { value: 30 as Range, label: '30D' }, { value: 0 as Range, label: 'All' }]} /></View>
        </View>
        <UnitsChart points={chart} />
        <Text style={styles.footnote}>Units are estimated from a default PrizePicks Flex payout table at 1 unit per Crown.</Text>
      </View>

      {ranged.length > 0 && <View style={styles.picks}>
        <Text style={styles.sectionTitle}>Saved picks</Text>
        {ranged.slice(0, 12).map((pick) => <View key={pick.id} style={styles.pick}>
          <View style={styles.grow}><Text style={styles.legName}>{pick.playerName}</Text>
            <Text style={styles.pickSub}>{marketAbbrev(pick.market)} {pick.direction} {formatLine(pick.threshold)} · GKR {Math.round(pick.lineScore)}</Text></View>
          <Text style={[styles.pickResult, { color: pick.result === 'WIN' ? colors.mint : pick.result === 'LOSS' ? colors.red : colors.textMuted }]}>
            {pick.result === 'PENDING' ? 'Pending' : pick.result}{pick.actual !== null ? ` · ${pick.actual}` : ''}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${pick.playerName} pick`} hitSlop={8}
            onPress={() => void remove(`/v1/me/picks/${pick.id}`)}><Icon name="close" size={18} color={colors.textFaint} /></Pressable>
        </View>)}
      </View>}
      <Pressable accessibilityRole="button" onPress={() => router.push('/(tabs)/top-picks')}><Text style={styles.link}>Find today’s top picks</Text></Pressable>
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  yourCall: { color: colors.gold, fontSize: 12, fontWeight: '700' },
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 14 },
  range: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, paddingHorizontal: 10, minHeight: 42, backgroundColor: colors.surface },
  rangeText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  summary: { flexDirection: 'row', backgroundColor: colors.surface, borderWidth: 1.5, borderColor: alpha(colors.mint, 0.5),
    borderRadius: radius.lg, paddingVertical: 12 },
  cell: { flex: 1, alignItems: 'center', gap: 3, paddingHorizontal: 4 },
  divider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.borderStrong },
  cellLabel: { color: colors.textMuted, fontSize: 11.5, fontWeight: '600' },
  winRow: { alignItems: 'center', gap: 2 },
  big: { color: colors.text, fontSize: 19, fontWeight: '900', textAlign: 'center' },
  cellSub: { color: colors.textMuted, fontSize: 11.5, textAlign: 'center' },
  filter: { minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.borderStrong, backgroundColor: colors.surface },
  filterActive: { borderColor: colors.mint, backgroundColor: colors.mintWash },
  filterText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  filterTextActive: { color: colors.mint, fontWeight: '800' },
  warning: { color: colors.red, fontSize: 13 },
  crown: { backgroundColor: colors.surface, borderWidth: 1.5, borderRadius: radius.lg, padding: 12, gap: 12 },
  crownHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1, minWidth: 0 },
  crownName: { color: colors.text, fontSize: 19, fontWeight: '800' },
  confidence: { color: colors.mint, fontSize: 12, fontWeight: '700' },
  status: { borderWidth: 1.5, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4 },
  statusText: { fontSize: 12, fontWeight: '900', letterSpacing: 0.5 },
  units: { fontSize: 18, fontWeight: '900', minWidth: 54, textAlign: 'right' },
  legs: { gap: 14 },
  leg: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  mark: { position: 'absolute', right: -2, top: -2, width: 18, height: 18, borderRadius: 9, alignItems: 'center',
    justifyContent: 'center' },
  legName: { color: colors.text, fontSize: 13.5, fontWeight: '700', maxWidth: 110 },
  legLine: { color: colors.textMuted, fontSize: 12 },
  legActual: { fontSize: 14, fontWeight: '900' },
  chartCard: { backgroundColor: colors.surface, borderWidth: 1.5, borderColor: alpha(colors.mint, 0.5), borderRadius: radius.lg,
    padding: 12, gap: 8 },
  chartHead: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  chartTitle: { color: colors.text, fontSize: 17, fontWeight: '800', flex: 1 },
  chartToggle: { width: 170 },
  footnote: { color: colors.textMuted, fontSize: 11.5 },
  picks: { gap: 8 },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface, borderWidth: 1,
    borderColor: colors.border, borderRadius: radius.md, padding: 10 },
  pickSub: { color: colors.textMuted, fontSize: 12 },
  pickResult: { fontSize: 13, fontWeight: '800' },
  link: { color: colors.mint, fontWeight: '800', textAlign: 'center', paddingVertical: 6 },
});
