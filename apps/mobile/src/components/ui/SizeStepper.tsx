import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius } from '../../theme';
import { Icon } from './Icon';

/** A slip size the user types or steps, between min and max (Hard Rock up to 20, Kalshi up to 20). */
export function SizeStepper({ value, onChange, min = 2, max, label = 'Picks' }: { value: number; onChange: (value: number) => void;
  min?: number; max: number; label?: string }) {
  const [text, setText] = useState(String(value));
  const set = (next: number) => { const clamped = Math.max(min, Math.min(max, Math.round(next))); onChange(clamped); setText(String(clamped)); };
  return <View style={styles.row} accessibilityLabel={`${label}: ${value}`}>
    <Text style={styles.label}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Fewer" onPress={() => set(value - 1)} style={styles.button}
      disabled={value <= min}><Icon name="minus" size={20} color={value <= min ? colors.textFaint : colors.mint} /></Pressable>
    <TextInput value={text} onChangeText={(next) => { setText(next.replace(/[^0-9]/g, '')); const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed >= min && parsed <= max) onChange(parsed); }}
      onBlur={() => set(Number(text) || min)} keyboardType="number-pad" maxLength={2} style={styles.input}
      accessibilityLabel={`${label}, ${min} to ${max}`} />
    <Pressable accessibilityRole="button" accessibilityLabel="More" onPress={() => set(value + 1)} style={styles.button}
      disabled={value >= max}><Icon name="plus" size={20} color={value >= max ? colors.textFaint : colors.mint} /></Pressable>
    <Text style={styles.hint}>{min}–{max}</Text>
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg,
    paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.surface },
  label: { color: colors.text, fontSize: 15, fontWeight: '800', flex: 1 },
  button: { width: 44, height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center',
    justifyContent: 'center' },
  input: { width: 56, height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.mint, color: colors.text, fontSize: 20,
    fontWeight: '900', textAlign: 'center' },
  hint: { color: colors.textMuted, fontSize: 12 },
});
