import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../../theme';

export type PickOption = { key: string; label: string; count?: number };

/** Adds or removes one value; picking every option is the same as "All" (none picked). */
export function toggleChoice(selected: readonly string[], key: string, total?: number): string[] {
  const next = selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key];
  return total !== undefined && next.length >= total ? [] : next;
}

/** A multi-select picker's value as the API's comma-separated list (undefined means everything). */
export const choiceParam = (selected: readonly string[]) => selected.length ? selected.join(',') : undefined;

/** Whether a value passes a multi-select (none picked passes everything). */
export const picked = (selected: readonly string[], value: string) => !selected.length || selected.includes(value);

/**
 * Multi-select chips used across the app (platform, sport, stat). Tap several to combine them; "All" clears the
 * choice. Long lists show the first `fold` options until "More" is tapped; picked options always stay visible.
 */
export function MultiPick({ label, allLabel = 'All', options, selected, onChange, fold = 12, labelFor = (key) => key }: { label?: string; allLabel?: string;
  labelFor?: (key: string) => string; options: readonly PickOption[]; selected: readonly string[]; onChange: (next: string[]) => void; fold?: number }) {
  const [open, setOpen] = useState(false);
  if (!options.length && !selected.length) return null;
  // A picked value no longer on the list (e.g. a stat from another sport) stays as a chip so it can be cleared.
  const all: PickOption[] = [...options, ...selected.filter((key) => !options.some((option) => option.key === key)).map((key) => ({ key, label: labelFor(key) }))];
  const shown = open || all.length <= fold + 2 ? all : all.filter((option, index) => index < fold || selected.includes(option.key));
  const chip = (key: string, text: string, active: boolean, onPress: () => void) => <Pressable key={key} accessibilityRole="button"
    accessibilityState={{ selected: active }} onPress={onPress} style={[styles.chip, active && styles.active]}>
    <Text style={[styles.text, active && styles.activeText]} numberOfLines={1}>{active && key !== '__all' ? '✓ ' : ''}{text}</Text></Pressable>;
  return <View style={styles.wrap}>
    {!!label && <Text style={styles.label}>{label}{selected.length > 1 ? ` · ${selected.length} picked` : ''}</Text>}
    <View style={styles.chips}>
      {chip('__all', allLabel, !selected.length, () => onChange([]))}
      {shown.map((option) => chip(option.key, option.count ? `${option.label} ${option.count}` : option.label, selected.includes(option.key),
        () => onChange(toggleChoice(selected, option.key, options.length))))}
      {all.length > shown.length && chip('__more', `More (${all.length - shown.length})`, false, () => setOpen(true))}
      {open && all.length > fold + 2 && chip('__less', 'Less', false, () => setOpen(false))}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: colors.surfaceSunken },
  active: { borderColor: colors.mint, backgroundColor: colors.mintWash },
  text: { color: colors.text, fontSize: 12, fontWeight: '700' },
  activeText: { color: colors.mint, fontWeight: '900' },
});
