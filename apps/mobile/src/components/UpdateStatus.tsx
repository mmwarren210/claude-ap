import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { colors, radius } from '../theme';
import { useBoard } from '../use-board';
import { Icon } from './ui/Icon';

type Updates = { now: string; boardFetchedAt: string | null; builtAt: string | null; nextPullAt: string | null;
  rescoring: { startedAt: string; expectedMs: number | null } | null;
  /** Server clock minus this phone's clock, measured when the answer arrived. */
  skew: number };

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const ago = (ms: number) => ms < 90_000 ? 'just now' : ms < 3_600_000 ? `${minutes(ms)} min ago` : `${Math.round(ms / 3_600_000)} h ago`;

/**
 * When lines last updated and when the next update comes. While new lines are being scored it says so (rankings and
 * grades update in about N minutes) and reloads the board once they're ready. Checking costs no line pulls.
 */
export function UpdateStatus() {
  const { request, demo } = useAuth();
  const { data, reload } = useBoard();
  const [updates, setUpdates] = useState<Updates | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [focused, setFocused] = useState(false);
  const builtAt = data?.builtAt ?? null;
  const seen = useRef(builtAt);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  useEffect(() => {
    if (demo || !focused) return;
    let active = true;
    const check = () => { void request('/v1/board/updates').then(async (response) => {
      if (!active || !response.ok) return;
      const body = await response.json() as Omit<Updates, 'skew'>;
      setUpdates({ ...body, skew: Date.parse(body.now) - Date.now() });
    }).catch(() => undefined); };
    check();
    // Every 20 seconds while new lines are being scored, else every minute.
    const timer = setInterval(check, updates?.rescoring ? 20_000 : 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [request, demo, focused, updates?.rescoring]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  // A newer board on the server than the one showing: load it (a single small download; unchanged boards cost nothing).
  useEffect(() => {
    if (updates?.builtAt && builtAt && updates.builtAt !== builtAt && seen.current !== updates.builtAt) { seen.current = updates.builtAt; reload(); }
  }, [updates?.builtAt, builtAt, reload]);
  if (demo || !updates) return null;
  // Server and phone clocks can differ, so times are measured against the server's own "now".
  const now = clock + updates.skew;
  if (updates.rescoring) {
    const left = updates.rescoring.expectedMs ? updates.rescoring.expectedMs - (now - Date.parse(updates.rescoring.startedAt)) : null;
    return <View style={[styles.bar, styles.busy]} accessibilityLiveRegion="polite">
      <Icon name="progress-clock" size={16} color={colors.gold} />
      <Text style={styles.busyText}>New lines are in. Scoring them now; rankings and grades update {left !== null && left > 0
        ? `in about ${minutes(left)} min` : 'any moment'}. Picks below are from the last update.</Text>
    </View>;
  }
  const updated = updates.boardFetchedAt ? Date.parse(updates.boardFetchedAt) : null;
  const next = updates.nextPullAt ? Date.parse(updates.nextPullAt) - now : null;
  return <View style={styles.bar}>
    <Icon name="update" size={16} color={colors.textMuted} />
    <Text style={styles.text}>{updated ? `Lines updated ${ago(now - updated)}` : 'Lines update automatically'}
      {next !== null ? ` · next check ${next <= 60_000 ? 'any moment' : `in ${minutes(next)} min`}` : ''}</Text>
  </View>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSunken },
  busy: { borderColor: colors.gold, backgroundColor: colors.goldWash },
  text: { flex: 1, color: colors.textMuted, fontSize: 12.5 },
  busyText: { flex: 1, color: colors.gold, fontSize: 12.5, fontWeight: '700', lineHeight: 17 },
});
