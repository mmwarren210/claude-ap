import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { EdgePickCard } from '../../components/EdgePickCard';
import { EdgeRecord } from '../../components/EdgeRecord';
import { EdgeSlipPanel, SlipSummary, StakePicker } from '../../components/EdgeSlipPanel';
import { Notice, Screen } from '../../components/Screen';
import { sportsFrom } from '../../edge-format';
import { edgePlatform, EDGE_PLATFORMS, isBook, platformLabel, useEdgePlatform } from '../../edge-platform';
import { useEdgeSlip } from '../../edge-slip';
import { palette } from '../../theme';
import { useBoard } from '../../use-board';
import { useEdge } from '../../use-edge';
import { useIsOwner } from '../../use-owner';

// GKR+ (owner only): Edge's read blended with the player's history at the number and GKR's side, on every platform.
// Same platforms and pick cards as the Edge tab; its own record.
type Section = 'top' | 'record';
const sections: { key: Section; label: string }[] = [{ key: 'top', label: 'Top Picks' }, { key: 'record', label: 'Record' }];

export default function GkrPlusScreen() {
  const owner = useIsOwner();
  const [section, setSection] = useState<Section>('top');
  const platform = useEdgePlatform(), book = isBook(platform);
  const [sport, setSport] = useState<string | null>(null);
  const [day, setDay] = useState<'all' | 'today'>('all');
  const { status, data, message, retry } = useEdge('edges', 'gkr-plus', day);
  const slip = useEdgeSlip();
  const { nowMs } = useBoard();
  if (!owner) return <Screen eyebrow="CROWNIQ  /  GKR+" title="GKR+"><Notice title="Not available" detail="This tab is for the owner." /></Screen>;
  const live = data?.picks.filter((pick) => Date.parse(pick.eventStartTime) > nowMs) ?? [];
  const sports = sportsFrom(live);
  const picks = live.filter((pick) => !sport || pick.sport === sport).slice(0, 100);
  const inSlip = new Set(slip.map((leg) => leg.lineId));
  return <Screen eyebrow={`CROWNIQ  /  GKR+  /  ${platformLabel(platform).toUpperCase()}`} title="GKR+">
    <Text style={styles.intro}>A test model, only for you: Edge&apos;s chance blended with the player&apos;s history at this exact number and GKR&apos;s side where GKR plays the line. It keeps its own record next to Edge&apos;s.</Text>
    <View style={styles.chips}>{EDGE_PLATFORMS.map((item) => <Pressable key={item.value} accessibilityRole="button"
      accessibilityState={{ selected: platform === item.value }} onPress={() => { edgePlatform.set(item.value); setSport(null); }}
      style={[styles.chip, platform === item.value && styles.chipOn]}>
      <Text style={[styles.chipText, platform === item.value && styles.chipTextOn]}>{item.label}</Text></Pressable>)}</View>
    <View style={styles.segments}>{sections.map((item) => <Pressable key={item.key} accessibilityRole="tab"
      accessibilityState={{ selected: section === item.key }} onPress={() => setSection(item.key)}
      style={[styles.segment, section === item.key && styles.segmentOn]}>
      <Text style={[styles.segmentText, section === item.key && styles.segmentTextOn]}>{item.label}</Text></Pressable>)}</View>
    {section === 'record' ? <EdgeRecord path="/v1/owner/gkr-plus/record" name="GKR+" /> : !data ? <>
      <Notice title={status === 'loading' ? 'Blending the board' : 'GKR+ pending'} detail={message || 'Reading Edge, history and GKR.'} />
      <Pressable accessibilityRole="button" onPress={retry}><Text style={styles.link}>Retry</Text></Pressable>
    </> : <>
      {!!data.feedNote && <Notice title="Feed down" detail={data.feedNote} />}
      <View style={styles.stats}>
        <Stat label="Priced" value={String(data.counts.linesPriced)} />
        <Stat label="+EV picks" value={String(data.counts.positiveEdge)} />
      </View>
      {sports.length > 1 && <View style={styles.chips}>
        {[null, ...sports].map((item) => <Pressable key={item ?? 'all'} accessibilityRole="button"
          onPress={() => setSport(item)} style={[styles.chip, sport === item && styles.chipOn]}>
          <Text style={[styles.chipText, sport === item && styles.chipTextOn]}>{item ?? 'All'}</Text></Pressable>)}
      </View>}
      <EdgeSlipPanel entries={data.entries} />
      {<View style={styles.section}>
        <Text style={styles.sectionTitle}>BEST ENTRIES</Text>
        <Text style={styles.sectionDetail}>Highest expected value from GKR+&apos;s strongest legs, one per player and at most two per game.</Text>
        <DayChips day={day} setDay={setDay} />
        {!data.slips.length && <Text style={styles.sectionDetail}>{day === 'today' ? 'No entry clears the bar with today’s games alone.' : 'No entry clears the bar right now.'}</Text>}
        <StakePicker />
        {data.slips.slice(0, 2).map((item) => <View key={item.entry.type + item.entry.size + item.legs.map((leg) => leg.lineId).join()} style={styles.card}>
          <SlipSummary slip={item} /></View>)}
      </View>}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{book ? 'BETS WITH POSITIVE EV' : 'PICKS ABOVE BREAK-EVEN'}</Text>
        <Text style={styles.sectionDetail}>Each card shows GKR+&apos;s chance; its first lines say how Edge, history and GKR moved it.</Text>
        {picks.length ? picks.map((pick, index) => <EdgePickCard key={pick.key + pick.side} pick={pick} rank={index + 1} inSlip={inSlip.has(pick.lineId)} />)
          : <Notice title="Nothing qualifies right now" detail="No lines clear the bar after blending. No edge is a valid result." />}
      </View>
      <Pressable accessibilityRole="button" onPress={retry}><Text style={styles.link}>Refresh GKR+</Text></Pressable>
    </>}
  </Screen>;
}

/** Best entries from any upcoming game, or today's games only (an entry settles when its last game ends). */
function DayChips({ day, setDay }: { day: 'all' | 'today'; setDay: (day: 'all' | 'today') => void }) {
  return <View style={styles.chips}>{([['all', 'All days'], ['today', 'Today only']] as const).map(([value, label]) =>
    <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: day === value }} onPress={() => setDay(value)}
      style={[styles.chip, day === value && styles.chipOn]}>
      <Text style={[styles.chipText, day === value && styles.chipTextOn]}>{label}</Text></Pressable>)}</View>;
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
  section: { gap: 10, marginTop: 4 },
  sectionTitle: { color: palette.green, fontSize: 13, fontWeight: '900', letterSpacing: 1.4 },
  sectionDetail: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  card: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 18, padding: 16 },
  link: { color: palette.green, fontSize: 13, fontWeight: '800' },
  segments: { flexDirection: 'row', backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 14, padding: 3 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 11 },
  segmentOn: { backgroundColor: palette.greenDim },
  segmentText: { color: palette.muted, fontSize: 13, fontWeight: '800' },
  segmentTextOn: { color: palette.green },
});
