import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput,
  View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth';
import { CrownLogo } from '../components/ui/AppHeader';
import { GhostButton, PrimaryButton } from '../components/ui/Controls';
import { colors, radius } from '../theme';

export default function SignIn() {
  const { login, register, enterDemo, guest } = useAuth();
  const [creating, setCreating] = useState(true), [username, setUsername] = useState(''),
    [email, setEmail] = useState(''), [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try { if (creating) await register(username.trim(), email.trim(), password);
      else await login(email.trim(), password); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not sign in.'); }
    finally { setBusy(false); }
  };
  return <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
    <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <CrownLogo size={64} />
          <Text style={styles.word}>Crown<Text style={styles.iq}>IQ</Text></Text>
          <Text style={styles.tag}>Sports Intelligence · Powered by GKR</Text>
        </View>

        {(guest.signingIn || !!guest.message) && <View style={styles.panel}>
          <Text style={styles.title}>Guest pass</Text>
          {guest.signingIn ? <><Text style={styles.detail}>Opening CrownIQ with your guest pass…</Text>
            <ActivityIndicator color={colors.mint} style={styles.busy} /></>
            : <Text accessibilityRole="alert" style={styles.error}>{guest.message}</Text>}
        </View>}
        <View style={styles.panel}>
          <Text style={styles.title}>{creating ? 'Create your profile' : 'Welcome back'}</Text>
          <Text style={styles.detail}>Your saved picks and private Crowns belong to your profile.</Text>
          {creating && <View style={styles.field}><Text style={styles.label}>Display username</Text>
            <TextInput accessibilityLabel="Display username" autoCapitalize="none" autoCorrect={false}
              autoComplete="username-new" value={username} onChangeText={setUsername}
              placeholder="Choose a username" placeholderTextColor={colors.textFaint} style={styles.input} /></View>}
          <View style={styles.field}><Text style={styles.label}>{creating ? 'Email' : 'Email or username'}</Text>
            <TextInput accessibilityLabel={creating ? 'Email' : 'Email or username'} autoCapitalize="none" autoCorrect={false}
              autoComplete={creating ? 'email' : 'username'} keyboardType={creating ? 'email-address' : 'default'}
              value={email} onChangeText={setEmail} placeholder={creating ? 'you@example.com' : 'Email or username'}
              placeholderTextColor={colors.textFaint} style={styles.input} /></View>
          <View style={styles.field}><Text style={styles.label}>Password</Text>
            <TextInput accessibilityLabel="Password" secureTextEntry
              autoComplete={creating ? 'new-password' : 'current-password'} value={password} onChangeText={setPassword}
              placeholder={creating ? 'At least 12 characters' : 'Your password'}
              placeholderTextColor={colors.textFaint} style={styles.input} /></View>
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {busy ? <ActivityIndicator color={colors.mint} style={styles.busy} />
            : <PrimaryButton label={creating ? 'Create profile' : 'Sign in'} onPress={() => void submit()} />}
          <Pressable accessibilityRole="button" onPress={() => { setCreating(!creating); setError(''); }}
            style={styles.switch}><Text style={styles.switchText}>
              {creating ? 'Already have a profile? Sign in' : 'New to CrownIQ? Create a profile'}</Text></Pressable>
        </View>

        <View style={styles.demo}>
          <GhostButton label="Try the demo" icon="play-circle-outline" onPress={enterDemo} />
          <Text style={styles.demoNote}>Explore every screen with sample data. No account needed, nothing is saved,
            and the sample picks are not real.</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingBottom: 40, gap: 22 },
  hero: { alignItems: 'center', gap: 4, paddingTop: 18 },
  word: { color: colors.text, fontSize: 44, fontWeight: '900', letterSpacing: -1.2 },
  iq: { color: colors.neon },
  tag: { color: colors.textMuted, fontSize: 14 },
  panel: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.xl,
    padding: 18, gap: 14 },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  detail: { color: colors.textMuted, fontSize: 14, lineHeight: 20, marginTop: -6 },
  field: { gap: 6 },
  label: { color: colors.text, fontWeight: '700', fontSize: 13 },
  input: { backgroundColor: colors.surfaceSunken, borderColor: colors.borderStrong, borderWidth: 1,
    borderRadius: radius.md, color: colors.text, fontSize: 16, paddingHorizontal: 14, minHeight: 50 },
  error: { color: colors.red, fontSize: 14 },
  busy: { minHeight: 50 },
  switch: { minHeight: 40, justifyContent: 'center', alignItems: 'center' },
  switchText: { color: colors.mint, fontWeight: '700' },
  demo: { gap: 10 },
  demoNote: { color: colors.textMuted, fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
