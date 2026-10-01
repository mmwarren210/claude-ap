import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme';

export type Stat = { label: string; value: string; tone?: 'good' | 'bad' | 'plain'; suffix?: string };

/** Row of labelled numbers separated by thin dividers, like L5 · L10 · AVG · vs OPP. */
export function StatStrip({ stats }: { stats: readonly Stat[] }) {
  return <View style={styles.row}>
    {stats.map((stat, index) => <View key={stat.label} style={[styles.cell, index > 0 && styles.divider]}>
      <Text style={styles.label} numberOfLines={1}>{stat.label}</Text>
      <Text style={[styles.value, stat.tone === 'good' && styles.good, stat.tone === 'bad' && styles.bad]}
        numberOfLines={1}>{stat.value}{stat.suffix ? <Text style={styles.suffix}> {stat.suffix}</Text> : null}</Text>
    </View>)}
  </View>;
}

/** Hit rates of 60% or more read as good, under 40% as bad. */
export function rateTone(rate: number | null | undefined): Stat['tone'] {
  if (rate === null || rate === undefined) return 'plain';
  return rate >= 0.6 ? 'good' : rate < 0.4 ? 'bad' : 'plain';
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', paddingVertical: 4, gap: 2, minWidth: 0 },
  divider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.borderStrong },
  label: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  value: { color: colors.text, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  good: { color: colors.mint },
  bad: { color: colors.red },
  suffix: { fontSize: 12 },
});
