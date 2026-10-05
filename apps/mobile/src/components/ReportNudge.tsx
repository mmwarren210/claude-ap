import { router } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, radius } from '../theme';
import { Icon } from './ui/Icon';

// While CrownIQ is in beta: a short, light nudge to report bugs and ideas. Tapping it opens Beta feedback in More.

export const nudges = {
  board: 'See something off on the board? Snitch on the bug →',
  player: 'Numbers look funny? Even goblins make mistakes. Report it →',
  crown: 'Crown acting up? Tell us and we’ll fix it →',
  results: 'Got an idea or found a bug? We’re listening →',
} as const;

export function ReportNudge({ where }: { where: keyof typeof nudges }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="Report a bug or suggestion"
    onPress={() => router.push({ pathname: '/(tabs)/more', params: { feedback: '1' } })} style={styles.nudge}>
    <Icon name="bug-outline" size={18} color={colors.gold} />
    <Text style={styles.text}>{nudges[where]}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  nudge: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.gold,
    borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, marginVertical: 8 },
  text: { flex: 1, color: colors.gold, fontSize: 13, fontWeight: '700', lineHeight: 18 },
});
