import type { PropLine } from '@crowniq/contracts';
import { StyleSheet, Text, View } from 'react-native';
import { lineStyleOf, lineStyles, radius } from '../../theme';
import { alpha } from './color';
import { Icon } from './Icon';

export function LineBadge({ lineType, compact = false }: { lineType: PropLine['lineType']; compact?: boolean }) {
  const style = lineStyles[lineStyleOf(lineType)];
  return <View style={[styles.badge, { backgroundColor: alpha(style.color, 0.1), borderColor: alpha(style.color, 0.45) },
    compact && styles.compact]}>
    <Icon name={style.icon} size={compact ? 13 : 16} color={style.color} />
    <Text style={[styles.text, { color: style.color }, compact && styles.compactText]}>
      {compact ? style.short : style.label}</Text>
  </View>;
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: radius.sm,
    paddingHorizontal: 10, paddingVertical: 5, alignSelf: 'flex-start' },
  compact: { paddingHorizontal: 7, paddingVertical: 3, gap: 4 },
  text: { fontSize: 13, fontWeight: '700' },
  compactText: { fontSize: 11 },
});
