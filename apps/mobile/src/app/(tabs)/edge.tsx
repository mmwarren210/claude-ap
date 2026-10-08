import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { EdgeBoardView } from '../../components/EdgeBoardView';
import { EdgeGenView } from '../../components/EdgeGenView';
import { EdgePickCard } from '../../components/EdgePickCard';
import { EdgeSlipPanel, SlipSummary, StakePicker } from '../../components/EdgeSlipPanel';
import { Notice, Screen } from '../../components/Screen';
import { PlayerSearch } from '../../components/PlayerSearch';
import { pct, sportsFrom, upcomingPicks } from '../../edge-format';
import { useEdgeSlip } from '../../edge-slip';
import { palette, rankAccents } from '../../theme';
import { useBoard } from '../../use-board';
import { useEdge } from '../../use-edge';
import { EdgeAlerts } from '../../components/EdgeAlerts';
import { EdgeRecord } from '../../components/EdgeRecord';
import { edgePlatform, EDGE_PLATFORMS, isBook, platformLabel, useEdgePlatform } from '../../edge-platform';
import type { EdgeView } from '../../use-edge';

const views: { key: EdgeView; label: string }[] = [
  { key: 'edges', label: 'Best edges' }, { key: 'alternates', label: 'Goblins & Demons' },
];
type Section = 'top' | 'board' | 'gen' | 'record';
const sections: { key: Section; label: string }[] = [
  { key: 'top', label: 'Top Picks' }, { key: 'board', label: 'Board' }, { key: 'gen', label: 'Gen' }, { key: 'record', label: 'Record' },
];

export default function EdgeScreen() {
  const [section, setSection] = useState<Section>('top');
  const [chosenView, setView] = useState<EdgeView>('edges');
  const platform = useEdgePlatform(), book = isBook(platform);
  // Goblins and Demons are PrizePicks only.
  const view: EdgeView = platform === 'prizepicks' ? chosenView : 'edges';
  const [sport, setSport] = useState<string | null>(null);
  const [day, setDay] = useState<'all' | 'today'>('all');
  const [query, setQuery] = useState('');
  const searching = query.trim().length >= 2;
  const { status, data, message, retry } = useEdge(view, 'edge', day, query, sport);
  const slip = useEdgeSlip();
  const { nowMs } = useBoard();
  const live = upcomingPicks(data?.picks ?? [], nowMs, day);
  const sports = sportsFrom(live);
  const picks = live.filter((pick) => !sport || pick.sport === sport).slice(0, 100);
  const inSlip = new Set(slip.map((leg) => leg.lineId));
  return <Screen eyebrow={`CROWNIQ  /  EDGE  /  ${platformLabel(platform).toUpperCase()}`} title="Edge">
    <Text style={styles.intro}>CrownIQ&apos;s own probability engine. It reads every line on each app and book, sets its own line, and picks the side that beats that platform&apos;s payout. Lines it can&apos;t read say exactly what&apos;s missing.</Text>
    <View style={styles.chips}>{EDGE_PLATFORMS.map((item) => <Pressable key={item.value} accessibilityRole="button"
      accessibilityState={{ selected: platform === item.value }} onPress={() => { edgePlatform.set(item.value); setSport(null); }}
      style={[styles.chip, platform === item.value && styles.chipOn]}>
      <Text style={[styles.chipText, platform === item.value && styles.chipTextOn]}>{item.label}</Text></Pressable>)}</View>
    <View style={styles.segments}>{sections.map((item) => <Pressable key={item.key} accessibilityRole="tab"
      accessibilityState={{ selected: section === item.key }} onPress={() => setSection(item.key)}
      style={[styles.segment, section === item.key && styles.segmentOn]}>
      <Text style={[styles.segmentText, section === item.key && styles.segmentTextOn]}>{item.label}</Text></Pressable>)}</View>
    {section === 'record' ? <EdgeRecord /> : section === 'board' ? <><EdgeSlipPanel entries={data?.entries ?? []} /><EdgeBoardView /></>
      : section === 'gen' ? data ? <><EdgeGenView entries={data.entries} sports={sports} nowMs={nowMs} starts={live.map((pick) => pick.eventStartTime)} /><EdgeSlipPanel entries={data.entries} /></>
        : <Notice title={status === 'loading' ? 'Pricing the board' : 'Edge pending'} detail={message || 'Reading the saved board.'} />
      : <>
    {platform === 'prizepicks' && <View style={styles.chips}>{views.map((item) => <Pressable key={item.key} accessibilityRole="button"
      onPress={() => setView(item.key)} style={[styles.chip, view === item.key && styles.chipOn]}>
      <Text style={[styles.chipText, view === item.key && styles.chipTextOn]}>{item.label}</Text></Pressable>)}</View>}
    <PlayerSearch onSearch={setQuery} />
    {!data ? <>
      <Notice title={status === 'loading' ? 'Pricing the board' : 'Edge pending'}
        detail={message || 'Reading the saved board and sportsbook prices.'} />
      <Pressable accessibilityRole="button" onPress={retry}><Text style={styles.link}>Retry</Text></Pressable>
    </> : <>
      {!!data.feedNote && <Notice title="Feed down" detail={data.feedNote} />}
      <View style={styles.stats}>
        <Stat label="Priced" value={String(data.counts.linesPriced)} />
        <Stat label="+EV lines" value={String(data.counts.positiveEdge)} />
        <Stat label="Sharp-priced" value={String(data.counts.sharp)} />
        {!book && <Stat label="Break-even" value={pct(data.referenceEntry.breakEven)} />}
      </View>
      <Text style={styles.meta}>{book ? 'Each bet is held against its own odds (it needs 1 ÷ the odds to break even), priced from the other books.'
        : `Break-even is the ${data.referenceEntry.size}-pick ${data.referenceEntry.type.toLowerCase()} entry${platform === 'prizepicks' ? '' : ', divided by each pick’s own multiplier'}.`}
        {' '}{data.calibration.status === 'CALIBRATED' ? `Calibrated on ${data.calibration.graded} graded picks.`
          : `Uncalibrated: ${data.calibration.graded} graded picks so far (calibration starts at 150).`}
        {data.counts.quotes === 0 ? ' No sportsbook prices on this board yet; picks are model/ladder only.' : ''}</Text>
      <DayChips day={day} setDay={setDay} />
      {sports.length > 1 && <View style={styles.chips}>
        {[null, ...sports].map((item) => <Pressable key={item ?? 'all'} accessibilityRole="button"
          onPress={() => setSport(item)} style={[styles.chip, sport === item && styles.chipOn]}>
          <Text style={[styles.chipText, sport === item && styles.chipTextOn]}>{item ?? 'All'}</Text></Pressable>)}
      </View>}
      <EdgeAlerts platform={platform} />
      <EdgeSlipPanel entries={data.entries} />
      {view === 'edges' && !searching && <View style={styles.section}>
        <Text style={styles.sectionTitle}>BEST ENTRIES</Text>
        <Text style={styles.sectionDetail}>Highest expected value using the strongest legs, one per player and at most two per game.</Text>
        {!data.slips.length && <Text style={styles.sectionDetail}>{`No ${sport ? `${sport} ` : ''}entry clears the bar${day === 'today' ? ' with today’s games alone' : ' right now'}.`}</Text>}
        <StakePicker />
        {data.slips.slice(0, 2).map((item) => <View key={item.entry.type + item.entry.size + item.legs.map((leg) => leg.lineId).join()} style={styles.card}>
          <SlipSummary slip={item} /></View>)}
      </View>}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{searching ? `SEARCH · ${picks.length} LINE${picks.length === 1 ? '' : 'S'}` : view === 'edges' ? book ? 'BETS WITH POSITIVE EV' : 'PICKS ABOVE BREAK-EVEN' : 'ALTERNATE LINES BY HIT PROBABILITY'}</Text>
        <Text style={styles.sectionDetail}>{searching ? 'Every upcoming line Edge read for that player on this platform, plays or not; the strongest edge first.' : view === 'edges'
          ? book ? 'Every rung the book posts, held against its own odds. Stake shown is a quarter-Kelly share of your bankroll, capped at 2%.'
            : platform === 'pick6' ? 'DK Pick’em publishes no payout chart, so Edge shows each pick’s chance; edges appear once the payouts are confirmed.'
            : 'Picks whose hit probability beats the break-even. Edge is shown in percentage points.'
          : 'No source gives PrizePicks’ Goblin/Demon payout factors, so Edge shows each leg’s hit chance and the minimum payout factor that makes it worth it.'}</Text>
        {picks.length ? picks.map((pick, index) => <EdgePickCard key={pick.key + pick.side} pick={pick} accent={rankAccents[index % rankAccents.length]}
          rank={view === 'edges' && !searching ? index + 1 : undefined} inSlip={inSlip.has(pick.lineId)} />)
          : searching ? <Notice title="No lines found" detail={`No upcoming line on ${platformLabel(platform)} for “${query.trim()}”.`} />
          : <Notice title="Nothing qualifies right now" detail="No lines clear the bar on the saved board. No edge is a valid result." />}
      </View>
      <Pressable accessibilityRole="button" onPress={retry}><Text style={styles.link}>Refresh Edge</Text></Pressable>
    </>}
    </>}
  </Screen>;
}

/** The whole page (picks and best entries) from any upcoming game, or today's games only (Eastern). */
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
  meta: { color: palette.muted, fontSize: 11, lineHeight: 16 },
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
