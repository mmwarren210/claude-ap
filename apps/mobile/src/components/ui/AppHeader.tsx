import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../auth';
import { useOptionalBoard } from '../../use-board';
import { colors, radius } from '../../theme';
import { alpha } from './color';
import { Icon } from './Icon';

export function CrownLogo({ size = 40 }: { size?: number }) {
  // Native shadows follow the glyph; on web a box shadow would draw a square, so skip it there.
  return <View style={Platform.OS === 'web' ? undefined
    : { shadowColor: colors.neon, shadowOpacity: 0.7, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } }}>
    <Icon name="crown-outline" size={size} color={colors.neon} />
  </View>;
}

/** Brand header: crown, CrownIQ wordmark, a screen subtitle, and the profile button. */
export function AppHeader({ subtitle, back = false, right }: { subtitle: string; back?: boolean; right?: ReactNode }) {
  const { profile, demo, logout } = useAuth();
  const liveDemo = useOptionalBoard()?.freshness === 'DEMO_LIVE';
  const initial = (profile?.username ?? 'C').slice(0, 1).toUpperCase();
  return <View>
  <View style={styles.row}>
    {back && <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}
      onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)')} style={styles.back}>
      <Icon name="arrow-left" size={26} color={colors.mint} /></Pressable>}
    <CrownLogo size={back ? 34 : 42} />
    <View style={styles.brand}>
      <Text style={[styles.word, back && styles.wordSmall]} numberOfLines={1}>Crown<Text style={styles.iq}>IQ</Text></Text>
      <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text>
    </View>
    {right ?? <View style={styles.tagline} accessibilityLabel="Smarter bets, bigger wins">
      <Icon name="crown" size={22} color={colors.neon} />
      <Text style={styles.taglineText}>Smarter Bets{'\n'}Bigger Wins</Text>
    </View>}
    <Pressable accessibilityRole="button" accessibilityLabel="Account and settings" hitSlop={6}
      onPress={() => router.push('/(tabs)/more')} style={styles.avatar}>
      <Text style={styles.avatarText}>{initial}</Text>
    </Pressable>
  </View>
  {demo && <View style={styles.demo} accessibilityRole="summary">
    <Icon name="flask-outline" size={16} color={colors.gold} />
    <Text style={styles.demoText}>{liveDemo ? 'Demo · real PrizePicks lines, sample account' : 'Demo · sample data, not real picks'}</Text>
    <Pressable accessibilityRole="button" onPress={() => void logout()} hitSlop={8}>
      <Text style={styles.demoLink}>Sign in</Text></Pressable>
  </View>}
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 6, paddingBottom: 14 },
  back: { marginRight: -2 },
  brand: { flex: 1, minWidth: 0 },
  word: { color: colors.text, fontSize: 32, fontWeight: '900', letterSpacing: -0.8, lineHeight: 36 },
  wordSmall: { fontSize: 27, lineHeight: 31 },
  iq: { color: colors.neon },
  subtitle: { color: colors.textMuted, fontSize: 13, fontWeight: '500', marginTop: -1, lineHeight: 17 },
  tagline: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.borderStrong,
    backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: 9, paddingVertical: 6 },
  taglineText: { color: colors.text, fontSize: 10.5, fontWeight: '600', lineHeight: 13 },
  avatar: { width: 42, height: 42, borderRadius: 21, borderWidth: 2, borderColor: colors.mint,
    alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(colors.mint, 0.08) },
  avatarText: { color: colors.text, fontSize: 18, fontWeight: '700' },
  demo: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: alpha(colors.gold, 0.4),
    backgroundColor: alpha(colors.gold, 0.08), borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8,
    marginBottom: 12 },
  demoText: { color: colors.text, fontSize: 13, fontWeight: '600', flex: 1 },
  demoLink: { color: colors.gold, fontSize: 13, fontWeight: '800' },
});
