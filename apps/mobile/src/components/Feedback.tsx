import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../auth';
import { colors, radius } from '../theme';
import { GhostButton, PrimaryButton, Segmented } from './ui/Controls';

// Beta feedback: testers report bugs and suggestions, see what happened to each, and read the patch notes.

type Kind = 'BUG' | 'SUGGESTION';
type Status = 'NEW' | 'PLANNED' | 'FIXED' | 'DECLINED';
export type FeedbackItem = { id: string; kind: Kind; text: string; screen: string | null; username: string; createdAt: string;
  status: Status; reply: string | null; updateId: string | null };
export type PatchNote = { id: string; title: string; body: string; createdAt: string; feedbackIds: string[] };

export const statusText: Readonly<Record<Status, string>> = { NEW: 'Received', PLANNED: 'Planned', FIXED: 'Fixed',
  DECLINED: 'Not planned' };
const statusColor: Readonly<Record<Status, string>> = { NEW: colors.textMuted, PLANNED: colors.gold, FIXED: colors.mint,
  DECLINED: colors.red };
const kinds = [{ value: 'BUG' as const, label: 'Found a bug' }, { value: 'SUGGESTION' as const, label: 'Suggestion' }];
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Loads JSON from a signed-in route, or null. */
function useJson<T>(path: string, pick: (body: unknown) => T) {
  const { request } = useAuth();
  const [value, setValue] = useState<T | null>(null);
  const fetchIt = useCallback(() => request(path).then(async (response) => response.ok ? pick(await response.json()) : null)
    .catch(() => null), [request, path, pick]);
  useEffect(() => {
    let active = true;
    void fetchIt().then((result) => { if (active) setValue(result); });
    return () => { active = false; };
  }, [fetchIt]);
  const reload = async () => setValue(await fetchIt());
  return [value, reload] as const;
}
const pickItems = (body: unknown) => (body as { items: FeedbackItem[] }).items;
const pickUpdates = (body: unknown) => (body as { updates: PatchNote[] }).updates;

/** The report form and the tester's own reports with their status and our reply. */
export function BetaFeedback() {
  const { request } = useAuth();
  const [kind, setKind] = useState<Kind>('BUG'), [text, setText] = useState(''), [screen, setScreen] = useState('');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [mine, reload] = useJson('/v1/feedback/mine', pickItems);
  const send = async () => {
    if (text.trim().length < 5) { setMessage('Tell us a little more (at least a few words).'); return; }
    setBusy(true); setMessage('');
    const response = await request('/v1/feedback', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, text: text.trim(), screen: screen.trim() || null }) }).catch(() => null);
    setBusy(false);
    if (response?.status === 429) { setMessage('That’s the most reports for today. Thank you! Try again tomorrow.'); return; }
    if (!response?.ok) { setMessage('Couldn’t send that. Try again in a minute.'); return; }
    setText(''); setScreen(''); setMessage('Thanks! We check reports twice a day and post what we fix under Updates.');
    await reload();
  };
  return <View style={styles.box}>
    <Text style={styles.note}>CrownIQ is in beta and you’re one of our testers. Tell us what’s broken or what you’d like.
      We read every report twice a day, fix it or explain why not, and post the fixes under Updates.</Text>
    <Segmented label="Report type" options={kinds} value={kind} onChange={setKind} />
    <TextInput accessibilityLabel="What happened" multiline value={text} onChangeText={setText} maxLength={2000}
      placeholder={kind === 'BUG' ? 'What went wrong? What did you expect?' : 'What would make CrownIQ better?'}
      placeholderTextColor={colors.textFaint} style={[styles.input, styles.multi]} />
    <TextInput accessibilityLabel="Where in the app" value={screen} onChangeText={setScreen} maxLength={80}
      placeholder="Where in the app? (optional, e.g. Board, Crown)" placeholderTextColor={colors.textFaint} style={styles.input} />
    <PrimaryButton label={busy ? 'Sending…' : 'Send'} icon="send" disabled={busy} onPress={() => void send()} />
    {!!message && <Text style={styles.note}>{message}</Text>}
    {!!mine?.length && <Text style={styles.label}>Your reports</Text>}
    {mine?.map((item) => <ReportRow key={item.id} item={item} />)}
  </View>;
}

function ReportRow({ item, children }: { item: FeedbackItem; children?: React.ReactNode }) {
  return <View style={styles.report}>
    <View style={styles.reportHead}>
      <Text style={styles.kind}>{item.kind === 'BUG' ? 'Bug' : 'Suggestion'} · {day(item.createdAt)}</Text>
      <Text style={[styles.status, { color: statusColor[item.status], borderColor: statusColor[item.status] }]}>
        {statusText[item.status]}</Text>
    </View>
    <Text style={styles.body}>{item.text}</Text>
    {!!item.screen && <Text style={styles.note}>Where: {item.screen}</Text>}
    {!!item.reply && <Text style={styles.reply}>CrownIQ: {item.reply}</Text>}
    {children}
  </View>;
}

/** Patch notes, newest first. */
export function PatchNotes() {
  const [updates] = useJson('/v1/updates', pickUpdates);
  if (updates === null) return <Text style={styles.note}>Loading…</Text>;
  if (!updates.length) return <Text style={styles.note}>No updates yet. Fixes from your reports will show up here.</Text>;
  return <View style={styles.box}>{updates.map((note) => <View key={note.id} style={styles.report}>
    <Text style={styles.kind}>{day(note.createdAt)}{note.feedbackIds.length
      ? ` · answers ${note.feedbackIds.length} ${note.feedbackIds.length === 1 ? 'report' : 'reports'}` : ''}</Text>
    <Text style={styles.title}>{note.title}</Text>
    <Text style={styles.body}>{note.body}</Text>
  </View>)}</View>;
}

/** Owner only: every report with plan / fix / decline and a reply, and a form to post patch notes. */
export function FeedbackReview() {
  const { request } = useAuth();
  const [items, reload] = useJson('/v1/owner/feedback', pickItems);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [title, setTitle] = useState(''), [body, setBody] = useState(''), [message, setMessage] = useState('');
  const [fixed, setFixed] = useState<string[]>([]);
  const review = async (item: FeedbackItem, status: Status) => {
    await request(`/v1/owner/feedback/${item.id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, reply: replies[item.id]?.trim() || null }) }).catch(() => null);
    await reload();
  };
  const post = async () => {
    if (title.trim().length < 3 || body.trim().length < 3) { setMessage('Add a title and what changed.'); return; }
    const response = await request('/v1/owner/updates', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), body: body.trim(), feedbackIds: fixed }) }).catch(() => null);
    if (!response?.ok) { setMessage('Couldn’t post that. Try again.'); return; }
    setTitle(''); setBody(''); setFixed([]); setMessage('Posted. Testers see it under Updates.'); await reload();
  };
  return <View style={styles.box}>
    <Text style={styles.label}>Post an update</Text>
    <TextInput accessibilityLabel="Update title" value={title} onChangeText={setTitle} maxLength={120}
      placeholder="Title, e.g. Patch 1.1: board fixes" placeholderTextColor={colors.textFaint} style={styles.input} />
    <TextInput accessibilityLabel="What changed" multiline value={body} onChangeText={setBody} maxLength={4000}
      placeholder="What changed, in plain words" placeholderTextColor={colors.textFaint} style={[styles.input, styles.multi]} />
    <Text style={styles.note}>{fixed.length ? `Marks ${fixed.length} ${fixed.length === 1 ? 'report' : 'reports'} fixed.`
      : 'Tap “Include in update” on reports this fixes.'}</Text>
    <PrimaryButton label="Post update" icon="bullhorn-outline" onPress={() => void post()} />
    {!!message && <Text style={styles.note}>{message}</Text>}
    <Text style={styles.label}>Reports</Text>
    {items === null ? <Text style={styles.note}>Loading…</Text> : !items.length ? <Text style={styles.note}>No reports yet.</Text>
      : items.map((item) => <ReportRow key={item.id} item={item}>
        <Text style={styles.note}>From {item.username}</Text>
        <TextInput accessibilityLabel="Reply" value={replies[item.id] ?? ''} maxLength={1000}
          onChangeText={(value) => setReplies({ ...replies, [item.id]: value })} placeholder="Reply they’ll see (optional)"
          placeholderTextColor={colors.textFaint} style={styles.input} />
        <View style={styles.actions}>
          {(['PLANNED', 'FIXED', 'DECLINED'] as const).map((status) => <Pressable key={status} accessibilityRole="button"
            onPress={() => void review(item, status)} style={[styles.action, item.status === status && { borderColor: statusColor[status] }]}>
            <Text style={[styles.actionText, { color: statusColor[status] }]}>{statusText[status]}</Text></Pressable>)}
        </View>
        {item.status !== 'FIXED' && <GhostButton label={fixed.includes(item.id) ? 'In the update ✓' : 'Include in update'}
          icon="playlist-plus" onPress={() => setFixed(fixed.includes(item.id) ? fixed.filter((id) => id !== item.id) : [...fixed, item.id])} />}
      </ReportRow>)}
  </View>;
}

const styles = StyleSheet.create({
  box: { gap: 10 },
  label: { color: colors.text, fontSize: 14, fontWeight: '800', marginTop: 6 },
  note: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  input: { backgroundColor: colors.surfaceSunken, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    color: colors.text, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12, minHeight: 50 },
  multi: { minHeight: 110, textAlignVertical: 'top' },
  report: { gap: 6, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, padding: 12,
    backgroundColor: colors.surface },
  reportHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  kind: { color: colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 0.4 },
  status: { fontSize: 11, fontWeight: '900', borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  title: { color: colors.mint, fontSize: 16, fontWeight: '900' },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  reply: { color: colors.gold, fontSize: 13, lineHeight: 19, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, paddingVertical: 8, alignItems: 'center' },
  actionText: { fontSize: 13, fontWeight: '800' },
});
