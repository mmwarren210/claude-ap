import { useCallback, useEffect, useState } from 'react';
import { Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../auth';
import { colors, radius } from '../theme';
import { GhostButton, PrimaryButton } from './ui/Controls';

/** Change password: the current one, then the new one twice. */
export function ChangePassword() {
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [again, setAgain] = useState('');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const save = async () => {
    if (next.length < 12) { setMessage('Use at least 12 characters.'); return; }
    if (next !== again) { setMessage('The two new passwords don’t match.'); return; }
    setBusy(true); setMessage('');
    try { await changePassword(next, current); setCurrent(''); setNext(''); setAgain(''); setMessage('Password changed.'); }
    catch (error) { setMessage(error instanceof Error ? error.message.replace('That family code isn’t right.',
      'Your current password isn’t right.') : 'Could not change your password.'); }
    setBusy(false);
  };
  return <View style={styles.box}>
    <Text style={styles.label}>Change password</Text>
    <TextInput accessibilityLabel="Current password" secureTextEntry autoComplete="current-password" value={current}
      onChangeText={setCurrent} placeholder="Current password" placeholderTextColor={colors.textFaint} style={styles.input} />
    <TextInput accessibilityLabel="New password" secureTextEntry autoComplete="new-password" value={next} onChangeText={setNext}
      placeholder="New password (12+ characters)" placeholderTextColor={colors.textFaint} style={styles.input} />
    <TextInput accessibilityLabel="New password again" secureTextEntry autoComplete="new-password" value={again}
      onChangeText={setAgain} placeholder="New password again" placeholderTextColor={colors.textFaint} style={styles.input} />
    <PrimaryButton label={busy ? 'Saving…' : 'Change password'} icon="lock-reset" disabled={busy} onPress={() => void save()} />
    {!!message && <Text style={styles.note}>{message}</Text>}
  </View>;
}

/** Owner only: a one-time reset code for a member who forgot their password, to pass on to them. */
export function MemberResetCode() {
  const { request } = useAuth();
  const [login, setLogin] = useState(''), [result, setResult] = useState<{ code: string; username: string } | null>(null);
  const [message, setMessage] = useState('');
  const make = async () => {
    setMessage(''); setResult(null);
    const response = await request('/v1/owner/members/reset-code', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: login.trim() }) }).catch(() => null);
    if (!response) { setMessage('Could not reach CrownIQ.'); return; }
    if (response.status === 404) { setMessage('No member with that email or username.'); return; }
    if (!response.ok) { setMessage('Could not make a code. Try again.'); return; }
    setResult(await response.json() as { code: string; username: string });
  };
  const text = result ? `Your CrownIQ reset code is ${result.code} (good for 24 hours). On the sign-in screen tap ` +
    `"Forgot password?", enter your username ${result.username}, this code and a new password.` : '';
  return <View style={styles.box}>
    <Text style={styles.label}>Reset a member’s password</Text>
    <Text style={styles.note}>For someone who forgot theirs. Make a code, send it to them, and they set a new password on
      the sign-in screen. Each code works once and lasts 24 hours.</Text>
    <TextInput accessibilityLabel="Member email or username" autoCapitalize="none" autoCorrect={false} value={login}
      onChangeText={setLogin} placeholder="Their email or username" placeholderTextColor={colors.textFaint} style={styles.input} />
    <PrimaryButton label="Make reset code" icon="key-variant" disabled={!login.trim()} onPress={() => void make()} />
    {!!message && <Text style={styles.note}>{message}</Text>}
    {result && <View style={styles.code}>
      <Text selectable style={styles.codeText}>{result.code}</Text>
      <Text style={styles.note}>For {result.username}. Good for 24 hours.</Text>
      <GhostButton label="Send it to them" icon="share-variant" onPress={() => void Share.share({ message: text })} />
    </View>}
  </View>;
}

type Member = { publicId: string; username: string; email: string | null; plan: 'LIFETIME' | 'MEMBER' | 'GUEST';
  revoked: boolean; createdAt: string };
const planWord: Readonly<Record<Member['plan'], string>> = { LIFETIME: 'Lifetime', MEMBER: 'Member', GUEST: 'Guest' };

/** Owner only: every account, with a button to revoke or restore its access. */
export function MemberAccess() {
  const { request, profile } = useAuth();
  const [members, setMembers] = useState<Member[] | null>(null), [message, setMessage] = useState('');
  const [find, setFind] = useState(''), [armed, setArmed] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const fetchMembers = useCallback(() => request('/v1/owner/members').then(async (response) => response.ok
    ? (await response.json() as { members: Member[] }).members : null).catch(() => null), [request]);
  const load = async () => {
    const list = await fetchMembers();
    if (list) setMembers(list); else setMessage('Could not load members.');
  };
  useEffect(() => {
    let active = true;
    void fetchMembers().then((list) => {
      if (!active) return;
      if (list) setMembers(list); else setMessage('Could not load members.');
    });
    return () => { active = false; };
  }, [fetchMembers]);
  const change = async (member: Member) => {
    // Revoking takes a second tap; restoring doesn't.
    if (!member.revoked && armed !== member.publicId) { setArmed(member.publicId); return; }
    setBusy(true); setArmed(null); setMessage('');
    const response = await request('/v1/owner/members/access', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicId: member.publicId, access: member.revoked ? 'RESTORE' : 'REVOKE' }) }).catch(() => null);
    const code = response && !response.ok ? (await response.json().catch(() => ({})) as { code?: string }).code : null;
    if (!response) setMessage('Could not reach CrownIQ.');
    else if (code === 'MEMBERS_FULL') setMessage('All 100 member seats are taken, so they can’t be restored right now.');
    else if (code === 'CANNOT_REVOKE_OWNER') setMessage('You can’t revoke your own account.');
    else if (!response.ok) setMessage('That didn’t work. Try again.');
    else setMessage(member.revoked ? `${member.username} can sign in again.` : `${member.username} is signed out and can’t sign in.`);
    await load(); setBusy(false);
  };
  const wanted = find.trim().toLowerCase();
  const shown = (members ?? []).filter((item) => !wanted || item.username.toLowerCase().includes(wanted) ||
    (item.email ?? '').toLowerCase().includes(wanted));
  return <View style={styles.box}>
    <Text style={styles.label}>Member access</Text>
    <Text style={styles.note}>Revoke signs someone out right away and stops them signing in. Their seat frees up. Restore
      lets them back in with the same account.</Text>
    <TextInput accessibilityLabel="Find a member" autoCapitalize="none" autoCorrect={false} value={find} onChangeText={setFind}
      placeholder="Find by username or email" placeholderTextColor={colors.textFaint} style={styles.input} />
    {!!message && <Text style={styles.note}>{message}</Text>}
    {members === null ? <Text style={styles.note}>Loading…</Text> : shown.slice(0, 50).map((member) =>
      <View key={member.publicId} style={styles.member}>
        <View style={{ flex: 1 }}>
          <Text style={styles.memberName} numberOfLines={1}>{member.username}</Text>
          <Text style={[styles.note, member.revoked && { color: colors.red }]} numberOfLines={1}>
            {planWord[member.plan]}{member.revoked ? ' · Revoked' : ''}{member.email ? ` · ${member.email}` : ''}</Text>
        </View>
        {member.publicId !== profile?.publicId && <GhostButton disabled={busy}
          label={member.revoked ? 'Restore' : armed === member.publicId ? 'Tap again to revoke' : 'Revoke'}
          icon={member.revoked ? 'account-check' : 'account-cancel'} onPress={() => void change(member)} />}
      </View>)}
    {shown.length > 50 && <Text style={styles.note}>Showing 50 of {shown.length}. Type a name to narrow it down.</Text>}
  </View>;
}

const styles = StyleSheet.create({
  box: { gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderStrong, paddingTop: 14 },
  label: { color: colors.text, fontSize: 14, fontWeight: '700' },
  input: { backgroundColor: colors.surfaceSunken, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    color: colors.text, fontSize: 16, paddingHorizontal: 14, minHeight: 50 },
  note: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  code: { alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.mint, borderRadius: radius.md, padding: 12 },
  codeText: { color: colors.mint, fontSize: 28, fontWeight: '900', letterSpacing: 2 },
  member: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  memberName: { color: colors.text, fontSize: 15, fontWeight: '700' },
});

/** Delete account: confirm with the password (or DELETE for Google and Apple sign-ins), then a second tap. */
export function DeleteAccount() {
  const { request, logout } = useAuth();
  const [confirmation, setConfirmation] = useState(''), [armed, setArmed] = useState(false);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const remove = async () => {
    if (!confirmation) { setMessage('Enter your password first.'); return; }
    if (!armed) { setArmed(true); setMessage('This can’t be undone. Your picks, Crowns and profile are deleted. Tap again to delete.'); return; }
    setBusy(true);
    const response = await request('/v1/auth/delete', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation }) }).catch(() => null);
    setBusy(false); setArmed(false);
    if (response?.ok) { await logout(); return; }
    setMessage(response?.status === 403 ? 'That password isn’t right.' : 'Could not delete your account. Try again.');
  };
  return <View style={styles.box}>
    <Text style={[styles.label, { color: colors.red }]}>Delete account</Text>
    <Text style={styles.note}>Removes your profile, saved picks and Crowns for good. If you signed up with Google or Apple,
      type DELETE instead of a password.</Text>
    <TextInput accessibilityLabel="Password to delete account" secureTextEntry autoComplete="current-password" value={confirmation}
      onChangeText={(value) => { setConfirmation(value); setArmed(false); }} placeholder="Your password"
      placeholderTextColor={colors.textFaint} style={styles.input} />
    <GhostButton label={busy ? 'Deleting…' : armed ? 'Tap again to delete forever' : 'Delete my account'} icon="delete-outline"
      tone={colors.red} disabled={busy} onPress={() => void remove()} />
    {!!message && <Text style={[styles.note, armed && { color: colors.red }]}>{message}</Text>}
  </View>;
}
