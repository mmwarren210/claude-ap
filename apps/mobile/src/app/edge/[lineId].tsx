import { edgePickSchema } from '@crowniq/contracts';
import type { EdgePick } from '@crowniq/contracts';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../auth';
import { Notice, Screen } from '../../components/Screen';
import { edgeSummary, formatLine, headline, pct, ratingLabel, signedPoints, tierLabel } from '../../edge-format';
import { edgeSlip, useEdgeSlip } from '../../edge-slip';
import { palette } from '../../theme';
import { PlayerAvatar } from '../../components/ui/PlayerAvatar';

const bookNames: Record<string, string> = { pinnacle: 'Pinnacle', fanduel: 'FanDuel', draftkings: 'DraftKings',
  betmgm: 'BetMGM', williamhill_us: 'Caesars', espnbet: 'ESPN BET', betonlineag: 'BetOnline', betrivers: 'BetRivers',
  hardrockbet: 'Hard Rock', hardrock: 'Hard Rock', novig: 'Novig' };
const american = (decimal: number | null) => decimal === null ? '—'
  : decimal >= 2 ? '+' + Math.round((decimal - 1) * 100) : String(Math.round(-100 / (decimal - 1)));

export default function EdgeDetail() {
  const { request } = useAuth();
  const { lineId, platform } = useLocalSearchParams<{ lineId: string; platform?: string }>();
  const [state, setState] = useState<{ id: string; pick: EdgePick | null; message: string; distribution?: Point[]; movement?: Movement[] } | null>(null);
  const slip = useEdgeSlip();
  useEffect(() => {
    let active = true;
    void request('/v1/edge/line/' + encodeURIComponent(lineId) + (platform ? `?platform=${encodeURIComponent(platform)}` : '')).then(async (response) => {
      if (!active) return;
      if (!response.ok) { setState({ id: lineId, pick: null, message: response.status === 404
        ? (await response.json().catch(() => null) as { note?: string } | null)?.note ?? 'Edge has no read for this line.' : 'Could not load this line.' }); return; }
      const body = await response.json() as { pick: unknown; distribution?: Point[]; movement?: Movement[] };
      setState({ id: lineId, pick: edgePickSchema.parse(body.pick), message: '', distribution: body.distribution ?? [], movement: body.movement ?? [] });
    }).catch(() => { if (active) setState({ id: lineId, pick: null, message: 'Could not load this line.' }); });
    return () => { active = false; };
  }, [lineId, platform, request]);
  const current = state?.id === lineId ? state : null;
  const pick = current?.pick;
  if (!pick) return <Screen eyebrow="EDGE" title="Line detail">
    <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.link}>← Back</Text></Pressable>
    <Notice title={current ? 'Unavailable' : 'Loading'} detail={current?.message || 'Reading the saved Edge price.'} />
  </Screen>;
  const inSlip = slip.some((leg) => leg.lineId === pick.lineId);
  const { market, stats, ladder } = pick.sources;
  return <Screen eyebrow={`EDGE  /  ${pick.sport}  /  ${tierLabel[pick.tier]}`} title={pick.playerName}>
    <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.link}>← Back</Text></Pressable>
    <View style={styles.hero}>
      <PlayerAvatar name={pick.playerName} photoUrl={pick.playerImageUrl} size={84} />
      <Text style={styles.line}>{headline(pick)}{pick.lineType !== 'REGULAR' ? ` · ${pick.lineType}` : ''}</Text>
      <Text style={styles.big}>{pct(pick.probability)}</Text>
      <Text style={styles.text}>{edgeSummary(pick)}</Text>
      {pick.edge !== null && <Text style={styles.rating}>{ratingLabel[pick.rating]} · {signedPoints(pick.edge)} pts · score {pick.edgeScore}</Text>}
      <Text style={styles.muted}>{pick.eventName} · {new Date(pick.eventStartTime).toLocaleString()}</Text>
      {pick.pushProbability > 0 && <Text style={styles.muted}>Exact-line (removed pick) chance {pct(pick.pushProbability)}</Text>}
      <Pressable accessibilityRole="button" onPress={() => edgeSlip.toggle(pick)} style={[styles.button, inSlip && styles.buttonOn]}>
        <Text style={styles.link}>{inSlip ? '✓ In slip (tap to remove)' : '+ Add to slip'}</Text></Pressable>
    </View>
    <Section title="WHY">{pick.reasons.map((reason) => <Text key={reason} style={styles.text}>• {reason}</Text>)}</Section>
    {pick.warnings.length > 0 && <Section title="GOOD TO KNOW">{pick.warnings.map((warning) =>
      <Text key={warning} style={styles.muted}>• {warning}</Text>)}</Section>}
    <Section title="PROJECTION">
      {current?.distribution?.length ? <DistributionChart points={current.distribution} threshold={pick.threshold} side={pick.side} /> : null}
      <Text style={styles.text}>Mean {formatLine(pick.projection.mean)} · median {formatLine(pick.projection.median)} · SD {formatLine(pick.projection.sd)}</Text>
      <Text style={styles.muted}>{pick.projection.family === 'NORMAL' ? 'Normal' : pick.projection.family === 'POISSON' ? 'Poisson' : 'Negative binomial'} distribution, widened for estimate uncertainty.</Text>
    </Section>
    {pick.elsewhere && pick.elsewhere.length > 0 && <Section title="EVERY PLATFORM'S NUMBER">
      {[{ platform: pick.platform, threshold: pick.threshold, side: pick.side, probability: pick.probability, payoutMultiplier: pick.payoutMultiplier, ev: pick.ev, own: true },
        ...pick.elsewhere.map((item) => ({ ...item, own: false }))].sort((a, b) => a.threshold - b.threshold).map((item) =>
        <View key={item.platform + item.threshold + item.side} style={styles.bookRow}>
          <Text style={[styles.text, styles.bookName, item.own && styles.own]}>{platformNames[item.platform] ?? item.platform}{item.own ? ' (this line)' : ''}</Text>
          <Text style={styles.text}>{item.side === 'MORE' ? 'O' : 'U'} {formatLine(item.threshold)}</Text>
          <Text style={styles.muted}>{item.payoutMultiplier && item.payoutMultiplier !== 1 ? `${item.payoutMultiplier}×` : item.ev !== undefined ? `EV ${item.ev >= 0 ? '+' : ''}${(item.ev * 100).toFixed(1)}%` : ''}</Text>
          <Text style={styles.text}>{pct(item.probability, 0)}</Text>
        </View>)}
    </Section>}
    {current?.movement && current.movement.some((item) => item.points.length > 1) && <Section title="MOVEMENT · LAST 24 HOURS">
      {current.movement.filter((item) => item.points.length > 1).map((item) => <Sparkline key={item.platform} label={platformNames[item.platform] ?? bookNames[item.platform] ?? item.platform} points={item.points} />)}
      <Text style={styles.muted}>Each platform&apos;s number when it changed (snapshot store).</Text>
    </Section>}
    {market && <Section title={`SPORTSBOOKS · ${pct(market.weight, 0)} WEIGHT`}>
      <Text style={styles.muted}>Fair probabilities remove each book&apos;s margin (power method).</Text>
      {market.books.map((book) => <View key={book.bookmaker + book.point} style={styles.bookRow}>
        <Text style={[styles.text, styles.bookName]}>{bookNames[book.bookmaker] ?? book.bookmaker}</Text>
        <Text style={styles.text}>{formatLine(book.point)}</Text>
        <Text style={styles.muted}>O {american(book.overPrice)} / U {american(book.underPrice)}</Text>
        <Text style={styles.text}>{pct(book.fairOver, 0)} O</Text>
      </View>)}
      <Text style={styles.muted}>Market-implied mean {formatLine(market.mean)}</Text>
    </Section>}
    {stats && <Section title={`STATS MODEL · ${pct(stats.weight, 0)} WEIGHT`}>
      <Text style={styles.text}>Projection {formatLine(stats.mean)} from {stats.samples} games</Text>
      <Text style={styles.muted}>Last 5 avg {formatLine(stats.recentMean)} · sample avg {formatLine(stats.seasonMean)}
        {stats.hitRateAtLine !== null ? ` · ${pick.side} hit ${pct(stats.hitRateAtLine, 0)} of games` : ''}</Text>
    </Section>}
    {ladder && <Section title={`REGULAR-LINE LADDER · ${pct(ladder.weight, 0)} WEIGHT`}>
      <Text style={styles.text}>Regular line {formatLine(ladder.regularThreshold)} treated as a 50/50 anchor</Text>
    </Section>}
    <Text style={styles.muted}>Model {pick.modelVersion}{pick.calibrated ? ' · calibrated on graded results' : ' · not yet calibrated'}. Probabilities are estimates; confirm the line is still offered.</Text>
  </Screen>;
}

type Point = { x: number; p: number };
type Movement = { platform: string; points: { t: string; number: number }[] };
const platformNames: Record<string, string> = { prizepicks: 'PrizePicks', prizepicks_flex: 'PrizePicks', underdog: 'Underdog', pick6: 'Pick6', dabble: 'Dabble',
  draftkings: 'DraftKings', hardrock: 'Hard Rock', fanduel: 'FanDuel', betrivers: 'BetRivers' };

/** The fair distribution as bars, with the pick's side shaded and the line marked. */
function DistributionChart({ points, threshold, side }: { points: Point[]; threshold: number; side: 'MORE' | 'LESS' }) {
  const max = Math.max(...points.map((point) => point.p), 1e-6);
  return <View>
    <View style={styles.chart}>{points.map((point) => {
      const winning = side === 'MORE' ? point.x > threshold : point.x < threshold;
      return <View key={point.x} style={styles.chartColumn}>
        <View style={[styles.chartBar, { height: `${Math.max(2, point.p / max * 100)}%`, backgroundColor: winning ? palette.green : palette.border }]} />
      </View>;
    })}</View>
    <View style={styles.chartAxis}><Text style={styles.muted}>{points[0]!.x}</Text>
      <Text style={styles.muted}>line {formatLine(threshold)} · green = {side === 'MORE' ? 'over' : 'under'} wins</Text>
      <Text style={styles.muted}>{points[points.length - 1]!.x}</Text></View>
  </View>;
}

function Sparkline({ label, points }: { label: string; points: { t: string; number: number }[] }) {
  const values = points.map((point) => point.number), low = Math.min(...values), high = Math.max(...values), span = high - low || 1;
  const first = values[0]!, last = values[values.length - 1]!;
  return <View style={styles.sparkRow}>
    <Text style={[styles.text, styles.sparkLabel]}>{label}</Text>
    <View style={styles.spark}>{values.map((value, index) =>
      <View key={index} style={[styles.sparkBar, { height: `${20 + (value - low) / span * 80}%` }]} />)}</View>
    <Text style={styles.muted}>{formatLine(first)} → {formatLine(last)}</Text>
  </View>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

const styles = StyleSheet.create({
  link: { color: palette.green, fontSize: 13, fontWeight: '800' },
  hero: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 20, padding: 18, gap: 6 },
  line: { color: palette.text, fontSize: 16, fontWeight: '800' },
  big: { color: palette.green, fontSize: 44, fontWeight: '900', letterSpacing: -1.5 },
  rating: { color: palette.green, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  text: { color: palette.text, fontSize: 13, lineHeight: 19 },
  muted: { color: palette.muted, fontSize: 12, lineHeight: 17 },
  warning: { color: palette.danger, fontSize: 12, lineHeight: 17 },
  button: { alignSelf: 'flex-start', borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7, marginTop: 4 },
  buttonOn: { backgroundColor: palette.greenDim, borderColor: palette.green },
  section: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 18, padding: 16, gap: 6 },
  sectionTitle: { color: palette.green, fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  bookRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  bookName: { flex: 1 },
  own: { color: palette.green, fontWeight: '800' },
  chart: { flexDirection: 'row', alignItems: 'flex-end', height: 90, gap: 1 },
  chartColumn: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  chartBar: { borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  chartAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  sparkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sparkLabel: { width: 90 },
  spark: { flex: 1, height: 24, flexDirection: 'row', alignItems: 'flex-end', gap: 1 },
  sparkBar: { flex: 1, backgroundColor: palette.green, opacity: .6, borderRadius: 1 },
});
