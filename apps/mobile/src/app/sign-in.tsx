import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput,
  View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { apiBaseUrl } from '../api-base';
import { useAuth } from '../auth';
import { AppIcon } from '../components/ui/AppHeader';
import { GhostButton, PrimaryButton } from '../components/ui/Controls';
import { colors, radius } from '../theme';

export default function SignIn() {
  const { login, register, enterDemo, guest, resetPassword } = useAuth();
  const [resetting, setResetting] = useState(false), [code, setCode] = useState('');
  const [creating, setCreating] = useState(true), [username, setUsername] = useState(''),
    [email, setEmail] = useState(''), [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false), [error, setError] = useState('');
  // Sign-up is locked until a code unlocks it (family code: lifetime). Everyone else is asked to contact the owner.
  const [signup, setSignup] = useState<{ open: boolean; contact: string | null } | null>(null);
  const [accessCode, setAccessCode] = useState(''), [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    const base = apiBaseUrl();
    if (!base) return;
    let active = true;
    void fetch(`${base}/v1/auth/signup`).then(async (response) => response.ok ? await response.json() as { open: boolean; contact: string | null } : null)
      .then((value) => { if (active) setSignup(value ?? { open: false, contact: null }); })
      .catch(() => { if (active) setSignup({ open: false, contact: null }); });
    return () => { active = false; };
  }, []);
  const locked = creating && !resetting && !signup?.open && !unlocked;
  const unlock = async () => {
    const base = apiBaseUrl();
    if (!base || !accessCode.trim()) { setError('Enter your code.'); return; }
    setBusy(true); setError('');
    const response = await fetch(`${base}/v1/auth/signup-code`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: accessCode.trim() }) }).catch(() => null);
    setBusy(false);
    if (response?.ok) { setUnlocked(true); return; }
    const body = response ? await response.json().catch(() => ({})) as { code?: string } : {};
    setError(body.code === 'LIFETIME_FULL' ? 'All 20 lifetime family spots are taken. Contact the owner.'
      : body.code === 'TOO_MANY_ATTEMPTS' ? 'Too many tries. Wait a minute and try again.' : 'That code isn’t right. Check it and try again.');
  };
  const submit = async () => {
    setBusy(true); setError('');
    try { if (resetting) await resetPassword(email.trim(), code.trim(), password);
      else if (creating) await register(username.trim(), email.trim(), unlocked ? accessCode.trim() : password);
      else await login(email.trim(), password); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not sign in.'); }
    finally { setBusy(false); }
  };
  return <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
    <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <AppIcon size={132} />
          <Text style={styles.word}>Crown<Text style={styles.iq}>IQ</Text></Text>
          <Text style={styles.tag}>Sports Intelligence · Powered by GKR</Text>
          <View style={styles.betaPill}><Text style={styles.betaPillText}>BETA · NOW TESTING</Text></View>
        </View>

        {(guest.signingIn || !!guest.message) && <View style={styles.panel}>
          <Text style={styles.title}>Guest pass</Text>
          {guest.signingIn ? <><Text style={styles.detail}>Opening CrownIQ with your guest pass…</Text>
            <ActivityIndicator color={colors.mint} style={styles.busy} /></>
            : <Text accessibilityRole="alert" style={styles.error}>{guest.message}</Text>}
        </View>}
        <View style={styles.panel}>
          <Text style={styles.title}>{resetting ? 'Reset your password' : creating ? 'Create your profile' : 'Welcome back'}</Text>
          <Text style={styles.detail}>{resetting ? 'Ask the owner for a reset code, then enter it here with a new password.'
            : 'Your saved picks and private Crowns belong to your profile.'}</Text>
          {locked && <>
            <Text style={styles.lockTitle}>🔒 Invite only during beta</Text>
            <Text style={styles.detail}>Enter your access code to unlock sign-up.</Text>
            <View style={styles.field}><Text style={styles.label}>Access code</Text>
              <TextInput accessibilityLabel="Access code" secureTextEntry autoCapitalize="none" autoCorrect={false} value={accessCode}
                onChangeText={setAccessCode} placeholder="Your code" placeholderTextColor={colors.textFaint} style={styles.input}
                onSubmitEditing={() => void unlock()} /></View>
            {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            {busy ? <ActivityIndicator color={colors.mint} style={styles.busy} />
              : <PrimaryButton label="Unlock" icon="lock-open-variant-outline" onPress={() => void unlock()} />}
            <View style={styles.contact}><Text style={styles.contactText}>No code? CrownIQ is invite-only for now. Contact the owner
              for a subscription code{signup?.contact ? `: ${signup.contact}` : '.'}</Text></View>
          </>}
          {creating && unlocked && !resetting && <Text style={styles.unlocked}>👑 Lifetime access unlocked. Pick a username and
            enter your email. Next you’ll set your own password.</Text>}
          {!locked && <>
          {creating && !resetting && <View style={styles.field}><Text style={styles.label}>Display username</Text>
            <TextInput accessibilityLabel="Display username" autoCapitalize="none" autoCorrect={false}
              autoComplete="username-new" value={username} onChangeText={setUsername}
              placeholder="Choose a username" placeholderTextColor={colors.textFaint} style={styles.input} /></View>}
          <View style={styles.field}><Text style={styles.label}>{creating ? 'Email' : 'Email or username'}</Text>
            <TextInput accessibilityLabel={creating ? 'Email' : 'Email or username'} autoCapitalize="none" autoCorrect={false}
              autoComplete={creating ? 'email' : 'username'} keyboardType={creating ? 'email-address' : 'default'}
              value={email} onChangeText={setEmail} placeholder={creating ? 'you@example.com' : 'Email or username'}
              placeholderTextColor={colors.textFaint} style={styles.input} /></View>
          {resetting && <View style={styles.field}><Text style={styles.label}>Reset code</Text>
            <TextInput accessibilityLabel="Reset code" autoCapitalize="characters" autoCorrect={false} value={code}
              onChangeText={setCode} placeholder="ABCD-2345" placeholderTextColor={colors.textFaint} style={styles.input} /></View>}
          {!(creating && unlocked && !resetting) && <View style={styles.field}><Text style={styles.label}>{resetting ? 'New password' : 'Password'}</Text>
            <TextInput accessibilityLabel={resetting ? 'New password' : 'Password'} secureTextEntry
              autoComplete={creating || resetting ? 'new-password' : 'current-password'} value={password} onChangeText={setPassword}
              placeholder={creating || resetting ? 'At least 12 characters' : 'Your password'}
              placeholderTextColor={colors.textFaint} style={styles.input} /></View>}
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {busy ? <ActivityIndicator color={colors.mint} style={styles.busy} />
            : <PrimaryButton label={resetting ? 'Reset password' : creating ? 'Create profile' : 'Sign in'} onPress={() => void submit()} />}
          </>}
          {!creating && !resetting && <Pressable accessibilityRole="button" onPress={() => { setResetting(true); setError(''); }}
            style={styles.switch}><Text style={styles.switchText}>Forgot password?</Text></Pressable>}
          <Pressable accessibilityRole="button" onPress={() => { if (resetting) setResetting(false); else setCreating(!creating);
            setError(''); }} style={styles.switch}><Text style={styles.switchText}>
              {resetting ? 'Back to sign in' : creating ? 'Already have a profile? Sign in' : 'New to CrownIQ? Create a profile'}</Text></Pressable>
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
  lockTitle: { color: colors.gold, fontSize: 16, fontWeight: '900' },
  contact: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.gold, borderRadius: radius.md, padding: 12 },
  contactText: { color: colors.gold, fontSize: 13, fontWeight: '700', lineHeight: 19 },
  unlocked: { color: colors.mint, fontSize: 14, fontWeight: '800', lineHeight: 20 },
  betaPill: { marginTop: 12, borderWidth: 1.5, borderColor: colors.gold, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 5 },
  betaPillText: { color: colors.gold, fontSize: 12, fontWeight: '900', letterSpacing: 2 },
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
