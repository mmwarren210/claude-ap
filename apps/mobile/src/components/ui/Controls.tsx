import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../../theme';
import { alpha } from './color';
import type { IconName } from './Icon';
import { Icon } from './Icon';

export function PrimaryButton({ label, onPress, icon, disabled, style, subtitle }: { label: string;
  onPress: () => void; icon?: IconName; disabled?: boolean; style?: StyleProp<ViewStyle>; subtitle?: string }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.primaryWrap, style, (pressed || disabled) && styles.dim]}>
    <LinearGradient colors={[colors.mint, colors.mintDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      style={styles.primary}>
      {icon && <Icon name={icon} size={20} color={colors.mintInk} />}
      <View><Text style={styles.primaryText}>{label}</Text>
        {subtitle ? <Text style={styles.primarySub}>{subtitle}</Text> : null}</View>
    </LinearGradient>
  </Pressable>;
}

export function GhostButton({ label, onPress, icon, disabled, style, tone = colors.mint }: { label: string;
  onPress: () => void; icon?: IconName; disabled?: boolean; style?: StyleProp<ViewStyle>; tone?: string }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.ghost, { borderColor: alpha(tone, 0.6) }, style,
      (pressed || disabled) && styles.dim]}>
    {icon && <Icon name={icon} size={18} color={tone} />}
    <Text style={[styles.ghostText, { color: tone }]}>{label}</Text>
  </Pressable>;
}

/** Dropdown-style filter chip: label, current value and a chevron. */
export function FilterChip({ label, active, onPress, icon, chevron = true }: { label: string; active?: boolean;
  onPress: () => void; icon?: IconName; chevron?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: !!active }} onPress={onPress}
    style={[styles.chip, active && styles.chipActive]}>
    {icon && <Icon name={icon} size={16} color={active ? colors.mint : colors.textMuted} />}
    <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>{label}</Text>
    {chevron && <Icon name="chevron-down" size={16} color={active ? colors.mint : colors.textMuted} />}
  </Pressable>;
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
    {children}</ScrollView>;
}

/** Single-choice segmented control (Top 2 … Top 6, L5 … Avg). */
export function Segmented<T extends string | number>({ options, value, onChange, label }: {
  options: readonly { value: T; label: string }[]; value: T; onChange: (value: T) => void; label: string }) {
  return <View style={styles.segmented} accessibilityLabel={label}>
    {options.map((option) => {
      const selected = option.value === value;
      return <Pressable key={String(option.value)} accessibilityRole="button" accessibilityState={{ selected }}
        onPress={() => onChange(option.value)} style={[styles.segment, selected && styles.segmentActive]}>
        <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  dim: { opacity: 0.6 },
  primaryWrap: { borderRadius: radius.md, overflow: 'hidden', shadowColor: colors.mint, shadowOpacity: 0.35,
    shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  primary: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingHorizontal: 16 },
  primaryText: { color: colors.mintInk, fontSize: 16, fontWeight: '900' },
  primarySub: { color: alpha(colors.mintInk, 0.75), fontSize: 11, fontWeight: '700' },
  ghost: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingHorizontal: 16, borderWidth: 1.5, borderRadius: radius.md, backgroundColor: colors.surfaceSunken },
  ghostText: { fontSize: 15, fontWeight: '800' },
  chipRow: { gap: 8, paddingRight: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 42, paddingHorizontal: 12,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface },
  chipActive: { borderColor: colors.mint, backgroundColor: colors.mintWash },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  chipTextActive: { color: colors.mint, fontWeight: '800' },
  segmented: { flexDirection: 'row', borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    backgroundColor: colors.surface, padding: 3 },
  segment: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm,
    borderWidth: 1.5, borderColor: 'transparent' },
  segmentActive: { borderColor: colors.mint, backgroundColor: colors.mintWash },
  segmentText: { color: colors.textMuted, fontSize: 14, fontWeight: '700' },
  segmentTextActive: { color: colors.mint, fontWeight: '900' },
});
