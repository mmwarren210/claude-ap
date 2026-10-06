import { edgeSlipSchema } from '@crowniq/contracts';
import type { EdgeEntry, EdgeSlip } from '@crowniq/contracts';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../auth';
import { formatLine, marketLabel, pct, slipDollars, usd } from '../edge-format';
import { edgeStake, STAKES, useEdgeStake } from '../edge-stake';
import { isBook, platformLabel, useEdgePlatform } from '../edge-platform';
import { edgeSlip, useEdgeSlip } from '../edge-slip';
import { palette } from '../theme';

/** Pick the entry amount Edge prices slips at ($5–$100 or your own). */
export function StakePicker() {
  const stake = useEdgeStake();
  const [text, setText] = useState('');
  return <View style={styles.stakeRow}>
    <Text style={styles.label}>ENTRY</Text>
    {STAKES.map((value) => <Pressable key={value} accessibilityRole="button" onPress={() => { edgeStake.set(value); setText(''); }}
      style={[styles.chip, stake === value && styles.chipOn]}>
      <Text style={[styles.chipText, stake === value && styles.chipTextOn]}>${value}</Text></Pressable>)}
    <TextInput value={text} placeholder={STAKES.includes(stake) ? 'Other' : `$${stake}`} placeholderTextColor={palette.muted}
      keyboardType="decimal-pad" maxLength={7} accessibilityLabel="Entry amount in dollars" style={styles.stakeInput}
      onChangeText={(value) => { const clean = value.replace(/[^0-9.]/g, ''); setText(clean); const amount = Number(clean); if (amount > 0) edgeStake.set(amount); }} />
  </View>;
}

export function SlipSummary({ slip, title }: { slip: EdgeSlip; title?: string }) {
  const stake = useEdgeStake();
  const dollars = slipDollars(slip, stake), profit = dollars.profit;
  // Each leg's own multiplier (an app's per-pick payout, or a parlay leg's odds) scales every payout.
  const boost = slip.legs.reduce((product, leg) => product * (leg.payoutMultiplier ?? 1), 1);
  return <View style={styles.summary}>
    <Text style={styles.label}>{title ?? `${slip.entry.size}-PICK ${slip.entry.type}`}</Text>
    {slip.legs.map((leg) => <Text key={leg.lineId} style={styles.leg}>
      {pct(leg.probability, 0)} · {leg.playerName} {leg.side} {formatLine(leg.threshold)} {marketLabel(leg.market)}
      {leg.payoutMultiplier && leg.payoutMultiplier !== 1 ? ` · ${leg.payoutMultiplier}×` : ''}</Text>)}
    <Text style={[styles.ev, { color: profit > 0 ? palette.green : palette.danger }]}>
      {usd(stake)} entry · expected back {usd(dollars.back)} ({profit >= 0 ? '+' : ''}{usd(profit)} on average)</Text>
    <Text style={styles.small}>All legs hit {pct(slip.allHitProbability)} · pays {dollars.payouts
      .map((payout) => `${payout.hits}/${slip.entry.size}: ${usd(payout.amount * boost)}`).join(', ')}</Text>
    {slip.warnings.map((warning) => <Text key={warning} style={styles.warning}>⚠ {warning}</Text>)}
  </View>;
}

export function EdgeSlipPanel({ entries }: { entries: readonly EdgeEntry[] }) {
  const { request } = useAuth();
  const legs = useEdgeSlip();
  const platform = useEdgePlatform();
  const types = [...new Set(entries.map((entry) => entry.type))];
  const [chosen, setType] = useState<'POWER' | 'FLEX' | 'PARLAY'>('POWER');
  const type = types.includes(chosen) ? chosen : types[0] ?? 'POWER';
  const [result, setResult] = useState<{ key: string; slip: EdgeSlip | null; message: string } | null>(null);
  const supported = entries.some((entry) => entry.type === type && entry.size === legs.length);
  const key = JSON.stringify([platform, type, legs.map((leg) => leg.lineId)]);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    void request('/v1/edge/slip', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform, type, lineIds: legs.map((leg) => leg.lineId) }) })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) { setResult({ key, slip: null, message: 'Could not price this slip; a line may have expired.' }); return; }
        setResult({ key, slip: edgeSlipSchema.parse((await response.json()).slip), message: '' });
      }).catch(() => { if (active) setResult({ key, slip: null, message: 'Could not price this slip.' }); });
    return () => { active = false; };
  }, [key, legs, request, supported, type, platform]);
  if (!legs.length) return null;
  const current = result?.key === key ? result : null;
  return <View style={styles.panel}>
    <View style={styles.header}>
      <Text style={styles.title}>MY SLIP · {legs.length} {legs.length === 1 ? 'LEG' : 'LEGS'}</Text>
      <Pressable accessibilityRole="button" onPress={() => edgeSlip.clear()}><Text style={styles.clear}>Clear</Text></Pressable>
    </View>
    <View style={styles.toggle}>{types.map((option) =>
      <Pressable key={option} accessibilityRole="button" onPress={() => setType(option)}
        style={[styles.chip, type === option && styles.chipOn]}>
        <Text style={[styles.chipText, type === option && styles.chipTextOn]}>{option === 'PARLAY' ? 'Parlay' : option === 'POWER'
          ? platform === 'underdog' ? 'Standard' : 'Power' : 'Flex'}</Text></Pressable>)}</View>
    <StakePicker />
    {!supported && <Text style={styles.small}>{legs.length < 2 ? 'Add at least 2 legs.'
      : `No ${legs.length}-pick ${type.toLowerCase()} payout table is configured.`}</Text>}
    {supported && !current && <Text style={styles.small}>Pricing slip…</Text>}
    {current?.slip && <SlipSummary slip={current.slip} title="EXPECTED VALUE" />}
    {current?.message ? <Text style={styles.warning}>{current.message}</Text> : null}
    <Text style={styles.small}>{isBook(platform) ? 'A parlay pays only if every leg wins; each leg also works as a single bet.'
      : `Payouts are ${platformLabel(platform)}’s chart as CrownIQ keeps it; confirm in the app.`} Same-game legs are correlated.</Text>
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
  stakeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  stakeInput: { minWidth: 64, borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4,
    color: palette.text, fontSize: 12, fontWeight: '800' },
  label: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  leg: { color: palette.text, fontSize: 13 },
  ev: { fontSize: 15, fontWeight: '900', marginTop: 2 },
  small: { color: palette.muted, fontSize: 11, lineHeight: 16 },
  warning: { color: palette.danger, fontSize: 11 },
});
