import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, View } from 'react-native';
import { colors, radius } from '../../theme';
import { alpha } from './color';

/** Dark card with a colored edge and a soft glow from its leading side. */
export function GlowCard({ accent = colors.mint, children, style, padded = true }: { accent?: string;
  children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  return <View style={[styles.card, { borderColor: alpha(accent, 0.55), shadowColor: accent }, style]}>
    <LinearGradient colors={[alpha(accent, 0.16), alpha(accent, 0.03), 'rgba(0,0,0,0)']}
      start={{ x: 0, y: 0 }} end={{ x: 0.9, y: 0.6 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
    <View style={padded ? styles.padded : undefined}>{children}</View>
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderWidth: 1.5, borderRadius: radius.lg, overflow: 'hidden',
    shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 0 }, elevation: 3 },
  padded: { padding: 14 },
});
