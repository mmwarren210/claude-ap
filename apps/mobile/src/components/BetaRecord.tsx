import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { colors, radius } from '../theme';
import { useBeta } from '../use-model';
import { useIsOwner } from '../use-owner';

type Record = { picks: number; graded: number; wins: number; hitRate: number | null };
const line = (record: Record | undefined) => !record || !record.graded ? 'no graded picks yet'
  : `${record.wins}-${record.graded - record.wins} (${Math.round((record.hitRate ?? 0) * 100)}%)`;

/** GKR Beta against GKR on the same graded picks, for lifetime members. */
export function BetaRecord() {
  const { request } = useAuth();
  const { canSeeBeta: canUseBeta } = useBeta();
  const [value, setValue] = useState<{ gkr?: Record; beta?: Record; betaPass?: Record; history?: Record } | null>(null);
  // GKR+ (Edge + history + GKR) is owner-only: its rated standard picks from its own ledger, plus those still waiting.
  const owner = useIsOwner();
  const [plus, setPlus] = useState<(Record & { pending: number }) | null>(null);
  useEffect(() => {
    if (!owner) return;
    let active = true;
    void request('/v1/owner/gkr-plus/record').then(async (response) => response.ok ? response.json() : null)
      .then((body: { pending?: number; standardLines?: { graded: number; hitRate: number | null } } | null) => {
        if (!active || !body?.standardLines) return;
        const { graded, hitRate } = body.standardLines;
        setPlus({ picks: graded, graded, wins: Math.round((hitRate ?? 0) * graded), hitRate, pending: body.pending ?? 0 });
      }).catch(() => undefined);
    return () => { active = false; };
  }, [owner, request]);
  useEffect(() => {
    if (!canUseBeta) return;
    let active = true;
    void request('/v1/beta/record').then(async (response) => response.ok ? response.json() : null)
      .then((body) => { if (active && body) setValue(body as typeof value); }).catch(() => undefined);
    return () => { active = false; };
  }, [canUseBeta, request]);
  if (!canUseBeta || !value) return null;
  const saved = value.betaPass && value.betaPass.graded ? value.betaPass.graded - value.betaPass.wins : 0;
  return <View style={styles.box}>
    <Text style={styles.title}>GKR Beta test</Text>
    <Text style={styles.row}>GKR Beta: <Text style={styles.strong}>{line(value.beta)}</Text></Text>
    <Text style={styles.row}>GKR on the same picks: <Text style={styles.strong}>{line(value.gkr)}</Text></Text>
    <Text style={styles.row}>History Read (free, lines GKR doesn’t play): <Text style={styles.strong}>{line(value.history)}</Text></Text>
    {owner && plus && <Text style={styles.row}>GKR+ (Edge + history + GKR, all platforms): <Text style={styles.strong}>{line(plus)}</Text>
      {plus.pending ? ` · ${plus.pending} waiting` : ''}</Text>}
    <Text style={styles.note}>{value.betaPass?.graded ? `Beta passed ${value.betaPass.graded} late-news picks; ${saved} of them lost for GKR.`
      : 'Picks are graded after their games. Beta only differs from GKR where Scout has read the line.'}</Text>
  </View>;
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderColor: colors.gold, borderRadius: radius.lg, padding: 12, gap: 4 },
  title: { color: colors.gold, fontSize: 14, fontWeight: '800' },
  row: { color: colors.textMuted, fontSize: 13 },
  strong: { color: colors.text, fontWeight: '800' },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
});
