import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatLine, marketAbbrev } from '../insights';
import { colors, radius } from '../theme';
import { useBoard } from '../use-board';
import { useDraft } from '../use-draft';
import { alpha } from './ui/color';
import { Icon } from './ui/Icon';
import { PlayerAvatar } from './ui/PlayerAvatar';

const shortName = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : name;
};

/** "Your Crown" bar: the draft's legs and a View Slip shortcut. Shown on the Board when the draft has legs. */
export function CrownTray() {
  const { legs, remove } = useDraft();
  const { data } = useBoard();
  if (!legs.length) return null;
  return <View style={styles.bar}>
    <View style={styles.label}>
      <Icon name="crown" size={30} color={colors.neon} />
      <View><Text style={styles.title}>Your</Text><Text style={styles.title}>Crown <Text style={styles.count}>
        {legs.length}/6</Text></Text></View>
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.legs}>
      {legs.map((leg) => <View key={leg.line.id} style={styles.leg}>
        <PlayerAvatar name={leg.line.playerName} photoUrl={data?.playerMedia?.[leg.line.playerId]?.photoUrl}
          size={38} ring={colors.borderStrong} />
        <View><Text style={styles.legName} numberOfLines={1}>{shortName(leg.line.playerName)}</Text>
          <Text style={styles.legLine}>{marketAbbrev(leg.line.market)} {formatLine(leg.line.threshold)}
            {leg.direction === 'MORE' ? '+' : '−'}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${leg.line.playerName}`} hitSlop={8}
          onPress={() => remove(leg.line.id)}><Icon name="close" size={18} color={colors.textMuted} /></Pressable>
      </View>)}
    </ScrollView>
    <Pressable accessibilityRole="button" accessibilityLabel="View Crown slip" style={styles.view}
      onPress={() => router.push('/(tabs)/crown')}>
      <Text style={styles.viewText}>View Slip</Text><Icon name="arrow-right" size={18} color={colors.mintInk} />
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface, borderTopWidth: 1.5,
    borderColor: alpha(colors.mint, 0.5), borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    paddingHorizontal: 12, paddingVertical: 10 },
  label: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: colors.text, fontSize: 14, fontWeight: '800', lineHeight: 17 },
  count: { color: colors.textMuted, fontWeight: '600' },
  legs: { gap: 8 },
  leg: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: colors.surfaceSunken },
  legName: { color: colors.text, fontSize: 13, fontWeight: '700', maxWidth: 96 },
  legLine: { color: colors.textMuted, fontSize: 12 },
  view: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.mint, borderRadius: radius.md,
    paddingHorizontal: 14, minHeight: 46 },
  viewText: { color: colors.mintInk, fontSize: 15, fontWeight: '900' },
});
