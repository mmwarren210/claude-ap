import type { Analysis } from '@crowniq/contracts';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../../theme';

const grades: Readonly<Record<Analysis['evidenceQuality'], { letter: string; title: string; color: string }>> = {
  HIGH: { letter: 'A', title: 'Strong evidence', color: colors.mint },
  MEDIUM: { letter: 'B', title: 'Good evidence', color: colors.blue },
  LOW: { letter: 'C', title: 'Thin evidence', color: colors.amber },
  NONE: { letter: '—', title: 'No evidence', color: colors.textFaint },
};

/** Letter grade for the attributed evidence behind a line. */
export function EvidenceBadge({ quality, detail }: { quality: Analysis['evidenceQuality']; detail?: string }) {
  const grade = grades[quality];
  return <View style={styles.row} accessibilityLabel={`${grade.title}${detail ? ', ' + detail : ''}`}>
    <View style={[styles.letter, { backgroundColor: grade.color }]}>
      <Text style={styles.letterText}>{grade.letter}</Text></View>
    <View style={styles.copy}>
      <Text style={styles.title} numberOfLines={1}>{grade.title}</Text>
      {detail ? <Text style={styles.detail} numberOfLines={1}>{detail}</Text> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 },
  letter: { width: 34, height: 34, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  letterText: { color: colors.mintInk, fontSize: 17, fontWeight: '900' },
  copy: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 14, fontWeight: '700' },
  detail: { color: colors.textMuted, fontSize: 12 },
});
