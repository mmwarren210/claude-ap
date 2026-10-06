import { edgeSlipSchema } from '@crowniq/contracts';
import type { EdgeEntry, EdgeSlip } from '@crowniq/contracts';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../auth';
import { formatLine, marketLabel, pct, slipDollars, usd } from '../edge-format';
import { edgeStake, STAKES, useEdgeStake } from '../edge-stake';
import { isBook, platformLabel, useEdgePlatform } from '../edge-platform';
import { edgeEntryType, useEdgeEntryType } from '../edge-entry-type';
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

export function SlipSummary({ slip, title, payoutsFinal }: { slip: EdgeSlip; title?: string; payoutsFinal?: boolean }) {
  const stake = useEdgeStake();
  const dollars = slipDollars(slip, stake), profit = dollars.profit;
  // Each leg's own multiplier (an app's per-pick payout, or a parlay leg's odds) scales every payout.
  // Payouts the member typed in already include them.
  const boost = payoutsFinal ? 1 : slip.legs.reduce((product, leg) => product * (leg.payoutMultiplier ?? 1), 1);
  return <View style={styles.summary}>
    <Text style={styles.label}>{title ?? `${slip.entry.size}-PICK ${slip.entry.type}`}</Text>
    {slip.legs.map((leg) => <Text key={leg.lineId} style={styles.leg}>
      {pct(leg.probability, 0)} · {leg.playerName} {leg.side} {formatLine(leg.threshold)} {marketLabel(leg.market)}
      {leg.payoutMultiplier && leg.payoutMultiplier !== 1 ? ` · ${leg.payoutMultiplier}×` : ''}</Text>)}
    <Text style={[styles.ev, { color: profit > 0 ? palette.green : palette.danger }]}>
      {usd(stake)} entry · expected back {usd(dollars.back)} ({profit >= 0 ? '+' : ''}{usd(profit)} on average)</Text>
    <Text style={styles.small}>All legs hit {pct(slip.allHitProbability)} · pays {dollars.payouts
      .map((payout) => `${payout.hits}/${slip.entry.size}: ${usd(payout.amount * boost)}`).join(', ')}</Text>
    {slip.correlationNote ? <Text style={styles.small}>🔗 {slip.correlationNote}</Text> : null}
    {slip.kellyFraction ? <Text style={styles.small}>Long-run sizing (Kelly): at most {pct(slip.kellyFraction)} of your bankroll on this entry.</Text> : null}
    {slip.suggestion ? <Text style={styles.tip}>💡 Swap {slip.suggestion.replacePlayerName} for {slip.suggestion.playerName} {slip.suggestion.side} {formatLine(slip.suggestion.threshold)} {marketLabel(slip.suggestion.market)} to add {usd(slip.suggestion.gain * stake)} expected ({pct(slip.suggestion.gain)} of the entry).</Text> : null}
    {slip.warnings.map((warning) => <Text key={warning} style={styles.warning}>⚠ {warning}</Text>)}
  </View>;
}

type Priced = { slip: EdgeSlip | null; message: string };
const typeLabel = (type: string, platform: string) => type === 'PARLAY' ? 'Parlay' : type === 'POWER'
  ? platform === 'underdog' ? 'Standard' : 'Power' : 'Flex';

/**
 * My slip: the member's own legs priced as every entry the app offers at this size (Power and Flex side by side), with the
 * better play called out. "Use my app's payouts" prices the chosen entry with the numbers the app shows for this exact ticket
 * (PrizePicks changes Flex payouts for Goblins, Demons and some picks), so the EV never rests on a guessed payout.
 */
export function EdgeSlipPanel({ entries }: { entries: readonly EdgeEntry[] }) {
  const { request } = useAuth();
  const legs = useEdgeSlip();
  const platform = useEdgePlatform();
  const stake = useEdgeStake();
  const sized = entries.filter((entry) => entry.size === legs.length);
  const types = [...new Set(entries.map((entry) => entry.type))];
  const chosen = useEdgeEntryType();
  const type = types.includes(chosen) ? chosen : types[0] ?? 'POWER';
  const entry = sized.find((item) => item.type === type);
  // Typed payouts per entry type and size: hits → text the member entered.
  const [typed, setTyped] = useState<Record<string, Record<string, string>>>({});
  const [ownOpen, setOwnOpen] = useState(false);
  const tableKey = `${platform}|${type}|${legs.length}`;
  const own = Object.fromEntries(Object.entries(typed[tableKey] ?? {}).map(([hits, text]) => [hits, Number(text)])
    .filter(([, value]) => Number.isFinite(value as number) && (value as number) > 0));
  const usingOwn = ownOpen && Object.keys(own).length > 0;
  const [results, setResults] = useState<{ key: string; byType: Record<string, Priced> } | null>(null);
  const key = JSON.stringify([platform, legs.map((leg) => leg.lineId), sized.map((item) => item.type), usingOwn ? [type, own] : null]);
  useEffect(() => {
    if (!sized.length) return;
    let active = true;
    void Promise.all(sized.map(async (item): Promise<[string, Priced]> => {
      try {
        const response = await request('/v1/edge/slip', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform, type: item.type, lineIds: legs.map((leg) => leg.lineId),
            ...(usingOwn && item.type === type ? { payouts: own } : {}) }) });
        if (!response.ok) return [item.type, { slip: null, message: 'Could not price this slip; a line may have expired.' }];
        return [item.type, { slip: edgeSlipSchema.parse((await response.json()).slip), message: '' }];
      } catch { return [item.type, { slip: null, message: 'Could not price this slip.' }]; }
    })).then((pairs) => { if (active) setResults({ key, byType: Object.fromEntries(pairs) }); });
    return () => { active = false; };
    // `key` captures every input that changes the price.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, request]);
  if (!legs.length) return null;
  const current = results?.key === key ? results.byType : null;
  const priced = current ? sized.map((item) => ({ type: item.type, slip: current[item.type]?.slip ?? null })).filter((item) => item.slip) : [];
  const best = priced.length > 1 ? [...priced].sort((a, b) => b.slip!.expectedReturn - a.slip!.expectedReturn)[0] : null;
  const chosenResult = current?.[type] ?? null;
  const altLegs = legs.some((leg) => leg.platform === 'prizepicks' && (leg.lineType === 'GOBLIN' || leg.lineType === 'DEMON'));
  const hits = entry ? Object.keys(entry.payouts).map(Number).sort((a, b) => b - a) : [];
  const setTyped1 = (hit: number, text: string) => setTyped((all) => ({ ...all,
    [tableKey]: { ...all[tableKey], [String(hit)]: text.replace(/[^0-9.]/g, '') } }));
  return <View style={styles.panel}>
    <View style={styles.header}>
      <Text style={styles.title}>MY SLIP · {legs.length} {legs.length === 1 ? 'LEG' : 'LEGS'}</Text>
      <Pressable accessibilityRole="button" onPress={() => edgeSlip.clear()}><Text style={styles.clear}>Clear</Text></Pressable>
    </View>
    <View style={styles.toggle}>{types.map((option) =>
      <Pressable key={option} accessibilityRole="button" onPress={() => edgeEntryType.set(option)}
        style={[styles.chip, type === option && styles.chipOn]}>
        <Text style={[styles.chipText, type === option && styles.chipTextOn]}>{typeLabel(option, platform)}</Text></Pressable>)}</View>
    <StakePicker />
    {legs.length < 2 && <Text style={styles.small}>Add at least 2 legs.</Text>}
    {legs.length >= 2 && !sized.length && <Text style={styles.small}>No {legs.length}-pick payout table is configured.</Text>}
    {sized.length > 0 && !current && <Text style={styles.small}>Pricing slip…</Text>}
    {priced.length > 1 && <View style={styles.compare}>
      <Text style={styles.label}>SAME LEGS, EACH WAY TO PLAY</Text>
      {priced.map((item) => <Pressable key={item.type} accessibilityRole="button" onPress={() => edgeEntryType.set(item.type)}
        style={[styles.compareRow, item.type === type && styles.compareRowOn]}>
        <Text style={styles.compareName}>{typeLabel(item.type, platform)}{best?.type === item.type ? ' ★' : ''}</Text>
        <Text style={[styles.compareValue, { color: item.slip!.expectedReturn > 1 ? palette.green : palette.text }]}>
          expected back {usd(item.slip!.expectedReturn * stake)}{item.type === type && usingOwn ? ' (your payouts)' : ''}</Text>
      </Pressable>)}
      {best && <Text style={styles.small}>★ {typeLabel(best.type, platform)} returns more on average with these legs
        {best.type === 'FLEX' ? ', and still pays if one leg misses.' : best.type === 'POWER' ? ', but every leg has to hit.' : '.'}</Text>}
    </View>}
    {entry && type !== 'PARLAY' && <>
      <Pressable accessibilityRole="button" onPress={() => setOwnOpen((open) => !open)}>
        <Text style={styles.link}>{ownOpen ? '▾' : '▸'} Use my app&apos;s payouts for this ticket</Text></Pressable>
      {ownOpen && <View style={styles.ownBox}>
        <Text style={styles.small}>Type the payouts {platformLabel(platform)} shows for this exact ticket, as multiples of your entry
          (a $10 entry paying $300 is 30). Leave a box empty to use the chart.</Text>
        <View style={styles.ownRow}>{hits.map((hit) => <View key={hit} style={styles.ownCell}>
          <Text style={styles.label}>{hit}/{legs.length} HIT</Text>
          <TextInput value={typed[tableKey]?.[String(hit)] ?? ''} placeholder={`${entry.payouts[String(hit)]}×`}
            placeholderTextColor={palette.muted} keyboardType="decimal-pad" maxLength={7}
            accessibilityLabel={`Payout when ${hit} of ${legs.length} hit`} style={styles.stakeInput}
            onChangeText={(text) => setTyped1(hit, text)} />
        </View>)}</View>
      </View>}
      {!usingOwn && type === 'FLEX' && altLegs && <Text style={styles.small}>This ticket has a Goblin or Demon. PrizePicks changes Flex
        payouts for those, so use your app&apos;s payouts above for an exact number.</Text>}
    </>}
    {chosenResult?.slip && <SlipSummary slip={chosenResult.slip} payoutsFinal={usingOwn} title={usingOwn ? 'EXPECTED VALUE · YOUR PAYOUTS' : 'EXPECTED VALUE'} />}
    {chosenResult?.message ? <Text style={styles.warning}>{chosenResult.message}</Text> : null}
    <Text style={styles.small}>{isBook(platform) ? 'A parlay pays only if every leg wins; each leg also works as a single bet.'
      : usingOwn ? 'Priced with the payouts you entered.' : `Payouts are ${platformLabel(platform)}’s chart as CrownIQ keeps it; confirm in the app.`} Same-game legs are priced with CrownIQ’s prior correlations.</Text>
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
  tip: { color: palette.green, fontSize: 12, fontWeight: '700', lineHeight: 17 },
  link: { color: palette.green, fontSize: 12, fontWeight: '800' },
  compare: { gap: 6 },
  compareRow: { flexDirection: 'row', justifyContent: 'space-between', borderWidth: 1, borderColor: palette.border, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 8 },
  compareRowOn: { borderColor: palette.green, backgroundColor: palette.greenDim },
  compareName: { color: palette.text, fontSize: 13, fontWeight: '900' },
  compareValue: { fontSize: 13, fontWeight: '800' },
  ownBox: { gap: 6 },
  ownRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  ownCell: { gap: 3 },
});
