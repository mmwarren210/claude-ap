import type { EdgePlatform } from '@crowniq/contracts';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { formatLine, marketLabel, pct } from '../edge-format';
import { platformLabel } from '../edge-platform';
import { colors, radius } from '../theme';
import { EdgeRecord } from './EdgeRecord';
import { Notice } from './Screen';

// Edge's results on the Results tab: its own graded picks (every rated Edge pick is saved before its game and graded from box
// scores), judged on Edge's terms (hit rate vs the break-even it needed, closing-line value), never against GKR.

type Recent = { id: string; platform: string; playerName: string; market: string; threshold: number; side: 'MORE' | 'LESS';
  firstProbability: number; breakEven: number; outcome: 'WIN' | 'LOSS' | 'PUSH' | 'VOID' | 'PENDING'; actual: number | null;
  eventStartTime: string; rating: string; decimal?: number };
type Performance = { tracked: number; pending: number; recent: Recent[] };

const DAY = 86_400_000;

export function EdgeResults({ days, nowMs }: { days: 7 | 30 | 0; nowMs: number }) {
  const { request } = useAuth();
  const [data, setData] = useState<Performance | null | 'error'>(null);
  useFocusEffect(useCallback(() => {
    let active = true;
    void request('/v1/edge/performance').then(async (response) => {
      const body = response.ok ? await response.json() as Performance : null;
      if (active) setData(body ?? 'error');
    }).catch(() => { if (active) setData('error'); });
    return () => { active = false; };
  }, [request]));
  if (data === null) return <Notice title="Loading Edge results" detail="Reading Edge's graded picks." />;
  if (data === 'error') return <Notice title="Edge results unavailable" detail="Try again in a minute." />;
  const recent = data.recent.filter((pick) => days === 0 || Date.parse(pick.eventStartTime) >= nowMs - days * DAY);
  const decided = recent.filter((pick) => pick.outcome === 'WIN' || pick.outcome === 'LOSS');
  const wins = decided.filter((pick) => pick.outcome === 'WIN').length;
  const needed = decided.length ? decided.reduce((sum, pick) => sum + pick.breakEven, 0) / decided.length : null;
  // Units at 1 per pick: sportsbook bets at their odds; pick'em legs at a fair 1 ÷ break-even payout.
  const units = decided.reduce((sum, pick) => sum + (pick.outcome === 'WIN' ? (pick.decimal ?? 1 / Math.max(pick.breakEven, .01)) - 1 : -1), 0);
  return <View style={styles.wrap}>
    <View style={styles.summary}>
      <Tile label="Record" value={`${wins}-${decided.length - wins}`} sub={`${data.pending} pending`} />
      <Tile label="Hit rate" value={decided.length ? pct(wins / decided.length, 0) : '—'} sub={needed === null ? 'needs graded picks' : `needed ${pct(needed, 0)}`}
        color={needed !== null && decided.length && wins / decided.length >= needed ? colors.mint : undefined} />
      <Tile label="Est. units" value={`${units >= 0 ? '+' : ''}${units.toFixed(1)}u`} sub="1 unit per pick" color={units >= 0 ? colors.mint : colors.red} />
    </View>
    {recent.length === 0 ? <Notice title="No graded Edge picks here yet" detail="Edge saves every rated pick before its game; results land as games finish." />
      : <View style={styles.list}>
        <Text style={styles.section}>Recent Edge picks</Text>
        {recent.slice(0, 30).map((pick) => <View key={pick.id} style={styles.pick}>
          <View style={styles.grow}>
            <Text style={styles.name}>{pick.playerName}</Text>
            <Text style={styles.sub}>{platformLabel(pick.platform as EdgePlatform)} · {pick.side} {formatLine(pick.threshold)} {marketLabel(pick.market)} · Edge said {pct(pick.firstProbability, 0)}</Text>
          </View>
          <Text style={[styles.result, { color: pick.outcome === 'WIN' ? colors.mint : pick.outcome === 'LOSS' ? colors.red : colors.textMuted }]}>
            {pick.outcome === 'WIN' ? 'WIN' : pick.outcome === 'LOSS' ? 'LOSS' : pick.outcome === 'PUSH' ? 'PUSH' : 'VOID'}{pick.actual !== null ? ` · ${pick.actual}` : ''}</Text>
        </View>)}
      </View>}
    <Text style={styles.section}>Edge’s full track record</Text>
    <EdgeRecord />
  </View>;
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub: string; color?: string }) {
  return <View style={styles.tile}><Text style={styles.tileLabel}>{label}</Text>
    <Text style={[styles.tileValue, color ? { color } : null]}>{value}</Text><Text style={styles.sub}>{sub}</Text></View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  summary: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 12, gap: 4, alignItems: 'center' },
  tileLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  tileValue: { color: colors.text, fontSize: 24, fontWeight: '900' },
  list: { gap: 8 },
  section: { color: colors.mint, fontSize: 13, fontWeight: '900', letterSpacing: .5, marginTop: 4 },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12 },
  grow: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 14, fontWeight: '800' },
  sub: { color: colors.textMuted, fontSize: 11 },
  result: { fontSize: 12, fontWeight: '900' },
});
