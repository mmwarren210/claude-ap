import type { Analysis, PlayableDirection, PropLine } from '@crowniq/contracts';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LegTip, TipId } from '../state';
import { useDraft } from '../use-draft';
import { colors, radius } from '../theme';
import { Sheet } from './Sheet';
import { GhostButton, PrimaryButton } from './ui/Controls';
import { Icon } from './ui/Icon';

const quips = [
  "I'm just trying to help you make a better decision, since you're only human.",
  'No judgment. Okay, a little judgment. Your call, though.',
  "You're the adult here. I'm just the friend who reads the stats.",
  "I'll stop nagging if you want. I'm a nice algorithm like that.",
];

/** A light line to go with a tip, stable for the same tips so it does not change while the sheet is open. */
export function quipFor(tips: readonly LegTip[]): string {
  const seed = tips.map((tip) => tip.id).join('').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return quips[seed % quips.length]!;
}

/**
 * CrownIQ's advice before the user does something its rules advise against. They can take the advice, go ahead
 * anyway, or go ahead and never see these tips again.
 */
export function TipSheet({ tips, action = 'Add anyway', onProceed, onCancel }: { tips: readonly LegTip[];
  action?: string; onProceed: (hide: boolean) => void; onCancel: () => void }) {
  return <Sheet visible={tips.length > 0} title="Quick tip" onClose={onCancel}>
    {tips.map((tip) => <View key={tip.id} style={styles.tip}>
      <Icon name="lightbulb-on-outline" size={22} color={colors.gold} />
      <View style={styles.copy}><Text style={styles.title}>{tip.title}</Text>
        <Text style={styles.text}>{tip.text}</Text></View>
    </View>)}
    {tips.length > 0 && <Text style={styles.quip}>{quipFor(tips)}</Text>}
    <PrimaryButton label="Good call, skip it" icon="check" onPress={onCancel} />
    <GhostButton label={action} icon="account-check-outline" onPress={() => onProceed(false)} tone={colors.gold} />
    <GhostButton label={`${action} · don't show again`} icon="bell-off-outline" onPress={() => onProceed(true)}
      tone={colors.textMuted} />
  </Sheet>;
}

/**
 * Adding a leg with CrownIQ's tips in the way: `attempt` adds it, reports a hard stop, or opens the tip sheet (render
 * `sheet`), and adds it as the user's call if they go ahead. `onMessage` gets what to tell the user.
 */
export function useTipFlow(onMessage: (text: string) => void) {
  const { add, hideTips } = useDraft();
  const [pending, setPending] = useState<{ line: PropLine; analysis: Analysis | undefined; side: PlayableDirection;
    tips: LegTip[]; done: string } | null>(null);
  const attempt = (line: PropLine, analysis: Analysis | undefined, side: PlayableDirection, done: string,
    accept: readonly TipId[] = []) => {
    const result = add(line, analysis, side, accept);
    if (result.error) { setPending(null); onMessage(result.error); return; }
    if (result.tips.length) { setPending({ line, analysis, side, tips: result.tips, done }); return; }
    setPending(null);
    onMessage(accept.length ? `${done} As your call. Good luck!` : done);
  };
  const sheet = <TipSheet tips={pending?.tips ?? []} onCancel={() => setPending(null)} onProceed={(hide) => {
    if (!pending) return;
    const ids = pending.tips.map((tip) => tip.id);
    if (hide) hideTips(ids);
    attempt(pending.line, pending.analysis, pending.side, pending.done, ids);
  }} />;
  return { attempt, sheet };
}

const styles = StyleSheet.create({
  tip: { flexDirection: 'row', gap: 12, backgroundColor: colors.surface, borderRadius: radius.md, padding: 14,
    borderWidth: 1, borderColor: colors.border },
  copy: { flex: 1, gap: 4 },
  title: { color: colors.text, fontSize: 16, fontWeight: '800' },
  text: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  quip: { color: colors.gold, fontSize: 14, fontStyle: 'italic', lineHeight: 20 },
});
