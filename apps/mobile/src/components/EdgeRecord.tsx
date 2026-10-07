import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { pct } from '../edge-format';
import { platformLabel } from '../edge-platform';
import { palette } from '../theme';
import { Notice } from './Screen';

type Interval = { value: number; low: number; high: number } | null;
type Evaluation = { graded: number; hitRate: Interval; averageBreakEven: number | null; clv: Interval; beatClose: number | null;
  roi: Interval; brier: number | null; brierSkill?: number | null; maxCalibrationGap: number | null;
  calibration: { from: number; to: number; n: number; forecast: number; hitRate: number }[] };
type Performance = { tracked: number; pending: number; evaluation: Evaluation; byPlatform: Record<string, Evaluation>;
  byTier: Record<string, Evaluation>; byRating: Record<string, Evaluation>; bySport?: Record<string, Evaluation> };

const range = (interval: Interval, points = false) => !interval ? '—'
  : points ? `${interval.value >= 0 ? '+' : '−'}${Math.abs(interval.value * 100).toFixed(1)} (${(interval.low * 100).toFixed(1)} to ${(interval.high * 100).toFixed(1)})`
    : `${pct(interval.value)} (${pct(interval.low, 0)}–${pct(interval.high, 0)})`;

/** Edge's track record (spec §8–9): closing-line value first, then hit rate vs break-even, ROI and calibration. */
export function EdgeRecord({ path = '/v1/edge/performance', name = 'Edge' }: { path?: string; name?: string } = {}) {
  const { request } = useAuth();
  const [data, setData] = useState<Performance | null | 'error'>(null);
  useFocusEffect(useCallback(() => {
    let active = true;
    void request(path).then(async (response) => {
      const body = response.ok ? await response.json() as Performance : null;
      if (active) setData(body ?? 'error');
    }).catch(() => { if (active) setData('error'); });
    return () => { active = false; };
  }, [request, path]));
  if (data === null) return <Notice title="Loading the record" detail={`Reading ${name}’s graded picks.`} />;
  if (data === 'error') return <Notice title="Record unavailable" detail="Try again in a minute." />;
  const row = (label: string, value: Evaluation) => <View key={label} style={styles.card}>
    <Text style={styles.label}>{label} · {value.graded} graded</Text>
    <Text style={styles.text}>CLV {range(value.clv, true)} pts · beat the close {value.beatClose === null ? '—' : pct(value.beatClose, 0)}</Text>
    <Text style={styles.text}>Hit rate {range(value.hitRate)} vs {value.averageBreakEven === null ? '—' : pct(value.averageBreakEven)} needed</Text>
    <Text style={styles.muted}>ROI per $1 {range(value.roi, true)}% · Brier {value.brier === null ? '—' : value.brier.toFixed(3)}
      {value.brierSkill === null || value.brierSkill === undefined ? '' : ` · skill vs close ${value.brierSkill >= 0 ? '+' : ''}${value.brierSkill.toFixed(3)}`}</Text>
  </View>;
  return <View style={styles.wrap}>
    <Text style={styles.intro}>Every rated {name} pick is saved before its game and graded from box scores. Closing-line value is the main test:
      {' '}{name}&apos;s chance at the close minus what the pick needed when it was shown. Ranges are 95%. {data.pending} picks are waiting on results.</Text>
    {data.evaluation.graded === 0 ? <Notice title="No graded picks yet" detail="The record fills in as games finish." /> : <>
      {row('All standard picks', data.evaluation)}
      <Text style={styles.section}>BY PLATFORM</Text>
      {Object.entries(data.byPlatform).map(([platform, value]) => row(platformLabel(platform as never), value))}
      <Text style={styles.section}>BY SOURCE</Text>
      {Object.entries(data.byTier).map(([tier, value]) => row(tier === 'STALE' ? 'Stale lines' : tier.charAt(0) + tier.slice(1).toLowerCase(), value))}
      {data.bySport && Object.keys(data.bySport).length > 1 && <><Text style={styles.section}>BY SPORT</Text>
        {Object.entries(data.bySport).map(([sport, value]) => row(sport, value))}</>}
      <Text style={styles.section}>CALIBRATION</Text>
      <View style={styles.card}>
        <Text style={styles.muted}>Bar = how often picks hit · line = the chance {name} gave them. A calibrated engine has the bar end at the line.</Text>
        {data.evaluation.calibration.map((bucket) => <View key={bucket.from} style={styles.calRow}>
          <Text style={styles.calLabel}>{pct(bucket.from, 0)}–{pct(bucket.to, 0)}</Text>
          <View style={styles.track}>
            <View style={[styles.bar, { width: `${Math.round(bucket.hitRate * 100)}%` }]} />
            <View style={[styles.marker, { left: `${Math.round(bucket.forecast * 100)}%` }]} />
          </View>
          <Text style={styles.calLabel}>{pct(bucket.hitRate, 0)} · {bucket.n}</Text>
        </View>)}
        <Text style={styles.muted}>Largest gap in buckets with 50+ picks: {data.evaluation.maxCalibrationGap === null ? 'not enough picks yet'
          : `${(data.evaluation.maxCalibrationGap * 100).toFixed(1)} points (target 3)`}</Text></View>
    </>}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  intro: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  section: { color: palette.green, fontSize: 11, fontWeight: '900', letterSpacing: 1.3, marginTop: 4 },
  card: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 14, padding: 12, gap: 3 },
  label: { color: palette.text, fontSize: 13, fontWeight: '900' },
  text: { color: palette.text, fontSize: 12 },
  muted: { color: palette.muted, fontSize: 11 },
  calRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  calLabel: { color: palette.text, fontSize: 11, width: 64 },
  track: { flex: 1, height: 12, backgroundColor: palette.border, borderRadius: 6, overflow: 'hidden' },
  bar: { height: 12, backgroundColor: palette.green, opacity: .7 },
  marker: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: palette.text },
});
