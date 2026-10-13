import type { EdgePick } from '@crowniq/contracts';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { EdgePickCard } from './EdgePickCard';
import { useAuth } from '../auth';
import { colors, palette } from '../theme';

// Underdog Streaks and Ladders (owner, 2026-10-13): the day's surest picks only (a 70%+ chance, backed by sportsbook prices
// or stats, today's games, one per player, best 10). Underdog's own Streaks multipliers and Ladder payouts aren't in any feed,
// so each pick shows the smallest multiplier that makes it worth playing instead of an EV.
type Mode = 'streaks' | 'ladders';
const ABOUT: Record<Mode, string> = {
  streaks: 'Streaks: one pick at a time, and every pick has to hit. These are today’s surest picks (70%+ chance). Each shows the smallest Streaks multiplier that makes it worth it; take it when the app pays more.',
  ladders: 'Ladders: More-only “X+” picks for your squad. These are today’s surest More picks (70%+ chance) to build from. Ladder payouts aren’t in CrownIQ’s data, so check them in the app.',
};

export function UnderdogModes({ inSlip }: { inSlip: ReadonlySet<string> }) {
  const { request } = useAuth();
  const [mode, setMode] = useState<Mode | null>(null);
  const [result, setResult] = useState<{ mode: Mode; picks: EdgePick[] | null } | null>(null);
  useEffect(() => {
    if (!mode) return;
    let active = true;
    void request(`/v1/edge/modes?platform=underdog&mode=${mode}`).then(async (response) => {
      if (active) setResult({ mode, picks: response.ok ? (await response.json() as { picks: EdgePick[] }).picks : null });
    }).catch(() => { if (active) setResult({ mode, picks: null }); });
    return () => { active = false; };
  }, [mode, request]);
  const shown = result && result.mode === mode ? result.picks : undefined;
  return <View style={styles.box}>
    <View style={styles.chips}>{(['streaks', 'ladders'] as const).map((item) => <Pressable key={item} accessibilityRole="button"
      accessibilityState={{ selected: mode === item }} onPress={() => setMode(mode === item ? null : item)} style={[styles.chip, mode === item && styles.chipOn]}>
      <Text style={[styles.chipText, mode === item && styles.chipTextOn]}>{item === 'streaks' ? 'Streaks' : 'Ladders'}</Text></Pressable>)}</View>
    {mode && <>
      <Text style={styles.about}>{ABOUT[mode]}</Text>
      {shown === undefined ? <ActivityIndicator color={colors.mint} /> : shown === null ? <Text style={styles.about}>Couldn’t load these right now. Pull down to refresh.</Text>
        : !shown.length ? <Text style={styles.about}>Nothing reaches 70% today. CrownIQ only lists the surest picks, so some days there are none.</Text>
        : shown.map((pick, index) => <View key={pick.lineId + pick.side} style={styles.item}>
          <Text style={styles.worth}>#{index + 1} · {Math.round(pick.probability * 100)}% to hit{mode === 'streaks' ? ` · worth it at ${(1 / pick.probability).toFixed(2)}x or more` : ''}</Text>
          <EdgePickCard pick={pick} accent={colors.mint} inSlip={inSlip.has(pick.lineId)} />
        </View>)}
    </>}
  </View>;
}

const styles = StyleSheet.create({
  box: { gap: 10 },
  chips: { flexDirection: 'row', gap: 8 },
  chip: { borderWidth: 1, borderColor: palette.border, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 7 },
  chipOn: { borderColor: colors.mint, backgroundColor: colors.mintWash },
  chipText: { color: palette.muted, fontSize: 13, fontWeight: '800' },
  chipTextOn: { color: colors.mint },
  about: { color: palette.muted, fontSize: 13, lineHeight: 18 },
  item: { gap: 4 },
  worth: { color: colors.mint, fontSize: 12.5, fontWeight: '800' },
});
