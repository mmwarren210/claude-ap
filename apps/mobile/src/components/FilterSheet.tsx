import type { BoardResponse } from '@crowniq/contracts';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { marketLabel } from '../insights';
import { emptyFilters, passes, toggleFilter } from '../state';
import type { Filters, ViewMode } from '../state';
import { colors, lineStyleOf, lineStyles, radius } from '../theme';
import { Sheet } from './Sheet';
import { PrimaryButton } from './ui/Controls';

type Group = { key: keyof Filters; label: string; options: string[]; fullOnly?: boolean };

export function filterGroups(data: BoardResponse, draft: Filters): Group[] {
  return [
    { key: 'sport', label: 'Sport', options: [...new Set(data.board.lines.map((line) => line.sport))].sort() },
    { key: 'market', label: 'Stat', options: [...new Set(data.board.lines.filter((line) =>
      passes(draft.sport, line.sport)).map((line) => line.market))].sort() },
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
  // Several picks: name up to two, else count them.
  if (option.includes(',')) { const parts = option.split(',');
    return parts.length > 2 ? `${parts.length} picked` : parts.map((part) => optionLabel(key, part)).join(' + '); }
  if (key === 'market') return marketLabel(option);
  if (key === 'lineType') return lineStyles[lineStyleOf(option as 'REGULAR')].label;
  if (key === 'evidence') return { HIGH: 'A · Strong', MEDIUM: 'B · Good', LOW: 'C · Thin', NONE: 'None' }[option] ?? option;
  if (key === 'date') return new Date(option + 'T12:00:00').toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric' });
  return option.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}

/** Filter sheet; every group takes several picks at once. With `only`, it shows one filter and applies each tap at once. */
export function FilterSheet({ visible, onClose, data, value, onApply, mode, only }: { visible: boolean;
  onClose: () => void; data: BoardResponse; value: Filters; onApply: (next: Filters) => void; mode: ViewMode;
  only?: keyof Filters }) {
  const [draft, setDraft] = useState(value);
  const groups = filterGroups(data, draft).filter((group) => only ? group.key === only : mode === 'FULL' || !group.fullOnly);
  const choose = (key: keyof Filters, option: string) => {
    const next = { ...draft, [key]: toggleFilter(draft[key], option) };
    setDraft(next);
    if (only) onApply(next);
  };
  return <Sheet visible={visible} title={only ? groups[0]?.label ?? 'Filter' : 'More filters'} onClose={onClose}>
    {groups.map(({ key, label, options }) => <View key={key} style={styles.group}>
      {!only && <Text style={styles.heading}>{label}</Text>}
      <View style={styles.options}>
        {['ALL', ...options].map((option) => {
          const selected = option === 'ALL' ? draft[key] === 'ALL' : passes(draft[key], option) && draft[key] !== 'ALL';
          return <Pressable key={option} accessibilityRole="button" accessibilityState={{ selected }}
            onPress={() => choose(key, option)} style={[styles.chip, selected && styles.active]}>
            <Text style={[styles.text, selected && styles.activeText]}>{optionLabel(key, option)}</Text></Pressable>;
        })}
      </View></View>)}
    {only && <PrimaryButton label="Done" onPress={onClose} />}
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
