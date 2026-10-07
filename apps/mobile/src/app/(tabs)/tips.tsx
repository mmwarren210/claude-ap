import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { openExternal } from '../../port';
import { useAuth } from '../../auth';
import { StakePicker } from '../../components/EdgeSlipPanel';
import { Notice, Screen } from '../../components/Screen';
import { useEdgeStake } from '../../edge-stake';
import { palette } from '../../theme';
import { formatOdds, slipSummary, slipText } from '../../tips-slip';
import type { SlipLeg } from '../../tips-slip';

// Tips: picks from the services you pay for. Upload a screenshot (or paste the text) and CrownIQ reads every pick, checks it
// against the market and the news, and says what it thinks: Play, Lean, Pass or Fade, with its chance, fair odds and EV.
// Add picks to the slip to play them as singles or a parlay. Results are graded after the games, with a record per service.
// Display-only: tips never change CrownIQ's own scores.

type Status = 'PENDING' | 'WON' | 'LOST' | 'PUSH' | 'VOID';
type Verdict = 'PLAY' | 'LEAN' | 'PASS' | 'FADE';
type Analysis = { verdict: Verdict; chance: number; chanceSource: 'Pinnacle' | 'Claude'; price: number | null; priceSource: string | null;
  ev: number | null; fairOdds: number; reasons: string[]; event: string | null; start: string | null };
type Tip = { id: string; source: string; createdAt: string; text: string; sport: string | null; selection: string; market: string;
  line: number | null; side: string | null; odds: number | null; status: Status; result: string | null;
  market_read: { chance: number; event: string; start: string } | null; analysis?: Analysis | null; analyzing?: boolean };
type ServiceRecord = { picks: number; pending: number; won: number; lost: number; push: number; hitRate: number | null;
  units: number | null; unitsPicks: number; vsMarket: number | null; marketPicks: number };
type Data = { tips: Tip[]; sources: { [source: string]: ServiceRecord }; reading: boolean };

const pct = (value: number) => `${Math.round(value * 100)}%`;
const verdictColor: { [verdict in Verdict]: string } = { PLAY: palette.green, LEAN: palette.green, PASS: palette.muted, FADE: palette.danger };
const statusColor: { [status in Status]: string } = { PENDING: palette.muted, WON: palette.green, LOST: palette.danger, PUSH: palette.muted, VOID: palette.muted };
const books = [{ name: 'DraftKings', url: 'https://sportsbook.draftkings.com' }, { name: 'FanDuel', url: 'https://sportsbook.fanduel.com' },
  { name: 'Hard Rock', url: 'https://app.hardrock.bet' }];

/**
 * Picks an image on the web and shrinks it to at most 1600px as JPEG, returning base64 without the data: prefix. Null when
 * nothing was chosen; an Error saying what went wrong when the picture can't be opened.
 */
function pickImage(): Promise<{ data: string; mediaType: 'image/jpeg' } | null> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') { reject(new Error('Adding a picture works in the web app (open CrownIQ in Safari).')); return; }
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const image = new window.Image();
        image.onload = () => {
          const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
          const context = canvas.getContext('2d');
          if (!context) { reject(new Error('This browser couldn’t prepare the picture. Paste the text instead.')); return; }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL('image/jpeg', .85).split(',')[1] ?? '';
          if (data.length < 100) { reject(new Error('That picture came out empty. Try a screenshot instead.')); return; }
          resolve({ data, mediaType: 'image/jpeg' });
        };
        image.onerror = () => reject(new Error('That picture’s format couldn’t be opened. Try a screenshot (PNG or JPEG).'));
        image.src = String(reader.result);
      };
      reader.onerror = () => reject(new Error('Couldn’t read that file from your phone. Try again.'));
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

const slipLeg = (tip: Tip): SlipLeg | null => tip.analysis ? { id: tip.id, label: tip.text, chance: tip.analysis.chance,
  price: tip.analysis.price, fairOdds: tip.analysis.fairOdds, event: tip.analysis.event } : null;

export default function TipsScreen() {
  const { request } = useAuth();
  const stake = useEdgeStake();
  const [data, setData] = useState<Data | null | 'error'>(null);
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [slip, setSlip] = useState<string[]>([]);
  const [mode, setMode] = useState<'SINGLES' | 'PARLAY'>('PARLAY');
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    const response = await request('/v1/tips').catch(() => null);
    setData(response?.ok ? await response.json() as Data : 'error');
  }, [request]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  // While CrownIQ is still analyzing an upload, refresh every few seconds.
  const analyzing = !!data && data !== 'error' && data.tips.some((tip) => tip.analyzing);
  useEffect(() => {
    if (!analyzing) return;
    const timer = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(timer);
  }, [analyzing, load]);

  const upload = async (body: { image?: { data: string; mediaType: string }; text?: string }) => {
    setBusy(true); setMessage('');
    try {
      const response = await request('/v1/tips/upload', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, ...(source.trim() ? { source: source.trim() } : {}) }) });
      if (response.ok) {
        const added = await response.json() as { source: string; tips: Tip[] };
        setMessage(`Read ${added.tips.length} picks from ${added.source}. CrownIQ is checking them now…`); setText(''); await load();
      } else {
        const code = (await response.json().catch(() => null) as { code?: string } | null)?.code;
        setMessage(response.status === 422 ? 'No picks found in that.' : response.status === 429 ? 'Daily upload limit reached (30).'
          : code === 'AI_CREDITS_EXHAUSTED' ? 'CrownIQ’s AI is out of credits right now, so it can’t read picks. The owner needs to top up the Claude account.'
          : response.status === 503 ? 'Reading screenshots isn’t set up on the server yet.'
          : response.status === 400 ? 'The server turned that picture down (format or size). Try a screenshot, or paste the text.'
          : `Could not read that (error ${response.status}). Try again or paste the text.`);
      }
    } catch { setMessage('Could not upload. Check your connection.'); }
    finally { setBusy(false); }
  };
  const change = async (tip: Tip, body: { status?: Status } | null) => {
    await request(`/v1/tips/${tip.id}`, body ? { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'DELETE' }).catch(() => null);
    if (!body) setSlip((ids) => ids.filter((id) => id !== tip.id));
    await load();
  };
  const recheck = async (ids: string[]) => {
    await request('/v1/tips/recheck', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) }).catch(() => null);
    await load();
  };

  const tips = data && data !== 'error' ? data.tips : [];
  const legs = slip.map((id) => tips.find((tip) => tip.id === id)).filter((tip): tip is Tip => !!tip).map(slipLeg)
    .filter((leg): leg is SlipLeg => !!leg);
  const summary = legs.length ? slipSummary(legs, legs.length > 1 ? mode : 'SINGLES', stake) : null;
  const copy = async () => {
    if (!summary || typeof navigator === 'undefined' || !navigator.clipboard) return;
    await navigator.clipboard.writeText(slipText(legs, summary)).catch(() => undefined);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  const web = Platform.OS === 'web' && typeof document !== 'undefined';
  const pending = tips.filter((tip) => tip.status === 'PENDING');
  const settled = tips.filter((tip) => tip.status !== 'PENDING');

  return <Screen eyebrow="TIPS" title="Tip check">
    <Text style={styles.muted}>Upload picks from a service you pay for. CrownIQ reads them, checks each against the market and the news,
      and tells you what it thinks. Add the good ones to your slip and play them. Every service gets a record as games finish.</Text>
    <View style={styles.card}>
      <TextInput value={source} onChangeText={setSource} placeholder="Service name (optional; read from the post)" maxLength={60}
        placeholderTextColor={palette.muted} style={styles.input} />
      {web && <Pressable accessibilityRole="button" disabled={busy} style={styles.button}
        onPress={() => void pickImage().then((image) => image?.data ? upload({ image }) : undefined)
          .catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Couldn’t open that picture.'))}>
        {busy ? <ActivityIndicator color={palette.background} /> : <Text style={styles.buttonText}>📷 Upload a screenshot</Text>}
      </Pressable>}
      <TextInput value={text} onChangeText={setText} multiline placeholder="…or paste the picks here" maxLength={4000}
        placeholderTextColor={palette.muted} style={[styles.input, styles.area]} />
      <Pressable accessibilityRole="button" disabled={busy || text.trim().length < 2} onPress={() => void upload({ text: text.trim() })}
        style={[styles.secondary, (busy || text.trim().length < 2) && styles.disabled]}><Text style={styles.link}>Check pasted picks</Text></Pressable>
      {message ? <Text style={styles.small}>{message}</Text> : null}
    </View>

    {summary && <View style={[styles.card, styles.slip]}>
      <View style={styles.row}><Text style={[styles.title, styles.flex]}>MY SLIP · {legs.length} {legs.length === 1 ? 'PICK' : 'PICKS'}</Text>
        <Pressable accessibilityRole="button" onPress={() => setSlip([])}><Text style={styles.small}>Clear</Text></Pressable></View>
      {legs.length > 1 && <View style={styles.row}>{(['PARLAY', 'SINGLES'] as const).map((option) =>
        <Pressable key={option} accessibilityRole="button" onPress={() => setMode(option)} style={[styles.chip, mode === option && styles.chipOn]}>
          <Text style={[styles.chipText, mode === option && styles.chipTextOn]}>{option === 'PARLAY' ? 'Parlay' : 'Singles'}</Text></Pressable>)}</View>}
      {legs.map((leg) => <Text key={leg.id} style={styles.text}>• {leg.label} · {leg.price !== null ? formatOdds(leg.price) : `fair ${formatOdds(leg.fairOdds)}`} · {pct(leg.chance)}</Text>)}
      <StakePicker />
      {summary.mode === 'PARLAY'
        ? <Text style={styles.big}>${summary.stake} at {summary.odds !== null ? formatOdds(summary.odds) : '—'} pays ${summary.payout.toFixed(2)} · hits {pct(summary.chance ?? 0)}</Text>
        : <Text style={styles.big}>${summary.stake} on each (${summary.risk.toFixed(2)} total) · ${summary.payout.toFixed(2)} back if all win</Text>}
      <Text style={[styles.text, { color: summary.expectedProfit >= 0 ? palette.green : palette.danger }]}>
        Expected {summary.expectedProfit >= 0 ? '+' : '−'}${Math.abs(summary.expectedProfit).toFixed(2)} on average by CrownIQ&apos;s chances</Text>
      {summary.unpriced > 0 && <Text style={styles.small}>⚠ {summary.unpriced} pick{summary.unpriced > 1 ? 's have' : ' has'} no price found yet, so fair odds are used: check the book&apos;s price.</Text>}
      {summary.sameGame && <Text style={styles.small}>⚠ Two picks are from the same game; books may not allow that parlay, and the chance is approximate.</Text>}
      <View style={styles.row}>
        <Pressable accessibilityRole="button" onPress={() => void copy()} style={styles.chip}><Text style={styles.chipText}>{copied ? 'Copied ✓' : 'Copy slip'}</Text></Pressable>
        {books.map((book) => <Pressable key={book.name} accessibilityRole="button" onPress={() => openExternal(book.url)} style={styles.chip}>
          <Text style={styles.chipText}>Open {book.name}</Text></Pressable>)}
      </View>
      <Text style={styles.small}>Books don&apos;t let other apps fill in your bet slip, so copy it and place the bets in the book.</Text>
    </View>}

    {data === null && <Notice title="Loading" detail="Reading your tips." />}
    {data === 'error' && <Notice title="Tips unavailable" detail="Try again in a minute." />}
    {data && data !== 'error' && tips.length === 0 && <Notice title="No tips yet" detail="Upload a screenshot from a service to get CrownIQ's take." />}

    {pending.length > 0 && <Text style={styles.section}>UPCOMING · CROWNIQ&apos;S TAKE</Text>}
    {pending.map((tip) => <TipCard key={tip.id} tip={tip} inSlip={slip.includes(tip.id)}
      onSlip={() => setSlip((ids) => ids.includes(tip.id) ? ids.filter((id) => id !== tip.id) : [...ids, tip.id])}
      onRecheck={() => void recheck([tip.id])} onStatus={(status) => void change(tip, { status })} onRemove={() => void change(tip, null)} />)}

    {data && data !== 'error' && Object.keys(data.sources).length > 0 && <Text style={styles.section}>SERVICE RECORDS</Text>}
    {data && data !== 'error' && Object.entries(data.sources).map(([name, record]) => <View key={name} style={styles.card}>
      <Text style={styles.title}>{name}</Text>
      <Text style={styles.text}>{record.won}–{record.lost}{record.push ? `–${record.push}` : ''}{record.hitRate !== null ? ` · ${pct(record.hitRate)} hit` : ''}
        {record.units !== null ? ` · ${record.units >= 0 ? '+' : ''}${record.units}u on ${record.unitsPicks} with odds` : ''}
        {record.pending ? ` · ${record.pending} pending` : ''}</Text>
      {record.vsMarket !== null && <Text style={styles.small}>{record.vsMarket >= 0 ? '+' : ''}{record.vsMarket} wins vs what the market expected on {record.marketPicks} picks
        {record.vsMarket > 0 ? ' (beating the market so far)' : ' (not beating the market so far)'}</Text>}
    </View>)}

    {settled.length > 0 && <Text style={styles.section}>SETTLED</Text>}
    {settled.slice(0, 50).map((tip) => <TipCard key={tip.id} tip={tip} inSlip={false} onSlip={null} onRecheck={null}
      onStatus={(status) => void change(tip, { status })} onRemove={() => void change(tip, null)} />)}
  </Screen>;
}

function TipCard({ tip, inSlip, onSlip, onRecheck, onStatus, onRemove }: { tip: Tip; inSlip: boolean; onSlip: (() => void) | null;
  onRecheck: (() => void) | null; onStatus: (status: Status) => void; onRemove: () => void }) {
  const analysis = tip.analysis;
  return <View style={styles.card}>
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text style={styles.pick}>{tip.text}{tip.odds !== null ? ` (${formatOdds(tip.odds)})` : ''}</Text>
        <Text style={styles.small}>{tip.source}{analysis?.event ? ` · ${analysis.event}` : ''}{analysis?.start ? ` · ${new Date(analysis.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}</Text>
      </View>
      {tip.status !== 'PENDING' ? <Text style={[styles.badge, { color: statusColor[tip.status], borderColor: statusColor[tip.status] }]}>{tip.status}</Text>
        : analysis ? <Text style={[styles.badge, { color: verdictColor[analysis.verdict], borderColor: verdictColor[analysis.verdict] }]}>{analysis.verdict}</Text> : null}
    </View>
    {tip.analyzing && <View style={styles.row}><ActivityIndicator size="small" color={palette.green} /><Text style={styles.small}>CrownIQ is checking odds and news…</Text></View>}
    {analysis && <>
      <Text style={styles.text}>{pct(analysis.chance)} to win ({analysis.chanceSource === 'Pinnacle' ? 'Pinnacle, no vig' : 'CrownIQ estimate'}) · fair {formatOdds(analysis.fairOdds)}
        {analysis.price !== null ? ` · best ${formatOdds(analysis.price)} (${analysis.priceSource})` : ' · no price found'}</Text>
      {analysis.ev !== null && <Text style={[styles.text, styles.bold, { color: analysis.ev >= 0 ? palette.green : palette.danger }]}>
        EV {analysis.ev >= 0 ? '+' : ''}{(analysis.ev * 100).toFixed(1)}% at that price</Text>}
      {analysis.reasons.map((reason) => <Text key={reason} style={styles.small}>• {reason}</Text>)}
    </>}
    {!tip.analyzing && !analysis && tip.status === 'PENDING' && <Text style={styles.small}>No take yet: tap Re-check.</Text>}
    {tip.result && <Text style={styles.small}>{tip.result}</Text>}
    <View style={styles.actions}>
      {onSlip && analysis && <Pressable accessibilityRole="button" onPress={onSlip}><Text style={[styles.action, inSlip && styles.actionOn]}>{inSlip ? '✓ In slip' : '+ Slip'}</Text></Pressable>}
      {onRecheck && !tip.analyzing && <Pressable accessibilityRole="button" onPress={onRecheck}><Text style={styles.action}>Re-check</Text></Pressable>}
      {(['WON', 'LOST', 'PUSH'] as const).map((status) => <Pressable key={status} accessibilityRole="button"
        onPress={() => onStatus(tip.status === status ? 'PENDING' : status)}>
        <Text style={[styles.action, tip.status === status && styles.actionOn]}>{status === 'WON' ? 'Won' : status === 'LOST' ? 'Lost' : 'Push'}</Text></Pressable>)}
      <Pressable accessibilityRole="button" onPress={onRemove}><Text style={styles.action}>Remove</Text></Pressable>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  link: { color: palette.green, fontSize: 13, fontWeight: '800' },
  muted: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  small: { color: palette.muted, fontSize: 11, lineHeight: 16 },
  text: { color: palette.text, fontSize: 13, lineHeight: 19 },
  bold: { fontWeight: '800' },
  pick: { color: palette.text, fontSize: 15, fontWeight: '800' },
  big: { color: palette.text, fontSize: 14, fontWeight: '900' },
  title: { color: palette.green, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  section: { color: palette.green, fontSize: 11, fontWeight: '900', letterSpacing: 1.3, marginTop: 6 },
  card: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 18, padding: 14, gap: 6 },
  slip: { borderColor: palette.green },
  input: { borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, color: palette.text, fontSize: 13 },
  area: { minHeight: 80, textAlignVertical: 'top' },
  button: { backgroundColor: palette.green, borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
  buttonText: { color: palette.background, fontSize: 14, fontWeight: '900' },
  secondary: { borderWidth: 1, borderColor: palette.green, borderRadius: 12, paddingVertical: 9, alignItems: 'center' },
  disabled: { opacity: .4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  flex: { flex: 1, gap: 2 },
  badge: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, fontSize: 11, fontWeight: '900', overflow: 'hidden' },
  chip: { borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 },
  chipOn: { backgroundColor: palette.greenDim, borderColor: palette.green },
  chipText: { color: palette.muted, fontSize: 12, fontWeight: '800' },
  chipTextOn: { color: palette.green },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 2 },
  action: { color: palette.muted, fontSize: 12, fontWeight: '700' },
  actionOn: { color: palette.green },
});
