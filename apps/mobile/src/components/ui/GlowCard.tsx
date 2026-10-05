import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, View } from 'react-native';
import { colors, radius } from '../../theme';
import { alpha } from './color';

/** Dark card with a bright colored edge, a glow around it and a wash of its color from the leading side. */
export function GlowCard({ accent = colors.mint, children, style, padded = true }: { accent?: string;
  children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  return <View style={[styles.card, { borderColor: alpha(accent, 0.9), shadowColor: accent }, style]}>
    <LinearGradient colors={[alpha(accent, 0.28), alpha(accent, 0.07), 'rgba(0,0,0,0)']}
      start={{ x: 0, y: 0 }} end={{ x: 1, y: 0.75 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
    <View style={padded ? styles.padded : undefined}>{children}</View>
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderWidth: 2, borderRadius: radius.lg, overflow: 'hidden',
    shadowOpacity: 0.75, shadowRadius: 18, shadowOffset: { width: 0, height: 0 }, elevation: 3 },
  padded: { padding: 14 },
});
