import type { EdgePick } from '@crowniq/contracts';
import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { EdgePickCard } from './EdgePickCard';
import { colors, palette } from '../theme';

// Held picks (owner, 2026-10-13): a platform CrownIQ is holding (its +EV picks lean one way, or its feed is new) keeps them
// out of Top Picks and entries; they show here with the reason, for members to judge themselves.
export function HeldPicks({ held, inSlip }: { held?: { reason: string; picks: EdgePick[] } | null; inSlip: ReadonlySet<string> }) {
  if (!held?.picks.length) return null;
  return <View style={styles.section}>
    <Text style={styles.title}>HELD · {held.picks.length} {held.picks.length === 1 ? 'PICK' : 'PICKS'}</Text>
    <Text style={styles.reason}>{held.reason}</Text>
    {held.picks.map((pick) => <EdgePickCard key={pick.key + pick.side} pick={pick} accent={colors.gold} inSlip={inSlip.has(pick.lineId)} />)}
  </View>;
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  title: { color: colors.gold, fontSize: 13, fontWeight: '900', letterSpacing: 1.4 },
  reason: { color: palette.muted, fontSize: 13, lineHeight: 18 },
});
