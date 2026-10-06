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

const bookNames: Record<string, string> = { pinnacle: 'Pinnacle', fanduel: 'FanDuel', draftkings: 'DraftKings',
  betmgm: 'BetMGM', williamhill_us: 'Caesars', espnbet: 'ESPN BET', betonlineag: 'BetOnline', betrivers: 'BetRivers',
  hardrockbet: 'Hard Rock', hardrock: 'Hard Rock', novig: 'Novig' };
const american = (decimal: number | null) => decimal === null ? '—'
  : decimal >= 2 ? '+' + Math.round((decimal - 1) * 100) : String(Math.round(-100 / (decimal - 1)));

export default function EdgeDetail() {
  const { request } = useAuth();
  const { lineId } = useLocalSearchParams<{ lineId: string }>();
  const [state, setState] = useState<{ id: string; pick: EdgePick | null; message: string } | null>(null);
  const slip = useEdgeSlip();
  useEffect(() => {
    let active = true;
    void request('/v1/edge/line/' + encodeURIComponent(lineId)).then(async (response) => {
      if (!active) return;
      if (!response.ok) { setState({ id: lineId, pick: null, message: response.status === 404
        ? (await response.json().catch(() => null) as { note?: string } | null)?.note ?? 'Edge has no read for this line.' : 'Could not load this line.' }); return; }
      setState({ id: lineId, pick: edgePickSchema.parse((await response.json()).pick), message: '' });
    }).catch(() => { if (active) setState({ id: lineId, pick: null, message: 'Could not load this line.' }); });
    return () => { active = false; };
  }, [lineId, request]);
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
    {pick.warnings.length > 0 && <Section title="CAUTION">{pick.warnings.map((warning) =>
      <Text key={warning} style={styles.warning}>⚠ {warning}</Text>)}</Section>}
    <Section title="PROJECTION">
      <Text style={styles.text}>Mean {formatLine(pick.projection.mean)} · median {formatLine(pick.projection.median)} · SD {formatLine(pick.projection.sd)}</Text>
      <Text style={styles.muted}>{pick.projection.family === 'NORMAL' ? 'Normal' : pick.projection.family === 'POISSON' ? 'Poisson' : 'Negative binomial'} distribution, widened for estimate uncertainty.</Text>
    </Section>
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
    {ladder && <Section title={`PRIZEPICKS LADDER · ${pct(ladder.weight, 0)} WEIGHT`}>
      <Text style={styles.text}>Regular line {formatLine(ladder.regularThreshold)} treated as a 50/50 anchor</Text>
    </Section>}
    <Text style={styles.muted}>Model {pick.modelVersion}{pick.calibrated ? ' · calibrated on graded results' : ' · not yet calibrated'}. Probabilities are estimates; confirm the line is still offered.</Text>
  </Screen>;
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
});
