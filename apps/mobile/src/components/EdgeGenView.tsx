import { edgeGenResponseSchema, edgePickSchema } from '@crowniq/contracts';
import type { EdgeEntry, EdgeGenResponse, EdgePick, EdgeSlip } from '@crowniq/contracts';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { dayWindow, pct } from '../edge-format';
import { chosenDay, gameDays } from '../game-days';
import { edgeSlip } from '../edge-slip';
import { palette } from '../theme';
import { SlipSummary } from './EdgeSlipPanel';
import { DayPicker } from './ui/DayPicker';
import { Notice } from './Screen';

/** Edge Gen: build entries from Edge's own +EV reads only. */
export function EdgeGenView({ entries, sports, nowMs, starts }: { entries: readonly EdgeEntry[]; sports: readonly string[];
  nowMs: number; starts: readonly string[] }) {
  const { request } = useAuth();
  const [type, setType] = useState<'POWER' | 'FLEX'>('POWER');
  const [size, setSize] = useState(3);
  const [count, setCount] = useState(3);
  const [sport, setSport] = useState<string | null>(null);
  // The game day to build from (today, else the soonest day with games; "All days" turns it off).
  const [picked, setPicked] = useState<string | null>(null);
  const days = gameDays(starts, nowMs), day = chosenDay(picked, days, nowMs);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ data: EdgeGenResponse | null; message: string } | null>(null);
  const sizes = entries.filter((entry) => entry.type === type).map((entry) => entry.size).sort((a, b) => a - b);
  const entry = entries.find((item) => item.type === type && item.size === size);
  const generate = async () => {
    setBusy(true);
    try {
      const response = await request('/v1/edge/gen', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, size, count, ...(sport ? { sport } : {}), ...dayWindow(day) }) });
      if (!response.ok) { setResult({ data: null, message: response.status === 422 ? 'That entry size has no payout table configured.' : 'Could not generate entries.' }); return; }
      setResult({ data: edgeGenResponseSchema.parse(await response.json()), message: '' });
    } catch { setResult({ data: null, message: 'Could not generate entries.' }); }
    finally { setBusy(false); }
  };
  const loadEntry = async (slip: EdgeSlip) => {
    const picks = await Promise.all(slip.legs.map(async (leg) => {
      const response = await request('/v1/edge/line/' + encodeURIComponent(leg.lineId));
      return response.ok ? edgePickSchema.parse((await response.json()).pick) : null;
    }));
    edgeSlip.set(picks.filter((pick): pick is EdgePick => !!pick));
  };
  return <View style={styles.wrap}>
    <Text style={styles.intro}>Builds entries from Edge&apos;s own +EV reads: one leg per player, at most two per game, at least two games, and no leg reused across entries.</Text>
    <Label text="ENTRY" />
    <Chips options={[{ key: 'POWER', label: 'Power' }, { key: 'FLEX', label: 'Flex' }]} value={type}
      onChange={(value) => { setType(value); if (!entries.some((item) => item.type === value && item.size === size)) setSize(entries.find((item) => item.type === value)?.size ?? 2); }} />
    <Chips options={sizes.map((value) => ({ key: value, label: `${value} picks` }))} value={size} onChange={setSize} />
    {entry && <Text style={styles.muted}>Pays {Object.entries(entry.payouts).sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([hits, payout]) => `${hits}/${entry.size}: ${payout}×`).join(', ')} · each leg needs {pct(entry.breakEven)} to break even</Text>}
    <Label text="HOW MANY" />
    <Chips options={[1, 2, 3, 5].map((value) => ({ key: value, label: String(value) }))} value={count} onChange={setCount} />
    <Label text="WHEN" />
    <DayPicker days={days} day={day} nowMs={nowMs} onChange={setPicked} />
    {sports.length > 1 && <><Label text="SPORT" />
      <Chips options={[{ key: null, label: 'All' }, ...sports.map((item) => ({ key: item, label: item }))]} value={sport} onChange={setSport} /></>}
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void generate()} style={styles.button}>
      {busy ? <ActivityIndicator color={palette.background} /> : <Text style={styles.buttonText}>Generate Edge entries</Text>}
    </Pressable>
    {result?.message ? <Notice title="Unavailable" detail={result.message} /> : null}
    {result?.data && <>
      {result.data.slips.map((slip, index) => <View key={slip.legs.map((leg) => leg.lineId).join()} style={styles.card}>
        <SlipSummary slip={slip} title={`ENTRY ${index + 1} · ${slip.entry.size}-PICK ${slip.entry.type}`} />
        <Pressable accessibilityRole="button" onPress={() => void loadEntry(slip)}><Text style={styles.link}>Load into my slip</Text></Pressable>
      </View>)}
      {result.data.notes.map((note) => <Text key={note} style={styles.muted}>{note}</Text>)}
    </>}
  </View>;
}

function Label({ text }: { text: string }) { return <Text style={styles.label}>{text}</Text>; }

function Chips<T extends string | number | null>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return <View style={styles.chips}>{options.map((option) => <Pressable key={String(option.key)} accessibilityRole="button"
    onPress={() => onChange(option.key)} style={[styles.chip, value === option.key && styles.chipOn]}>
    <Text style={[styles.chipText, value === option.key && styles.chipTextOn]}>{option.label}</Text></Pressable>)}</View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  intro: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  label: { color: palette.green, fontSize: 10, fontWeight: '900', letterSpacing: 1.3, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  chipOn: { backgroundColor: palette.greenDim, borderColor: palette.green },
  chipText: { color: palette.muted, fontSize: 12, fontWeight: '800' },
  chipTextOn: { color: palette.green },
  muted: { color: palette.muted, fontSize: 11, lineHeight: 16 },
  button: { backgroundColor: palette.green, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  buttonText: { color: palette.background, fontSize: 15, fontWeight: '900' },
  card: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 18, padding: 16, gap: 10 },
  link: { color: palette.green, fontSize: 13, fontWeight: '800' },
});
