import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { EdgePickCard } from '../../components/EdgePickCard';
import { EdgeSlipPanel, SlipSummary } from '../../components/EdgeSlipPanel';
import { Notice, Screen } from '../../components/Screen';
import { pct, sportsFrom } from '../../edge-format';
import { useEdgeSlip } from '../../edge-slip';
import { palette } from '../../theme';
import { useBoard } from '../../use-board';
import { useEdge } from '../../use-edge';
import type { EdgeView } from '../../use-edge';

const views: { key: EdgeView; label: string }[] = [
  { key: 'edges', label: 'Best edges' }, { key: 'alternates', label: 'Goblins & Demons' },
];

export default function EdgeScreen() {
  const [view, setView] = useState<EdgeView>('edges');
  const [sport, setSport] = useState<string | null>(null);
  const { status, data, message, retry } = useEdge(view);
  const slip = useEdgeSlip();
  const { nowMs } = useBoard();
  const live = data?.picks.filter((pick) => Date.parse(pick.eventStartTime) > nowMs) ?? [];
  const sports = sportsFrom(live);
  const picks = live.filter((pick) => !sport || pick.sport === sport).slice(0, 100);
  const inSlip = new Set(slip.map((leg) => leg.lineId));
  return <Screen eyebrow="CROWNIQ  /  EDGE ENGINE" title="Edge">
    <Text style={styles.intro}>Hit probabilities priced from sharp sportsbook lines, the stats model and the PrizePicks ladder. Runs beside GKR.</Text>
    <View style={styles.chips}>{views.map((item) => <Pressable key={item.key} accessibilityRole="button"
      onPress={() => setView(item.key)} style={[styles.chip, view === item.key && styles.chipOn]}>
      <Text style={[styles.chipText, view === item.key && styles.chipTextOn]}>{item.label}</Text></Pressable>)}</View>
    {!data ? <>
      <Notice title={status === 'loading' ? 'Pricing the board' : 'Edge pending'}
        detail={message || 'Reading the saved board and sportsbook prices.'} />
      <Pressable accessibilityRole="button" onPress={retry}><Text style={styles.link}>Retry</Text></Pressable>
    </> : <>
      <View style={styles.stats}>
        <Stat label="Priced" value={String(data.counts.linesPriced)} />
        <Stat label="+EV lines" value={String(data.counts.positiveEdge)} />
        <Stat label="Sharp-priced" value={String(data.counts.sharp)} />
        <Stat label="Break-even" value={pct(data.referenceEntry.breakEven)} />
      </View>
      <Text style={styles.meta}>Break-even is the {data.referenceEntry.size}-pick {data.referenceEntry.type.toLowerCase()} entry.
        {' '}{data.calibration.status === 'CALIBRATED' ? `Calibrated on ${data.calibration.graded} graded picks.`
          : `Uncalibrated: ${data.calibration.graded} graded picks so far (calibration starts at 150).`}
        {data.counts.quotes === 0 ? ' No sportsbook prices on this board yet; picks are model/ladder only.' : ''}</Text>
      {sports.length > 1 && <View style={styles.chips}>
        {[null, ...sports].map((item) => <Pressable key={item ?? 'all'} accessibilityRole="button"
          onPress={() => setSport(item)} style={[styles.chip, sport === item && styles.chipOn]}>
          <Text style={[styles.chipText, sport === item && styles.chipTextOn]}>{item ?? 'All'}</Text></Pressable>)}
      </View>}
      <EdgeSlipPanel entries={data.entries} />
      {view === 'edges' && data.slips.length > 0 && <View style={styles.section}>
        <Text style={styles.sectionTitle}>BEST ENTRIES</Text>
        <Text style={styles.sectionDetail}>Highest expected value using the strongest legs, one per player and at most two per game.</Text>
        {data.slips.slice(0, 2).map((item) => <View key={item.entry.type + item.entry.size + item.legs.map((leg) => leg.lineId).join()} style={styles.card}>
          <SlipSummary slip={item} /></View>)}
      </View>}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{view === 'edges' ? 'PICKS ABOVE BREAK-EVEN' : 'ALTERNATE LINES BY HIT PROBABILITY'}</Text>
        <Text style={styles.sectionDetail}>{view === 'edges'
          ? 'Standard lines whose hit probability beats the break-even. Edge is shown in percentage points.'
          : 'PrizePicks does not publish Goblin/Demon payout factors through the feed. Each card shows the minimum factor that makes the leg worth it.'}</Text>
        {picks.length ? picks.map((pick, index) => <EdgePickCard key={pick.key + pick.side} pick={pick}
          rank={view === 'edges' ? index + 1 : undefined} inSlip={inSlip.has(pick.lineId)} />)
          : <Notice title="Nothing qualifies right now" detail="No lines clear the bar on the saved board. No edge is a valid result." />}
      </View>
      <Pressable accessibilityRole="button" onPress={retry}><Text style={styles.link}>Refresh Edge</Text></Pressable>
    </>}
  </Screen>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  intro: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: -8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: palette.border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 },
  chipOn: { backgroundColor: palette.greenDim, borderColor: palette.green },
  chipText: { color: palette.muted, fontSize: 12, fontWeight: '800' },
  chipTextOn: { color: palette.green },
  stats: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 14, padding: 10 },
  statValue: { color: palette.text, fontSize: 18, fontWeight: '900' },
  statLabel: { color: palette.muted, fontSize: 10, fontWeight: '700' },
  meta: { color: palette.muted, fontSize: 11, lineHeight: 16 },
  section: { gap: 10, marginTop: 4 },
  sectionTitle: { color: palette.green, fontSize: 13, fontWeight: '900', letterSpacing: 1.4 },
  sectionDetail: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  card: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 18, padding: 16 },
  link: { color: palette.green, fontSize: 13, fontWeight: '800' },
});
