import type { EdgePick } from '@crowniq/contracts';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { EdgePickCard } from './EdgePickCard';
import { useAuth } from '../auth';
import { colors, palette } from '../theme';
import { allAgree } from '../gkr2';

// Underdog Streaks and Ladders (owner, 2026-10-13): the day's surest picks only (a 70%+ chance, backed by sportsbook prices
// or stats, today's games, one per player, best 10). Underdog's own Streaks multipliers and Ladder payouts aren't in any feed,
// so each pick shows the smallest multiplier that makes it worth playing instead of an EV.
type Mode = 'streaks' | 'ladders';
type Reads = { gkr: { side: 'MORE' | 'LESS'; score: number } | null; gkr2?: { side: 'MORE' | 'LESS'; score: number } | null; gkrPlus: { side: 'MORE' | 'LESS'; probability: number } | null };
type ModePick = EdgePick & { reads?: Reads };
const sideWord = (side: 'MORE' | 'LESS') => side === 'MORE' ? 'More' : 'Less';


/**
 * Edge's, GKR's, GKR 2's (β: Beta, still calibrating) and GKR+'s reads side by side (owner, 2026-10-13), each saying when it
 * agrees or plays the other side. GKR+ blends GKR 2 now.
 */
function ReadsRow({ pick, withPlus }: { pick: ModePick; withPlus: boolean }) {
  const gkr = pick.reads?.gkr ?? null, gkr2 = pick.reads?.gkr2 ?? null, plus = pick.reads?.gkrPlus ?? null;
  const item = (label: string, text: string, agrees: boolean | null) => <View style={styles.read}>
    <Text style={styles.readLabel}>{label}</Text>
    <Text style={[styles.readText, agrees === false && styles.readOff]}>{text}</Text></View>;
  return <View style={styles.reads}>
    {item('Edge', `${sideWord(pick.side)} · ${Math.round(pick.probability * 100)}%`, true)}
    {item('GKR', gkr ? `${sideWord(gkr.side)} · ${Math.round(gkr.score)}` : 'No read', gkr ? gkr.side === pick.side : null)}
    {item('GKR 2 β', gkr2 ? `${sideWord(gkr2.side)} · ${Math.round(gkr2.score)}` : 'No read', gkr2 ? gkr2.side === pick.side : null)}
    {withPlus && item('GKR+', plus ? `${sideWord(plus.side)} · ${Math.round(plus.probability * 100)}%` : 'No read', plus ? plus.side === pick.side : null)}
  </View>;
}
const ABOUT: Record<Mode, string> = {
  streaks: 'Streaks: one pick at a time, and every pick has to hit. These are today’s surest picks (70%+ chance, backed by sportsbook prices). Each shows the smallest Streaks multiplier that makes it worth it; take it when the app pays more.',
  ladders: 'Ladders: More-only “X+” picks for your squad. These are today’s surest More picks (70%+ chance, backed by sportsbook prices) to build from. Ladder payouts aren’t in CrownIQ’s data, so check them in the app.',
};

export function UnderdogModes({ inSlip }: { inSlip: ReadonlySet<string> }) {
  const { request } = useAuth();
  const [mode, setMode] = useState<Mode | null>(null);
  const [result, setResult] = useState<{ mode: Mode; picks: ModePick[] | null } | null>(null);
  useEffect(() => {
    if (!mode) return;
    let active = true;
    void request(`/v1/edge/modes?platform=underdog&mode=${mode}`).then(async (response) => {
      if (active) setResult({ mode, picks: response.ok ? (await response.json() as { picks: ModePick[] }).picks : null });
    }).catch(() => { if (active) setResult({ mode, picks: null }); });
    return () => { active = false; };
  }, [mode, request]);
  const [agreeOnly, setAgreeOnly] = useState(false);
  const loaded = result && result.mode === mode ? result.picks : undefined;
  // "All agree": only picks every model backs on the same side, the shortest and safest list.
  // GKR+ is the owner's only: its reads come back for the owner alone.
  const withPlus = !!loaded?.some((pick) => !!pick.reads?.gkrPlus);
  const shown = loaded && agreeOnly ? loaded.filter((pick) => allAgree(pick, withPlus)) : loaded;
  return <View style={styles.box}>
    <View style={styles.chips}>{(['streaks', 'ladders'] as const).map((item) => <Pressable key={item} accessibilityRole="button"
      accessibilityState={{ selected: mode === item }} onPress={() => setMode(mode === item ? null : item)} style={[styles.chip, mode === item && styles.chipOn]}>
      <Text style={[styles.chipText, mode === item && styles.chipTextOn]}>{item === 'streaks' ? 'Streaks' : 'Ladders'}</Text></Pressable>)}</View>
    {mode && <>
      <Text style={styles.about}>{ABOUT[mode]}</Text>
      <Pressable accessibilityRole="switch" accessibilityState={{ checked: agreeOnly }} onPress={() => setAgreeOnly(!agreeOnly)}
        style={[styles.chip, styles.agree, agreeOnly && styles.chipOn]}>
        <Text style={[styles.chipText, agreeOnly && styles.chipTextOn]}>{agreeOnly ? '✓ ' : ''}{withPlus ? 'All agree: Edge, GKR, GKR 2 and GKR+' : 'All agree: Edge, GKR and GKR 2'}</Text></Pressable>
      {shown === undefined ? <ActivityIndicator color={colors.mint} /> : shown === null ? <Text style={styles.about}>Couldn’t load these right now. Pull down to refresh.</Text>
        : !shown.length ? <Text style={styles.about}>{agreeOnly && loaded?.length ? 'No pick today has every model on the same side. Turn off All agree to see the rest.'
          : 'Nothing backed by sportsbooks reaches 70% today. CrownIQ only lists the surest picks, so some days there are none.'}</Text>
        : shown.map((pick, index) => <View key={pick.lineId + pick.side} style={styles.item}>
          <Text style={styles.worth}>#{index + 1} · {Math.round(pick.probability * 100)}% to hit{mode === 'streaks' ? ` · worth it at ${(1 / pick.probability).toFixed(2)}x or more` : ''}</Text>
          <ReadsRow pick={pick} withPlus={withPlus} />
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
  agree: { alignSelf: 'flex-start' },
  chipText: { color: palette.muted, fontSize: 13, fontWeight: '800' },
  chipTextOn: { color: colors.mint },
  about: { color: palette.muted, fontSize: 13, lineHeight: 18 },
  item: { gap: 4 },
  reads: { flexDirection: 'row', gap: 8 },
  read: { flex: 1, borderWidth: 1, borderColor: palette.border, borderRadius: 10, paddingVertical: 6, alignItems: 'center' },
  readLabel: { color: palette.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  readText: { color: colors.mint, fontSize: 13, fontWeight: '800' },
  readOff: { color: colors.red },
  worth: { color: colors.mint, fontSize: 12.5, fontWeight: '800' },
});
