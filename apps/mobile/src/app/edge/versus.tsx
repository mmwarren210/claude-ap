import { headToHeadReportSchema } from '@crowniq/contracts';
import type { EngineRecord, HeadToHeadReport } from '@crowniq/contracts';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../auth';
import { Notice, Screen } from '../../components/Screen';
import { formatLine, marketLabel, pct, signedUnits } from '../../edge-format';
import { palette } from '../../theme';

type Tier = 'top' | 'all';

export default function Versus() {
  const { request } = useAuth();
  const [tier, setTier] = useState<Tier>('all');
  const [state, setState] = useState<{ report: HeadToHeadReport | null; message: string }>({ report: null, message: '' });
  useFocusEffect(useCallback(() => {
    let active = true;
    void request('/v1/edge/head-to-head').then(async (response) => {
      if (!active) return;
      if (!response.ok) { setState({ report: null, message: response.status === 503 ? 'Head-to-head tracking is not configured on the server.' : 'Could not load the scoreboard.' }); return; }
      setState({ report: headToHeadReportSchema.parse(await response.json()), message: '' });
    }).catch(() => { if (active) setState({ report: null, message: 'Could not load the scoreboard.' }); });
    return () => { active = false; };
  }, [request]));
  const report = state.report;
  if (!report) return <Screen eyebrow="EDGE  /  HEAD TO HEAD" title="Edge vs GKR">
    <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.link}>← Back</Text></Pressable>
    <Notice title={state.message ? 'Unavailable' : 'Loading'} detail={state.message || 'Reading graded results.'} />
  </Screen>;
  const records = report.tiers[tier];
  const leaderColor = report.leader.engine === 'EDGE' ? palette.green : report.leader.engine === 'GKR' ? palette.danger : palette.muted;
  const maxUnits = Math.max(1, ...report.daily.map((day) => Math.max(Math.abs(day.edgeUnits), Math.abs(day.gkrUnits))));
  return <Screen eyebrow="EDGE  /  HEAD TO HEAD" title="Edge vs GKR">
    <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.link}>← Back</Text></Pressable>
    <View style={[styles.leader, { borderColor: leaderColor }]}>
      <Text style={[styles.leaderTitle, { color: leaderColor }]}>{report.leader.engine === 'TOO_EARLY' ? 'TOO EARLY TO CALL'
        : report.leader.engine === 'TIE' ? 'DEAD EVEN' : `${report.leader.engine} LEADS`}{report.leader.pValue !== null && report.leader.pValue < .05 ? ' ✓' : ''}</Text>
      <Text style={styles.text}>{report.leader.note}</Text>
    </View>
    <View style={styles.chips}>{(['all', 'top'] as const).map((item) => <Pressable key={item} accessibilityRole="button"
      onPress={() => setTier(item)} style={[styles.chip, tier === item && styles.chipOn]}>
      <Text style={[styles.chipText, tier === item && styles.chipTextOn]}>{item === 'all' ? 'All calls' : 'Top picks only'}</Text></Pressable>)}</View>
    <Text style={styles.muted}>{tier === 'all' ? 'Every standard line each engine took a side on.' : 'GKR 80+ vs Edge STRONG/ELITE: what each engine headlines.'}</Text>
    <View style={styles.columns}>
      <EngineCard name="EDGE" record={records.edge} accent={palette.green} />
      <EngineCard name="GKR" record={records.gkr} accent={palette.text} />
    </View>
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>WHEN THEY DISAGREE</Text>
      <Text style={styles.big}>Edge {report.overlap.edgeWins} – {report.overlap.gkrWins} GKR</Text>
      <Text style={styles.muted}>{report.overlap.disagree} disagreements, {report.overlap.disagreementsGraded} graded · {report.overlap.agree} lines where both agree ·
        {' '}{report.overlap.edgeOnly} Edge-only and {report.overlap.gkrOnly} GKR-only calls</Text>
    </View>
    {report.daily.length > 0 && <View style={styles.card}>
      <Text style={styles.sectionTitle}>UNITS BY DAY</Text>
      {report.daily.slice(-14).map((day) => <View key={day.date} style={styles.dayRow}>
        <Text style={styles.dayLabel}>{day.date.slice(5)}</Text>
        <View style={styles.bars}>
          <Bar value={day.edgeUnits} max={maxUnits} color={palette.green} />
          <Bar value={day.gkrUnits} max={maxUnits} color={palette.muted} />
        </View>
        <Text style={styles.dayValue}>{signedUnits(day.edgeUnits)} / {signedUnits(day.gkrUnits)}</Text>
      </View>)}
      <Text style={styles.muted}>Green = Edge, grey = GKR. One unit per leg, paid at the {pct(report.breakEven)} break-even.</Text>
    </View>}
    {Object.keys(report.bySport).length > 0 && <View style={styles.card}>
      <Text style={styles.sectionTitle}>BY SPORT (ALL CALLS)</Text>
      {Object.entries(report.bySport).map(([sport, value]) => <View key={sport} style={styles.sportRow}>
        <Text style={[styles.text, styles.sportName]}>{sport}</Text>
        <Text style={styles.sportEdge}>{value.edge.hitRate === null ? '—' : pct(value.edge.hitRate, 0)} ({value.edge.graded})</Text>
        <Text style={styles.sportGkr}>{value.gkr.hitRate === null ? '—' : pct(value.gkr.hitRate, 0)} ({value.gkr.graded})</Text>
      </View>)}
    </View>}
    {report.recentDisagreements.length > 0 && <View style={styles.card}>
      <Text style={styles.sectionTitle}>RECENT DISAGREEMENTS</Text>
      {report.recentDisagreements.map((item, index) => <View key={`${index}-${item.playerName}-${item.market}-${item.threshold}`} style={styles.disagreement}>
        <Text style={styles.text}>{item.playerName} · {formatLine(item.threshold)} {marketLabel(item.market)}</Text>
        <Text style={styles.muted}>Edge {item.edge.side} ({pct(item.edge.probability, 0)}) vs GKR {item.gkr.side}{item.gkr.score === null ? '' : ` (${item.gkr.score})`}
          {item.actual === null ? '' : ` · actual ${formatLine(item.actual)}`}</Text>
        <Text style={[styles.winner, { color: item.winner === 'EDGE' ? palette.green : item.winner === 'GKR' ? palette.danger : palette.muted }]}>
          {item.winner === 'PENDING' ? 'PENDING' : item.winner === 'PUSH' ? 'PUSH' : `${item.winner} WAS RIGHT`}</Text>
      </View>)}
    </View>}
    <Text style={styles.muted}>Both engines are snapshotted on the same standard PrizePicks lines at the same refreshes and graded from the same results. An engine&apos;s last pre-game side counts even if a later refresh drops it. Goblins and Demons are excluded because their payout factors are unknown. Close = sportsbook-implied chance of the engine&apos;s side at the last pre-game price.</Text>
  </Screen>;
}

function EngineCard({ name, record, accent }: { name: string; record: EngineRecord; accent: string }) {
  return <View style={styles.engine}>
    <Text style={[styles.engineName, { color: accent }]}>{name}</Text>
    <Text style={[styles.engineHit, { color: accent }]}>{record.hitRate === null ? '—' : pct(record.hitRate)}</Text>
    <Text style={styles.muted}>{record.wins}-{record.losses}{record.pushes ? `-${record.pushes}` : ''} · {record.calls} calls</Text>
    <Text style={styles.muted}>{record.ci95 ? `95% CI ${pct(record.ci95[0], 0)}–${pct(record.ci95[1], 0)}` : 'No graded calls yet'}</Text>
    <Text style={[styles.units, { color: record.units >= 0 ? palette.green : palette.danger }]}>{signedUnits(record.units)}</Text>
    <Text style={styles.muted}>ROI {record.roi === null ? '—' : (record.roi * 100).toFixed(1) + '%'}</Text>
    <Text style={styles.muted}>Close {record.closingFair === null ? '—' : pct(record.closingFair)} · beat {record.beatCloseRate === null ? '—' : pct(record.beatCloseRate, 0)}</Text>
  </View>;
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const width = `${Math.min(100, Math.abs(value) / max * 100)}%` as const;
  return <View style={styles.barTrack}><View style={[styles.bar, { width, backgroundColor: color, opacity: value < 0 ? .45 : 1 }]} /></View>;
}

const styles = StyleSheet.create({
  link: { color: palette.green, fontSize: 13, fontWeight: '800' },
  leader: { borderWidth: 1, borderRadius: 18, padding: 16, gap: 6, backgroundColor: palette.card },
  leaderTitle: { fontSize: 20, fontWeight: '900', letterSpacing: 1 },
  text: { color: palette.text, fontSize: 13, lineHeight: 19 },
  muted: { color: palette.muted, fontSize: 12, lineHeight: 17 },
  chips: { flexDirection: 'row', gap: 8 },
  chip: { borderWidth: 1, borderColor: palette.border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 },
  chipOn: { backgroundColor: palette.greenDim, borderColor: palette.green },
  chipText: { color: palette.muted, fontSize: 12, fontWeight: '800' },
  chipTextOn: { color: palette.green },
  columns: { flexDirection: 'row', gap: 10 },
  engine: { flex: 1, backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 18, padding: 14, gap: 3 },
  engineName: { fontSize: 12, fontWeight: '900', letterSpacing: 1.4 },
  engineHit: { fontSize: 32, fontWeight: '900', letterSpacing: -1 },
  units: { fontSize: 18, fontWeight: '900', marginTop: 4 },
  card: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 18, padding: 16, gap: 8 },
  sectionTitle: { color: palette.green, fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  big: { color: palette.text, fontSize: 22, fontWeight: '900' },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dayLabel: { color: palette.muted, fontSize: 11, width: 40 },
  bars: { flex: 1, gap: 2 },
  barTrack: { height: 6, backgroundColor: palette.background, borderRadius: 3, overflow: 'hidden' },
  bar: { height: 6, borderRadius: 3 },
  dayValue: { color: palette.muted, fontSize: 10, width: 86, textAlign: 'right' },
  sportRow: { flexDirection: 'row', gap: 8 },
  sportName: { flex: 1 },
  sportEdge: { color: palette.green, fontSize: 12, fontWeight: '800', width: 80, textAlign: 'right' },
  sportGkr: { color: palette.text, fontSize: 12, width: 80, textAlign: 'right' },
  disagreement: { gap: 2, borderTopWidth: 1, borderTopColor: palette.border, paddingTop: 8 },
  winner: { fontSize: 11, fontWeight: '900', letterSpacing: 1 },
});
