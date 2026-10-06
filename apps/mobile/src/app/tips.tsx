import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../auth';
import { Notice, Screen } from '../components/Screen';
import { palette } from '../theme';

// Tips: picks from the services you pay for. Upload a screenshot (or paste the text), Claude reads the picks, and each
// service gets its own record once the games are graded. Display-only: tips never change CrownIQ's scores.

type Status = 'PENDING' | 'WON' | 'LOST' | 'PUSH' | 'VOID';
type Tip = { id: string; source: string; createdAt: string; text: string; sport: string | null; selection: string; market: string;
  line: number | null; side: string | null; odds: number | null; status: Status; result: string | null;
  market_read: { chance: number; event: string; start: string } | null };
type Record = { picks: number; pending: number; won: number; lost: number; push: number; hitRate: number | null;
  units: number | null; unitsPicks: number; vsMarket: number | null; marketPicks: number };
type Data = { tips: Tip[]; sources: { [source: string]: Record }; reading: boolean };

const pct = (value: number) => `${Math.round(value * 100)}%`;
const statusColor: { [status in Status]: string } = { PENDING: palette.muted, WON: palette.green, LOST: palette.danger, PUSH: palette.muted, VOID: palette.muted };

/** Picks an image on the web and shrinks it to at most 1600px as JPEG, returning base64 without the data: prefix. */
function pickImage(): Promise<{ data: string; mediaType: 'image/jpeg' } | null> {
  return new Promise((resolve) => {
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
          canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve({ data: canvas.toDataURL('image/jpeg', .85).split(',')[1] ?? '', mediaType: 'image/jpeg' });
        };
        image.onerror = () => resolve(null);
        image.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

export default function TipsScreen() {
  const { request } = useAuth();
  const [data, setData] = useState<Data | null | 'error'>(null);
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    const response = await request('/v1/tips').catch(() => null);
    setData(response?.ok ? await response.json() as Data : 'error');
  }, [request]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const upload = async (body: { image?: { data: string; mediaType: string }; text?: string }) => {
    setBusy(true); setMessage('');
    try {
      const response = await request('/v1/tips/upload', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, ...(source.trim() ? { source: source.trim() } : {}) }) });
      if (response.ok) {
        const added = await response.json() as { source: string; tips: Tip[] };
        setMessage(`Added ${added.tips.length} picks from ${added.source}.`); setText(''); await load();
      } else setMessage(response.status === 422 ? 'No picks found in that.' : response.status === 429 ? 'Daily upload limit reached (30).'
        : response.status === 503 ? 'Reading screenshots isn’t set up on the server yet.' : 'Could not read that. Try again or paste the text.');
    } catch { setMessage('Could not upload. Check your connection.'); }
    finally { setBusy(false); }
  };
  const change = async (tip: Tip, body: { status?: Status } | null) => {
    await request(`/v1/tips/${tip.id}`, body ? { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'DELETE' }).catch(() => null);
    await load();
  };

  const web = Platform.OS === 'web' && typeof document !== 'undefined';
  return <Screen eyebrow="TIPS" title="My services">
    <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.link}>← Back</Text></Pressable>
    <Text style={styles.muted}>Add picks from the services you pay for. CrownIQ reads them, grades them after the games, and keeps a record
      for each service, so you can see who&apos;s actually winning. Tips never change CrownIQ&apos;s own scores.</Text>
    <View style={styles.card}>
      <TextInput value={source} onChangeText={setSource} placeholder="Service name (optional; read from the post)" maxLength={60}
        placeholderTextColor={palette.muted} style={styles.input} />
      {web && <Pressable accessibilityRole="button" disabled={busy} style={styles.button}
        onPress={() => void pickImage().then((image) => image?.data ? upload({ image }) : undefined)}>
        {busy ? <ActivityIndicator color={palette.background} /> : <Text style={styles.buttonText}>📷 Upload a screenshot</Text>}
      </Pressable>}
      <TextInput value={text} onChangeText={setText} multiline placeholder="…or paste the picks here" maxLength={4000}
        placeholderTextColor={palette.muted} style={[styles.input, styles.area]} />
      <Pressable accessibilityRole="button" disabled={busy || text.trim().length < 2} onPress={() => void upload({ text: text.trim() })}
        style={[styles.secondary, (busy || text.trim().length < 2) && styles.disabled]}><Text style={styles.link}>Add pasted picks</Text></Pressable>
      {message ? <Text style={styles.small}>{message}</Text> : null}
    </View>
    {data === null && <Notice title="Loading" detail="Reading your tips." />}
    {data === 'error' && <Notice title="Tips unavailable" detail="Try again in a minute." />}
    {data && data !== 'error' && (data.tips.length === 0 ? <Notice title="No tips yet" detail="Upload a screenshot from a service to start its record." />
      : Object.entries(data.sources).map(([name, record]) => <View key={name} style={styles.card}>
        <Text style={styles.title}>{name}</Text>
        <Text style={styles.text}>{record.won}–{record.lost}{record.push ? `–${record.push}` : ''}{record.hitRate !== null ? ` · ${pct(record.hitRate)} hit` : ''}
          {record.units !== null ? ` · ${record.units >= 0 ? '+' : ''}${record.units}u on ${record.unitsPicks} with odds` : ''}
          {record.pending ? ` · ${record.pending} pending` : ''}</Text>
        {record.vsMarket !== null && <Text style={styles.small}>
          {record.vsMarket >= 0 ? '+' : ''}{record.vsMarket} wins vs what Pinnacle expected on {record.marketPicks} picks
          {record.vsMarket > 0 ? ' (beating the market so far)' : ' (not beating the market so far)'}</Text>}
        {data.tips.filter((tip) => tip.source === name).map((tip) => <View key={tip.id} style={styles.tip}>
          <View style={styles.tipHead}>
            <Text style={[styles.text, styles.flex]}>{tip.text}{tip.odds !== null ? ` (${tip.odds > 0 ? '+' : ''}${tip.odds})` : ''}</Text>
            <Text style={[styles.status, { color: statusColor[tip.status] }]}>{tip.status === 'PENDING' ? 'Pending' : tip.status}</Text>
          </View>
          {tip.market_read && <Text style={styles.small}>{tip.market_read.event} · Pinnacle gives it {pct(tip.market_read.chance)}</Text>}
          {tip.result && <Text style={styles.small}>{tip.result}</Text>}
          <View style={styles.actions}>
            {(['WON', 'LOST', 'PUSH'] as const).map((status) => <Pressable key={status} accessibilityRole="button"
              onPress={() => void change(tip, { status: tip.status === status ? 'PENDING' : status })}>
              <Text style={[styles.action, tip.status === status && styles.actionOn]}>{status === 'WON' ? 'Won' : status === 'LOST' ? 'Lost' : 'Push'}</Text></Pressable>)}
            <Pressable accessibilityRole="button" onPress={() => void change(tip, null)}><Text style={styles.action}>Remove</Text></Pressable>
          </View>
        </View>)}
      </View>))}
  </Screen>;
}

const styles = StyleSheet.create({
  link: { color: palette.green, fontSize: 13, fontWeight: '800' },
  muted: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  small: { color: palette.muted, fontSize: 11, lineHeight: 16 },
  text: { color: palette.text, fontSize: 13, lineHeight: 19 },
  title: { color: palette.green, fontSize: 13, fontWeight: '900', letterSpacing: .5 },
  card: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 18, padding: 14, gap: 8 },
  input: { borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, color: palette.text, fontSize: 13 },
  area: { minHeight: 80, textAlignVertical: 'top' },
  button: { backgroundColor: palette.green, borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
  buttonText: { color: palette.background, fontSize: 14, fontWeight: '900' },
  secondary: { borderWidth: 1, borderColor: palette.green, borderRadius: 12, paddingVertical: 9, alignItems: 'center' },
  disabled: { opacity: .4 },
  tip: { borderTopWidth: 1, borderTopColor: palette.border, paddingTop: 8, gap: 3 },
  tipHead: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  flex: { flex: 1 },
  status: { fontSize: 11, fontWeight: '900' },
  actions: { flexDirection: 'row', gap: 14, marginTop: 2 },
  action: { color: palette.muted, fontSize: 12, fontWeight: '700' },
  actionOn: { color: palette.green },
});
