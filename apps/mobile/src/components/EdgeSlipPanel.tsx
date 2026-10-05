import { edgeSlipSchema } from '@crowniq/contracts';
import type { EdgeEntry, EdgeSlip } from '@crowniq/contracts';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { formatLine, marketLabel, pct } from '../edge-format';
import { edgeSlip, useEdgeSlip } from '../edge-slip';
import { palette } from '../theme';

export function SlipSummary({ slip, title }: { slip: EdgeSlip; title?: string }) {
  const profit = slip.expectedProfit;
  return <View style={styles.summary}>
    <Text style={styles.label}>{title ?? `${slip.entry.size}-PICK ${slip.entry.type}`}</Text>
    {slip.legs.map((leg) => <Text key={leg.lineId} style={styles.leg}>
      {pct(leg.probability, 0)} · {leg.playerName} {leg.side} {formatLine(leg.threshold)} {marketLabel(leg.market)}</Text>)}
    <Text style={[styles.ev, { color: profit > 0 ? palette.green : palette.danger }]}>
      Expected return {(slip.expectedReturn * 100).toFixed(0)}¢ per $1 ({profit >= 0 ? '+' : '−'}{Math.abs(profit * 100).toFixed(1)}%)</Text>
    <Text style={styles.small}>All legs hit {pct(slip.allHitProbability)} · pays {Object.entries(slip.entry.payouts)
      .sort((a, b) => Number(b[0]) - Number(a[0])).map(([hits, payout]) => `${hits}/${slip.entry.size}: ${payout}×`).join(', ')}</Text>
    {slip.warnings.map((warning) => <Text key={warning} style={styles.warning}>⚠ {warning}</Text>)}
  </View>;
}

export function EdgeSlipPanel({ entries }: { entries: readonly EdgeEntry[] }) {
  const { request } = useAuth();
  const legs = useEdgeSlip();
  const [type, setType] = useState<'POWER' | 'FLEX'>('POWER');
  const [result, setResult] = useState<{ key: string; slip: EdgeSlip | null; message: string } | null>(null);
  const supported = entries.some((entry) => entry.type === type && entry.size === legs.length);
  const key = JSON.stringify([type, legs.map((leg) => leg.lineId)]);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    void request('/v1/edge/slip', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, lineIds: legs.map((leg) => leg.lineId) }) })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) { setResult({ key, slip: null, message: 'Could not price this slip; a line may have expired.' }); return; }
        setResult({ key, slip: edgeSlipSchema.parse((await response.json()).slip), message: '' });
      }).catch(() => { if (active) setResult({ key, slip: null, message: 'Could not price this slip.' }); });
    return () => { active = false; };
  }, [key, legs, request, supported, type]);
  if (!legs.length) return null;
  const current = result?.key === key ? result : null;
  return <View style={styles.panel}>
    <View style={styles.header}>
      <Text style={styles.title}>MY SLIP · {legs.length} {legs.length === 1 ? 'LEG' : 'LEGS'}</Text>
      <Pressable accessibilityRole="button" onPress={() => edgeSlip.clear()}><Text style={styles.clear}>Clear</Text></Pressable>
    </View>
    <View style={styles.toggle}>{(['POWER', 'FLEX'] as const).map((option) =>
      <Pressable key={option} accessibilityRole="button" onPress={() => setType(option)}
        style={[styles.chip, type === option && styles.chipOn]}>
        <Text style={[styles.chipText, type === option && styles.chipTextOn]}>{option}</Text></Pressable>)}</View>
    {!supported && <Text style={styles.small}>{legs.length < 2 ? 'Add at least 2 legs.'
      : `No ${legs.length}-pick ${type.toLowerCase()} payout table is configured.`}</Text>}
    {supported && !current && <Text style={styles.small}>Pricing slip…</Text>}
    {current?.slip && <SlipSummary slip={current.slip} title="EXPECTED VALUE" />}
    {current?.message ? <Text style={styles.warning}>{current.message}</Text> : null}
    <Text style={styles.small}>Payouts are CrownIQ defaults; confirm them in the PrizePicks app. Same-game legs are correlated.</Text>
  </View>;
}

const styles = StyleSheet.create({
  panel: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.green, borderRadius: 18, padding: 16, gap: 8 },
  header: { flexDirection: 'row', justifyContent: 'space-between' },
  title: { color: palette.green, fontSize: 12, fontWeight: '900', letterSpacing: 1.2 },
  clear: { color: palette.muted, fontSize: 12, fontWeight: '700' },
  toggle: { flexDirection: 'row', gap: 8 },
  chip: { borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 5 },
  chipOn: { backgroundColor: palette.greenDim, borderColor: palette.green },
  chipText: { color: palette.muted, fontSize: 12, fontWeight: '800' },
  chipTextOn: { color: palette.green },
  summary: { gap: 4 },
  label: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  leg: { color: palette.text, fontSize: 13 },
  ev: { fontSize: 15, fontWeight: '900', marginTop: 2 },
  small: { color: palette.muted, fontSize: 11, lineHeight: 16 },
  warning: { color: palette.danger, fontSize: 11 },
});
