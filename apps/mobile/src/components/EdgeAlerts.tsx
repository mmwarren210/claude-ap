import type { EdgePlatform } from '@crowniq/contracts';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { formatLine, marketLabel, pct } from '../edge-format';
import { palette } from '../theme';

type Alert = { id: string; at: string; platform: EdgePlatform; lineId: string; playerName: string; market: string; threshold: number;
  side: 'MORE' | 'LESS'; probability: number; edge: number; text: string };

/** Edge's alerts (spec §8): lines the books moved past while the app hasn't, with a real edge. One per player per hour. */
export function EdgeAlerts({ platform }: { platform: EdgePlatform }) {
  const { request, demo } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  useFocusEffect(useCallback(() => {
    if (demo) return;
    let active = true;
    const load = () => void request(`/v1/edge/alerts?platform=${platform}`).then(async (response) => {
      const body = response.ok ? await response.json() as { alerts: Alert[] } : null;
      if (active) setAlerts(body?.alerts ?? []);
    }).catch(() => undefined);
    load();
    const timer = setInterval(load, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [request, demo, platform]));
  if (!alerts.length) return null;
  return <View style={styles.box}>
    <Text style={styles.title}>ALERTS · BOOKS MOVED, THE APP HASN’T</Text>
    {alerts.slice(0, 5).map((alert) => <Pressable key={alert.id} accessibilityRole="button" style={styles.row}
      onPress={() => router.push({ pathname: '/edge/[lineId]', params: { lineId: alert.lineId, platform: alert.platform } })}>
      <Text style={styles.line}>{alert.playerName} {alert.side} {formatLine(alert.threshold)} {marketLabel(alert.market)} · {pct(alert.probability, 0)}
        {' '}· +{(alert.edge * 100).toFixed(1)} pts</Text>
      <Text style={styles.muted}>{alert.text} · {new Date(alert.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
    </Pressable>)}
  </View>;
}

const styles = StyleSheet.create({
  box: { backgroundColor: palette.card, borderWidth: 1, borderColor: '#F2B84B', borderRadius: 16, padding: 14, gap: 8 },
  title: { color: '#F2B84B', fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  row: { gap: 2 },
  line: { color: palette.text, fontSize: 13, fontWeight: '800' },
  muted: { color: palette.muted, fontSize: 11, lineHeight: 15 },
});
