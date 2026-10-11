import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../auth';
import type { TrialPlan, TrialPollAnswers } from '../auth';
import { colors, radius } from '../theme';

// End-of-trial poll (owner, 2026-10-11): 3 quick questions in a trial's last day (or after it ended) for 7 more free days.

const LIKED = ['Vetted', 'GKR picks', 'Edge', 'Top Picks', 'Crown builder', 'Results'];
// Subscription lengths and the price ranges to ask about (owner, 2026-10-11; estimates pending the owner's final numbers).
const PLANS: readonly { value: TrialPlan; label: string; prices: string[] }[] = [
  { value: 'WEEK', label: '1 week', prices: ['$5–7', '$8–10', '$11–15'] },
  { value: 'MONTH', label: '1 month', prices: ['$15–20', '$21–30', '$31–40'] },
  { value: 'QUARTER', label: '3 months', prices: ['$40–55', '$56–75', '$76–100'] },
  { value: 'HALF_YEAR', label: '6 months', prices: ['$75–100', '$101–135', '$136–175'] },
  { value: 'YEAR', label: '1 year', prices: ['$120–160', '$161–220', '$221–300'] },
  { value: 'NONE', label: 'I wouldn’t subscribe', prices: [] },
];
/** Shown with the poll and after it: the bonus week is the last free time. */
export const TRIAL_AFTER_NOTE = 'After your 7 bonus days, a subscription is required to keep using CrownIQ.';

export function TrialPollForm({ onDone }: { onDone?: () => void }) {
  const { answerTrialPoll } = useAuth();
  const [recommend, setRecommend] = useState<TrialPollAnswers['recommend'] | null>(null);
  const [liked, setLiked] = useState<string[]>([]);
  const [improve, setImprove] = useState('');
  const [plan, setPlan] = useState<TrialPlan | null>(null);
  const [price, setPrice] = useState<string | null>(null);
  const prices = PLANS.find((item) => item.value === plan)?.prices ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async () => {
    if (!recommend) { setError('Pick an answer for the first question.'); return; }
    setBusy(true); setError('');
    if (!plan) { setError('Pick the plan you’d choose (or “I wouldn’t subscribe”).'); return; }
    if (prices.length && !price) { setError('Pick a price range for that plan.'); return; }
    try { await answerTrialPoll({ recommend, liked, improve: improve.trim() || null, plan, price: prices.length ? price : null }); onDone?.(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send your answers.'); }
    finally { setBusy(false); }
  };
  return <View style={styles.form}>
    <Text style={styles.question}>1. Would you recommend CrownIQ to a friend?</Text>
    <View style={styles.chips}>{(['YES', 'MAYBE', 'NO'] as const).map((value) => <Chip key={value} label={value === 'YES' ? 'Yes' : value === 'MAYBE' ? 'Maybe' : 'No'}
      on={recommend === value} onPress={() => setRecommend(value)} />)}</View>
    <Text style={styles.question}>2. What did you like most? (pick any)</Text>
    <View style={styles.chips}>{LIKED.map((value) => <Chip key={value} label={value} on={liked.includes(value)}
      onPress={() => setLiked((list) => list.includes(value) ? list.filter((item) => item !== value) : [...list, value])} />)}</View>
    <Text style={styles.question}>3. Which plan would you pick?</Text>
    <View style={styles.chips}>{PLANS.map((item) => <Chip key={item.value} label={item.label} on={plan === item.value}
      onPress={() => { setPlan(item.value); setPrice(null); }} />)}</View>
    {prices.length > 0 && <>
      <Text style={styles.question}>4. What price feels fair for {PLANS.find((item) => item.value === plan)?.label.toLowerCase()}?</Text>
      <View style={styles.chips}>{prices.map((value) => <Chip key={value} label={value} on={price === value} onPress={() => setPrice(value)} />)}</View>
    </>}
    <Text style={styles.question}>{prices.length ? '5' : '4'}. What should we improve? (optional)</Text>
    <TextInput value={improve} onChangeText={setImprove} multiline maxLength={500} placeholder="Anything missing, confusing or slow…"
      placeholderTextColor={colors.textFaint} style={styles.input} />
    <Text style={styles.note}>{TRIAL_AFTER_NOTE}</Text>
    {!!error && <Text style={styles.error}>{error}</Text>}
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void send()} style={[styles.button, busy && { opacity: .5 }]}>
      {busy ? <ActivityIndicator color={colors.mintInk} /> : <Text style={styles.buttonText}>Send and get 7 more days</Text>}
    </Pressable>
  </View>;
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
    <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text></Pressable>;
}

/** For signed-in trial accounts: a card in the pass's last day that opens the poll. */
export function TrialPollCard() {
  const { request, profile } = useAuth();
  // Hours left are worked out when the status arrives (not during render).
  const [status, setStatus] = useState<{ eligible: boolean; hours: number | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [thanks, setThanks] = useState(false);
  const guest = profile?.plan === 'GUEST';
  useEffect(() => {
    if (!guest) return;
    let active = true;
    const load = () => request('/v1/trial/poll').then(async (response) => {
      if (!response.ok || !active) return;
      const value = await response.json() as { eligible: boolean; expiresAt: string | null };
      setStatus({ eligible: value.eligible, hours: value.expiresAt ? Math.max(0, Math.round((Date.parse(value.expiresAt) - Date.now()) / 3_600_000)) : null });
    }).catch(() => undefined);
    const first = setTimeout(load, 0), timer = setInterval(load, 15 * 60_000);
    return () => { active = false; clearTimeout(first); clearInterval(timer); };
  }, [guest, request]);
  if (!guest || (!status?.eligible && !thanks)) return null;
  const hours = status?.hours ?? null;
  return <>
    <Pressable accessibilityRole="button" onPress={() => thanks ? router.push('/subscribe') : setOpen(true)} style={styles.card}>
      <Text style={styles.cardText}>{thanks ? `🎉 Thanks! 7 more free days added. ${TRIAL_AFTER_NOTE} Tap to see plans (10% off now) →`
        : `⏳ Your free pass ends in ${hours ?? 'a few'} ${hours === 1 ? 'hour' : 'hours'}. Answer a few quick questions for 7 more days free  →`}</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
      <View style={styles.backdrop}><View style={styles.sheet}>
        <View style={styles.sheetHead}><Text style={styles.sheetTitle}>A few quick questions</Text>
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)}><Text style={styles.close}>Close</Text></Pressable></View>
        <TrialPollForm onDone={() => { setOpen(false); setThanks(true); setStatus(null); }} />
      </View></View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  form: { gap: 10 },
  question: { color: colors.text, fontSize: 14, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.borderStrong },
  chipOn: { backgroundColor: colors.mint, borderColor: colors.mint },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  chipTextOn: { color: colors.mintInk },
  input: { minHeight: 70, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, padding: 10, color: colors.text, textAlignVertical: 'top' },
  error: { color: colors.red, fontSize: 13 },
  note: { color: colors.gold, fontSize: 12, fontWeight: '700', lineHeight: 17 },
  button: { minHeight: 46, borderRadius: 999, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: colors.mintInk, fontSize: 15, fontWeight: '900' },
  card: { backgroundColor: colors.surface, borderBottomWidth: 1, borderColor: colors.mint, paddingHorizontal: 16, paddingVertical: 10 },
  cardText: { color: colors.mint, fontWeight: '800', textAlign: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, gap: 12, borderTopWidth: 1, borderColor: colors.border },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  close: { color: colors.textMuted, fontWeight: '700' },
});
