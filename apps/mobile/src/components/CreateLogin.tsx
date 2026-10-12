import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';
import { useAuth } from '../auth';
import { colors, radius } from '../theme';
import { useSubscription } from './PlanStatus';

// Create your login (owner, 2026-10-11): a trial account that paid (or is waiting for approval) has no username or password,
// so it would lose what it paid for on a new phone. This turns it into a full account on the spot, keeping its picks and plan.

export function CreateLoginForm({ onDone }: { onDone?: () => void }) {
  const { register } = useAuth();
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const save = async () => {
    if (!/^[A-Za-z0-9_]{3,24}$/.test(form.username.trim())) { setMessage('Username: 3–24 letters, numbers or _.'); return; }
    if (!form.email.includes('@')) { setMessage('Enter your email.'); return; }
    if (form.password.length < 12) { setMessage('Password: at least 12 characters.'); return; }
    setBusy(true); setMessage('');
    try { await register(form.username.trim(), form.email.trim(), form.password); setMessage('✓ Login created. Sign in with it on any phone.'); onDone?.(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not create your login.'); }
    finally { setBusy(false); }
  };
  return <View style={styles.form}>
    <TextInput value={form.username} onChangeText={(username) => setForm({ ...form, username })} placeholder="Choose a username" autoCapitalize="none"
      autoCorrect={false} placeholderTextColor={colors.textFaint} style={styles.input} />
    <TextInput value={form.email} onChangeText={(email) => setForm({ ...form, email })} placeholder="Email" autoCapitalize="none" keyboardType="email-address"
      placeholderTextColor={colors.textFaint} style={styles.input} />
    <TextInput value={form.password} onChangeText={(password) => setForm({ ...form, password })} placeholder="Password (12+ characters)" secureTextEntry
      placeholderTextColor={colors.textFaint} style={styles.input} />
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void save()} style={[styles.button, busy && { opacity: .5 }]}>
      {busy ? <ActivityIndicator color={colors.mintInk} /> : <Text style={styles.buttonText}>Create my login</Text>}
    </Pressable>
    {!!message && <Text style={styles.message}>{message}</Text>}
  </View>;
}

/** A bar across the app for a trial account that paid or is waiting for approval, until it creates its login. */
export function CreateLoginAlert() {
  const { profile } = useAuth();
  const { paid, waiting } = useSubscription();
  const [open, setOpen] = useState(false);
  // A trial that started with a login (2026-10-12) already has one.
  if (profile?.plan !== 'GUEST' || !!profile.email || (!paid && !waiting)) return null;
  return <View style={styles.bar}>
    <Pressable accessibilityRole="button" onPress={() => setOpen(!open)}>
      <Text style={styles.barText}>🔐 Create your login so you never lose access to what you paid for{open ? '' : '  →'}</Text>
    </Pressable>
    {open && <CreateLoginForm />}
  </View>;
}

const styles = StyleSheet.create({
  form: { gap: 8 },
  input: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, padding: 10, color: colors.text },
  button: { minHeight: 44, borderRadius: 999, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: colors.mintInk, fontSize: 15, fontWeight: '900' },
  message: { color: colors.text, fontSize: 13 },
  bar: { gap: 8, backgroundColor: colors.surface, borderBottomWidth: 1, borderColor: colors.mint, paddingHorizontal: 16, paddingVertical: 10 },
  barText: { color: colors.mint, fontWeight: '800', textAlign: 'center' },
});
