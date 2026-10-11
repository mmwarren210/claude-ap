import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../auth';
import { colors, radius } from '../theme';
import { endsText, useSubscription } from './PlanStatus';
import { CreateLoginForm } from './CreateLogin';

// Subscribe (owner, 2026-10-11): manual payments. Pick a plan, pay with a listed app, text the payment screenshot and your
// CrownIQ username to the owner, tap "I've paid" (trials get 24 more hours once), then enter the member key the owner sends.

type Plan = { plan: string; label: string; price: number | null; discounted: number | null };
type Info = { plans: Plan[]; discount: number; priced: boolean; methods: { name: string; handle: string; note?: string }[]; textTo: string | null };
const money = (value: number) => `$${value % 1 ? value.toFixed(2) : value}`;

export function SubscribePanel({ onDone }: { onDone?: () => void }) {
  const { request, profile, adoptSession, register } = useAuth();
  const [info, setInfo] = useState<Info | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [method, setMethod] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [account, setAccount] = useState({ username: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const guest = profile?.plan === 'GUEST', signedOut = !profile, member = !!profile && !guest;
  const { paid: current, waiting } = useSubscription();
  useEffect(() => {
    let active = true;
    void request('/v1/subscribe').then(async (response) => response.ok ? await response.json() as Info : null)
      .then((value) => { if (active && value) setInfo(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [request]);
  const chosen = info?.plans.find((item) => item.plan === plan);
  const paid = async () => {
    if (!plan || !method) { setMessage('Pick a plan and how you paid first.'); return; }
    setBusy(true); setMessage('');
    try {
      const response = await request('/v1/subscribe/paid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan, method }) });
      if (!response.ok) throw new Error();
      const value = await response.json() as { token: string; profile: NonNullable<typeof profile>; graced: boolean };
      adoptSession(value);
      setMessage(value.graced ? 'Got it. Waiting for approval. We added 24 hours to your pass while the payment is checked.'
        : 'Got it. Waiting for approval. Your time is added as soon as the payment is confirmed.');
    } catch { setMessage('Could not send that. Try again.'); }
    finally { setBusy(false); }
  };
  const redeem = async () => {
    if (key.trim().length < 8) { setMessage('Enter the member key the owner sent you.'); return; }
    setBusy(true); setMessage('');
    try {
      if (member) {
        const response = await request('/v1/subscribe/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: key.trim() }) });
        if (!response.ok) throw new Error(response.status === 404 ? 'That member key isn’t right or was already used.' : 'Could not use that key.');
        adoptSession(await response.json() as { token: string; profile: NonNullable<typeof profile> });
      } else {
        if (!account.username.trim() || !account.email.trim() || account.password.length < 8)
          throw new Error('Choose a username, your email and a password (8+ characters).');
        await register(account.username.trim(), account.email.trim(), account.password, key.trim());
      }
      setMessage('🎉 You’re in! Your plan is active.'); onDone?.();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not use that key.'); }
    finally { setBusy(false); }
  };
  if (!info) return <ActivityIndicator color={colors.mint} />;
  return <View style={styles.panel}>
    {current && <Text style={styles.current}>Your plan: {endsText(current)}</Text>}
    {guest && <View style={styles.loginBox}>
      <Text style={styles.step}>First: create your login</Text>
      <Text style={styles.muted}>Do this before you pay, so what you pay for is tied to a login you can use on any phone. Your picks come with you.</Text>
      <CreateLoginForm />
    </View>}
    {waiting && <Text style={styles.waiting}>⏳ Waiting for approval · {waiting.label} ({waiting.method}). You’ll have access as soon as the payment is confirmed.</Text>}
    <Text style={styles.step}>1. Pick a plan{info.discount ? ` · ${Math.round(info.discount * 100)}% off when you sign up now` : ''}</Text>
    {!info.priced && <Text style={styles.muted}>Prices are being finalized. Check back soon.</Text>}
    <View style={styles.plans}>{info.plans.filter((item) => item.price !== null).map((item) => <Pressable key={item.plan} accessibilityRole="button"
      onPress={() => setPlan(item.plan)} style={[styles.plan, plan === item.plan && styles.planOn]}>
      <Text style={[styles.planName, plan === item.plan && styles.planNameOn]}>{item.label}</Text>
      {item.discounted !== null && item.discounted !== item.price
        ? <Text style={[styles.planPrice, plan === item.plan && styles.planNameOn]}><Text style={styles.strike}>{money(item.price!)}</Text>  {money(item.discounted)}</Text>
        : <Text style={[styles.planPrice, plan === item.plan && styles.planNameOn]}>{money(item.price!)}</Text>}
    </Pressable>)}</View>

    <Text style={styles.step}>2. Pay {chosen?.discounted ? money(chosen.discounted) : 'the plan price'} with any of these</Text>
    {info.methods.map((item) => <Pressable key={item.name} accessibilityRole="button" onPress={() => setMethod(item.name)}
      style={[styles.method, method === item.name && styles.methodOn]}>
      <Text style={styles.methodName}>{item.name}</Text><Text selectable style={styles.handle}>{item.handle}</Text>
      {!!item.note && <Text style={styles.muted}>{item.note}</Text>}
    </Pressable>)}

    <Text style={styles.step}>3. Text your payment screenshot and your CrownIQ username{info.textTo ? ` to ${info.textTo}` : ' to the owner'}</Text>
    <Text style={styles.final}>All sales are final. No refunds.</Text>
    <Text style={styles.warn}>Payments are checked by hand, so approval isn’t instant. Allow up to 24 hours, and pay at least 24 hours before your free days end.</Text>
    {!signedOut && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void paid()} style={[styles.button, busy && styles.off]}>
      <Text style={styles.buttonText}>I’ve paid</Text></Pressable>}
    {guest && <Text style={styles.muted}>Tapping “I’ve paid” adds 24 hours to your pass once, so you don’t lose access while it’s checked.</Text>}

    <Text style={styles.step}>4. Got a member key instead? Enter it here</Text>
    {!member && <>
      <TextInput value={account.username} onChangeText={(username) => setAccount({ ...account, username })} placeholder="Choose a username" autoCapitalize="none"
        placeholderTextColor={colors.textFaint} style={styles.input} />
      <TextInput value={account.email} onChangeText={(email) => setAccount({ ...account, email })} placeholder="Email" autoCapitalize="none" keyboardType="email-address"
        placeholderTextColor={colors.textFaint} style={styles.input} />
      <TextInput value={account.password} onChangeText={(password) => setAccount({ ...account, password })} placeholder="Password (8+ characters)" secureTextEntry
        placeholderTextColor={colors.textFaint} style={styles.input} />
    </>}
    <TextInput value={key} onChangeText={setKey} placeholder="CIQM-XXXX-XXXX-XXXX" autoCapitalize="characters" placeholderTextColor={colors.textFaint} style={styles.input} />
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void redeem()} style={[styles.button, busy && styles.off]}>
      {busy ? <ActivityIndicator color={colors.mintInk} /> : <Text style={styles.buttonText}>{member ? 'Activate my plan' : 'Create my account and activate'}</Text>}
    </Pressable>
    {!!message && <Text style={styles.message}>{message}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  panel: { gap: 10 },
  step: { color: colors.text, fontSize: 15, fontWeight: '900', marginTop: 6 },
  muted: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  warn: { color: colors.gold, fontSize: 12, fontWeight: '700', lineHeight: 17 },
  plans: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  plan: { minWidth: '30%', flexGrow: 1, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, gap: 2 },
  planOn: { backgroundColor: colors.mint, borderColor: colors.mint },
  planName: { color: colors.text, fontWeight: '800', fontSize: 13 },
  planNameOn: { color: colors.mintInk },
  planPrice: { color: colors.mint, fontWeight: '900', fontSize: 15 },
  strike: { textDecorationLine: 'line-through', color: colors.textMuted, fontWeight: '600', fontSize: 12 },
  method: { padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, gap: 2 },
  methodOn: { borderColor: colors.mint },
  methodName: { color: colors.text, fontWeight: '800' },
  handle: { color: colors.mint, fontSize: 15, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, padding: 10, color: colors.text },
  button: { minHeight: 46, borderRadius: 999, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  off: { opacity: .5 },
  buttonText: { color: colors.mintInk, fontSize: 15, fontWeight: '900' },
  message: { color: colors.text, fontSize: 13, lineHeight: 18 },
  current: { color: colors.mint, fontSize: 15, fontWeight: '900' },
  waiting: { color: colors.gold, fontSize: 14, fontWeight: '800', lineHeight: 19 },
  final: { color: colors.text, fontSize: 13, fontWeight: '900' },
  loginBox: { gap: 8, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.mint },
});
