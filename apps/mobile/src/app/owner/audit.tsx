import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';
import { useAuth } from '../../auth';
import { Notice, Screen } from '../../components/Screen';
import { marketLabel } from '../../insights';
import { colors } from '../../theme';

// Spot checks (owner, 2026-10-12): ten random GKR picks from the last two weeks (half graded, half pending), each with its
// evidence page. Mark each one Accurate or Wrong; the tally shows how often the evidence held up.

type Pick = { trackedPickId: string; playerName: string; sport: string; market: string; exactLine: number; direction: string; lineType: string;
  lineScore: number; modelVersion: string; eventStartTime: string; grade: string; actualResult: number | null };
type Summary = { checked: number; accurate: number; wrong: number; recentWrong: { trackedPickId: string; playerName: string | null; note: string | null; at: string }[] };

export default function AuditScreen() {
  const { request } = useAuth();
  const [state, setState] = useState<{ picks: Pick[]; summary: Summary } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marked, setMarked] = useState<Record<string, 'ACCURATE' | 'WRONG'>>({});
  const load = useCallback(() => {
    void request('/v1/owner/audit?count=10').then(async (response) => {
      if (!response.ok) { setError(response.status === 404 ? 'Owner only.' : `Couldn't load (${response.status}).`); return; }
      setState(await response.json() as { picks: Pick[]; summary: Summary }); setMarked({}); setError(null);
    }).catch(() => setError('Couldn\'t load.'));
  }, [request]);
  useEffect(() => { load(); }, [load]);
  const mark = (id: string, verdict: 'ACCURATE' | 'WRONG') => {
    setMarked((current) => ({ ...current, [id]: verdict }));
    void request(`/v1/owner/audit/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict }) }).then(async (response) => {
      if (response.ok) { const body = await response.json() as { summary: Summary }; setState((current) => current ? { ...current, summary: body.summary } : current); }
    }).catch(() => undefined);
  };
  return <Screen eyebrow="OWNER  /  SPOT CHECKS" title="Spot-check picks">
    <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>← Back</Text></Pressable>
    <Text style={styles.muted}>Open a pick’s evidence, check its inputs and games against a box score, then mark it. Accurate = the evidence was real and matches; Wrong = something didn’t.</Text>
    {error ? <Notice title={error} detail="" /> : !state ? <ActivityIndicator color={colors.mint} /> : <>
      <View style={styles.tally}>
        <Text style={styles.tallyText}>Checked {state.summary.checked} · accurate {state.summary.accurate} · wrong {state.summary.wrong}</Text>
      </View>
      {state.picks.length ? state.picks.map((pick) => <View key={pick.trackedPickId} style={styles.card}>
        <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/owner/evidence', params: { pick: pick.trackedPickId } })}>
          <Text style={styles.title}>{pick.playerName} · {marketLabel(pick.market)} {pick.direction} {pick.exactLine}</Text>
          <Text style={styles.muted}>{pick.sport} · GKR {Math.round(pick.lineScore)} · {pick.grade}{pick.actualResult !== null ? ` (${pick.actualResult})` : ''} · {pick.eventStartTime.slice(0, 10)}</Text>
          <Text style={styles.link}>Open evidence →</Text>
        </Pressable>
        <View style={styles.buttons}>
          {(['ACCURATE', 'WRONG'] as const).map((verdict) => <Pressable key={verdict} accessibilityRole="button" onPress={() => mark(pick.trackedPickId, verdict)}
            style={[styles.button, marked[pick.trackedPickId] === verdict && (verdict === 'ACCURATE' ? styles.good : styles.bad)]}>
            <Text style={styles.buttonText}>{verdict === 'ACCURATE' ? 'Accurate' : 'Wrong'}</Text></Pressable>)}
        </View>
      </View>) : <Notice title="Nothing left to check from the last two weeks." detail="" />}
      <Pressable accessibilityRole="button" onPress={load} style={styles.more}><Text style={styles.buttonText}>Load 10 more</Text></Pressable>
    </>}
  </Screen>;
}

const styles = StyleSheet.create({
  back: { color: colors.mint, fontWeight: '700', marginBottom: 6 },
  muted: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  tally: { marginVertical: 10 },
  tallyText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginBottom: 8, padding: 12, gap: 4 },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  link: { color: colors.mint, fontSize: 12, marginTop: 2 },
  buttons: { flexDirection: 'row', gap: 8, marginTop: 8 },
  button: { borderColor: colors.border, borderRadius: 999, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 6 },
  good: { backgroundColor: colors.mintWash, borderColor: colors.mint },
  bad: { borderColor: colors.red },
  buttonText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  more: { alignSelf: 'center', borderColor: colors.mint, borderRadius: 999, borderWidth: 1, marginTop: 8, paddingHorizontal: 16, paddingVertical: 8 },
});
