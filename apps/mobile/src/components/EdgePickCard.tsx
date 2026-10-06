import type { EdgePick } from '@crowniq/contracts';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { edgeSummary, elsewhereText, headline, lineComparison, moveBadges, pct, ratingColor, ratingLabel, tierLabel } from '../edge-format';
import { edgeSlip } from '../edge-slip';
import { palette } from '../theme';

export function EdgePickCard({ pick, rank, inSlip }: { pick: EdgePick; rank?: number; inSlip: boolean }) {
  const color = ratingColor(pick.rating, palette);
  const start = new Date(pick.eventStartTime);
  return <View style={styles.card}><Pressable accessibilityRole="button" accessibilityLabel={`Edge detail for ${pick.playerName}`}
    onPress={() => router.push({ pathname: '/edge/[lineId]', params: { lineId: pick.lineId, platform: pick.platform } })} style={styles.body}>
    <View style={styles.row}>
      <Text style={styles.eyebrow}>{rank ? `#${rank} · ` : ''}{pick.sport} · {tierLabel[pick.tier]}
        {pick.lineType !== 'REGULAR' ? ` · ${pick.lineType === 'UNKNOWN_ALTERNATE' ? 'ALT' : pick.lineType}` : ''}</Text>
      <View style={styles.badges}>
        {moveBadges(pick).map((badge) => <Text key={badge} style={[styles.badge, styles.move]}>{badge}</Text>)}
        {pick.edge !== null && <Text style={[styles.badge, { color, borderColor: color }]}>{ratingLabel[pick.rating]}</Text>}
      </View>
    </View>
    <View style={styles.row}>
      <View style={styles.main}>
        <Text style={styles.name}>{pick.playerName}</Text>
        <Text style={styles.line}>{headline(pick)}</Text>
        <Text style={styles.detail}>{pick.eventName} · {start.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</Text>
      </View>
      <View style={styles.probability}>
        <Text style={[styles.big, { color: pick.edge !== null ? color : palette.text }]}>{pct(pick.probability, 0)}</Text>
        <Text style={styles.small}>to hit</Text>
      </View>
    </View>
    <Text style={styles.summary}>{edgeSummary(pick)}</Text>
    <Text style={styles.edgeLine}>{lineComparison(pick)}</Text>
    {!!pick.stale && <Text style={styles.stale}>{pick.reasons[0]}</Text>}
    {!!elsewhereText(pick) && <Text style={styles.detail}>{elsewhereText(pick)}</Text>}
    {!!pick.injury && <Text style={styles.detail}>Injury report: {pick.injury}</Text>}
    </Pressable>
    <Pressable accessibilityRole="button" onPress={() => edgeSlip.toggle(pick)} style={[styles.slip, inSlip && styles.slipOn]}>
      <Text style={[styles.slipText, inSlip && styles.slipTextOn]}>{inSlip ? '✓ In slip' : '+ Add to slip'}</Text>
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 18, padding: 16, gap: 8 },
  body: { gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  main: { flex: 1, gap: 3 },
  eyebrow: { color: palette.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1, flexShrink: 1 },
  badge: { fontSize: 9, fontWeight: '900', letterSpacing: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  name: { color: palette.text, fontSize: 18, fontWeight: '800' },
  line: { color: palette.text, fontSize: 14, fontWeight: '700' },
  detail: { color: palette.muted, fontSize: 12 },
  probability: { alignItems: 'flex-end', minWidth: 64 },
  big: { fontSize: 28, fontWeight: '900', letterSpacing: -1 },
  small: { color: palette.muted, fontSize: 10, fontWeight: '700' },
  summary: { color: palette.text, fontSize: 12 },
  edgeLine: { color: palette.green, fontSize: 12, fontWeight: '800' },
  badges: { flexDirection: 'row', gap: 4 },
  move: { color: '#F2B84B', borderColor: '#F2B84B' },
  stale: { color: '#F2B84B', fontSize: 12, fontWeight: '700' },
  warning: { color: palette.danger, fontSize: 11 },
  slip: { alignSelf: 'flex-start', borderWidth: 1, borderColor: palette.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, marginTop: 2 },
  slipOn: { backgroundColor: palette.greenDim, borderColor: palette.green },
  slipText: { color: palette.muted, fontSize: 12, fontWeight: '800' },
  slipTextOn: { color: palette.green },
});
