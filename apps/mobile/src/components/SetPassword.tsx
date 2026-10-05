import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth';
import { colors, radius } from '../theme';
import { AppHeader } from './ui/AppHeader';
import { GhostButton, PrimaryButton } from './ui/Controls';

/**
 * Shown right after a family member signs up or signs in with the shared family code: they set their own password
 * before anything else, so the shared code never keeps working on their account.
 */
export function SetPassword() {
  const { profile, changePassword, logout, passwordKnown } = useAuth();
  const [code, setCode] = useState(''), [next, setNext] = useState(''), [again, setAgain] = useState('');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const save = async () => {
    if (next.length < 12) { setMessage('Use at least 12 characters.'); return; }
    if (next !== again) { setMessage('The two passwords don’t match.'); return; }
    setBusy(true); setMessage('');
    try { await changePassword(next, passwordKnown ? undefined : code); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save.'); }
    setBusy(false);
  };
  return <SafeAreaView style={styles.safe} edges={['top']}><ScrollView contentContainerStyle={styles.content}>
    <AppHeader subtitle="Welcome to the family" />
    <Text style={styles.title}>Set your own password</Text>
    <Text style={styles.body}>{profile?.username ? `${profile.username}, you’re` : 'You’re'} a Lifetime Member. The family code
      only works once, so choose your own password now. You’ll use it to sign in from here on.</Text>
    {!passwordKnown && <View style={styles.field}><Text style={styles.label}>Family code</Text>
      <TextInput accessibilityLabel="Family code" secureTextEntry autoComplete="current-password" value={code} onChangeText={setCode}
        placeholder="The code you signed up with" placeholderTextColor={colors.textFaint} style={styles.input} /></View>}
    <View style={styles.field}><Text style={styles.label}>New password</Text>
      <TextInput accessibilityLabel="New password" secureTextEntry autoComplete="new-password" value={next} onChangeText={setNext}
        placeholder="At least 12 characters" placeholderTextColor={colors.textFaint} style={styles.input} /></View>
    <View style={styles.field}><Text style={styles.label}>Type it again</Text>
      <TextInput accessibilityLabel="Type the new password again" secureTextEntry autoComplete="new-password" value={again}
        onChangeText={setAgain} placeholder="Same password" placeholderTextColor={colors.textFaint} style={styles.input} /></View>
    {!!message && <Text accessibilityRole="alert" style={styles.error}>{message}</Text>}
    <PrimaryButton label={busy ? 'Saving…' : 'Save password'} icon="lock-check-outline" disabled={busy} onPress={() => void save()} />
    <GhostButton label="Log out" icon="logout" onPress={() => void logout()} />
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 40, gap: 14 },
  title: { color: colors.text, fontSize: 24, fontWeight: '900' },
  body: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  field: { gap: 6 },
  label: { color: colors.text, fontSize: 14, fontWeight: '700' },
  input: { backgroundColor: colors.surfaceSunken, borderColor: colors.borderStrong, borderWidth: 1,
    borderRadius: radius.md, color: colors.text, fontSize: 16, paddingHorizontal: 14, minHeight: 50 },
  error: { color: colors.red, fontSize: 14 },
});
