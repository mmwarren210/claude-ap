import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';
import { useAuth } from '../auth';
import { PrimaryButton } from './ui/Controls';
import { colors, radius } from '../theme';

// Starting a trial (owner, 2026-10-12: "make them create a profile"): the pass starts with a username, email and password, so
// the same person signs in on another device instead of using a second pass, and the account is ready when they subscribe.

export function TrialStart({ onSignIn }: { onSignIn: () => void }) {
  const { guest } = useAuth();
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [problem, setProblem] = useState('');
  const start = () => {
    if (!/^[A-Za-z0-9_]{3,24}$/.test(form.username.trim())) { setProblem('Username: 3–24 letters, numbers or _.'); return; }
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) { setProblem('Enter your email.'); return; }
    if (form.password.length < 12) { setProblem('Password: at least 12 characters.'); return; }
    setProblem('');
    guest.start({ username: form.username.trim(), email: form.email.trim(), password: form.password });
  };
  const message = problem || guest.formError;
  return <View style={styles.form}>
    <Text style={styles.detail}>You’ve got a free 2-day pass to CrownIQ. Create your login to start it. Use the same login to sign in on any other device; your pass goes with you.</Text>
    <TextInput accessibilityLabel="Username" value={form.username} onChangeText={(username) => setForm({ ...form, username })} placeholder="Choose a username"
      autoCapitalize="none" autoCorrect={false} placeholderTextColor={colors.textFaint} style={styles.input} />
    <TextInput accessibilityLabel="Email" value={form.email} onChangeText={(email) => setForm({ ...form, email })} placeholder="Email" autoCapitalize="none"
      autoCorrect={false} keyboardType="email-address" placeholderTextColor={colors.textFaint} style={styles.input} />
    <TextInput accessibilityLabel="Password" value={form.password} onChangeText={(password) => setForm({ ...form, password })} placeholder="Password (12+ characters)"
      secureTextEntry placeholderTextColor={colors.textFaint} style={styles.input} />
    {!!message && <Text accessibilityRole="alert" style={styles.error}>{message}</Text>}
    <PrimaryButton label="Start my 2-day pass" onPress={start} />
    <Pressable accessibilityRole="button" onPress={onSignIn}><Text style={styles.link}>Already started on another device? Sign in below</Text></Pressable>
  </View>;
}

const styles = StyleSheet.create({
  form: { gap: 10 },
  detail: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, color: colors.text, fontSize: 15, paddingHorizontal: 12, paddingVertical: 11 },
  error: { color: colors.red, fontSize: 13, lineHeight: 18 },
  link: { color: colors.mint, fontSize: 13, fontWeight: '800', textAlign: 'center', paddingVertical: 4 },
});
