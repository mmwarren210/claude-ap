import type { BoardResponse } from '@crowniq/contracts';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { marketLabel } from '../insights';
import { emptyFilters } from '../state';
import type { Filters, ViewMode } from '../state';
import { colors, lineStyleOf, lineStyles, radius } from '../theme';
import { Sheet } from './Sheet';
import { PrimaryButton } from './ui/Controls';

type Group = { key: keyof Filters; label: string; options: string[]; fullOnly?: boolean };

export function filterGroups(data: BoardResponse, draft: Filters): Group[] {
  return [
    { key: 'sport', label: 'Sport', options: [...new Set(data.board.lines.map((line) => line.sport))].sort() },
    { key: 'market', label: 'Market', options: [...new Set(data.board.lines.filter((line) =>
      draft.sport === 'ALL' || line.sport === draft.sport).map((line) => line.market))].sort() },
    { key: 'lineType', label: 'Line style', options: ['REGULAR', 'GOBLIN', 'DEMON'] },
    { key: 'evidence', label: 'Evidence', options: ['HIGH', 'MEDIUM', 'LOW', 'NONE'] },
    { key: 'date', label: 'Date', options: [...new Set(data.board.lines.map((line) =>
      line.eventStartTime.slice(0, 10)))].sort() },
    { key: 'direction', label: 'Direction', options: ['MORE', 'LESS', 'PASS'], fullOnly: true },
    { key: 'grade', label: 'Score band', options: ['CROWN_ELITE', 'CROWN_STRONG', 'PLAYABLE', 'LEAN', 'WEAK', 'PASS'],
      fullOnly: true },
  ];
}

export function optionLabel(key: keyof Filters, option: string): string {
  if (option === 'ALL') return key === 'sport' ? 'All Sports' : 'All';
  if (key === 'market') return marketLabel(option);
  if (key === 'lineType') return lineStyles[lineStyleOf(option as 'REGULAR')].label;
  if (key === 'evidence') return { HIGH: 'A · Strong', MEDIUM: 'B · Good', LOW: 'C · Thin', NONE: 'None' }[option] ?? option;
  if (key === 'date') return new Date(option + 'T12:00:00').toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric' });
  return option.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}

/** Filter sheet. With `only`, it shows one filter and applies on tap, like a dropdown. */
export function FilterSheet({ visible, onClose, data, value, onApply, mode, only }: { visible: boolean;
  onClose: () => void; data: BoardResponse; value: Filters; onApply: (next: Filters) => void; mode: ViewMode;
  only?: keyof Filters }) {
  const [draft, setDraft] = useState(value);
  const groups = filterGroups(data, draft).filter((group) => only ? group.key === only : mode === 'FULL' || !group.fullOnly);
  const choose = (key: keyof Filters, option: string) => {
    const next = { ...draft, [key]: option, ...(key === 'sport' ? { market: 'ALL' } : {}) };
    setDraft(next);
    if (only) { onApply(next); onClose(); }
  };
  return <Sheet visible={visible} title={only ? groups[0]?.label ?? 'Filter' : 'More filters'} onClose={onClose}>
    {groups.map(({ key, label, options }) => <View key={key} style={styles.group}>
      {!only && <Text style={styles.heading}>{label}</Text>}
      <View style={styles.options}>
        {['ALL', ...options].map((option) => {
          const selected = draft[key] === option;
          return <Pressable key={option} accessibilityRole="button" accessibilityState={{ selected }}
            onPress={() => choose(key, option)} style={[styles.chip, selected && styles.active]}>
            <Text style={[styles.text, selected && styles.activeText]}>{optionLabel(key, option)}</Text></Pressable>;
        })}
      </View></View>)}
    {!only && <View style={styles.actions}>
      <Pressable accessibilityRole="button" style={styles.reset} onPress={() => setDraft(emptyFilters)}>
        <Text style={styles.text}>Reset</Text></Pressable>
      <PrimaryButton label="Apply" style={styles.apply} onPress={() => { onApply(draft); onClose(); }} />
    </View>}
  </Sheet>;
}

const styles = StyleSheet.create({
  group: { gap: 10 },
  heading: { color: colors.text, fontSize: 15, fontWeight: '800' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    minHeight: 42, justifyContent: 'center', backgroundColor: colors.surfaceSunken },
  active: { borderColor: colors.mint, backgroundColor: colors.mintWash },
  text: { color: colors.text, fontSize: 13, fontWeight: '600' },
  activeText: { color: colors.mint, fontWeight: '800' },
  actions: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  reset: { minHeight: 50, paddingHorizontal: 20, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    justifyContent: 'center' },
  apply: { flex: 1 },
});
