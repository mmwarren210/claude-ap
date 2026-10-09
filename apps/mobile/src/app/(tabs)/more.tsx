import { entryBreakEvens } from '@crowniq/contracts';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { openExternal } from '../../port';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../auth';
import { Sheet } from '../../components/Sheet';
import { AppHeader } from '../../components/ui/AppHeader';
import { alpha } from '../../components/ui/color';
import { PrimaryButton, Segmented } from '../../components/ui/Controls';
import type { IconName } from '../../components/ui/Icon';
import { Icon } from '../../components/ui/Icon';
import { pickApps } from '../../components/AppBoard';
import type { PickApp } from '../../components/AppBoard';
import { entryName, percent1 } from '../../insights';
import { usePayouts } from '../../use-payouts';
import { ChangePassword, DeleteAccount, MemberAccess, MemberResetCode } from '../../components/AccountSecurity';
import { BetaFeedback, FeedbackReview, PatchNotes } from '../../components/Feedback';
import { ScoutQueue } from '../../components/ScoutQueue';
import { colors, radius } from '../../theme';
import { useDraft } from '../../use-draft';
import { gkrPlusAccess, useGkrPlusAccess } from '../../use-gkr-plus';
import { appCommit, isOutdated } from '../../version';

const helpUrl = 'https://www.ncpgambling.org/help-treatment/about-the-national-problem-gambling-helpline/';

function Row({ icon, title, detail, onPress, locked, last }: { icon: IconName; title: string; detail?: string;
  onPress?: () => void; locked?: boolean; last?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={locked || !onPress} onPress={onPress}
    style={[styles.row, !last && styles.rowDivider, locked && styles.locked]}>
    <Icon name={icon} size={24} color={colors.mint} />
    <Text style={styles.rowTitle}>{title}</Text>
    {locked && <Icon name="lock" size={16} color={colors.gold} />}
    <Text style={styles.rowDetail} numberOfLines={1}>{detail}</Text>
    {!locked && onPress && <Icon name="chevron-right" size={22} color={colors.textMuted} />}
  </Pressable>;
}

/** "1 h 5 m" or "12 m". */
const minutesLabel = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} m` : `${minutes} m`;

/** Member activity (owner): minutes on the app per member today, over 7 days and in all, with their most-used tabs. */
function MemberActivity() {
  const { request } = useAuth();
  type Member = { accountId: string; username: string | null; lastSeen: string; todayMinutes: number; weekMinutes: number;
    totalMinutes: number; topTabs: { tab: string; minutes: number }[] };
  const [members, setMembers] = useState<Member[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void request('/v1/owner/activity').then(async (response) => response.ok ? (await response.json() as { members: Member[] }).members : null)
      .then((list) => { if (!active) return; if (list) setMembers(list); else setFailed(true); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [request]);
  if (failed) return <Text style={styles.sheetNote}>Could not load activity. Try again.</Text>;
  if (!members) return <Text style={styles.sheetNote}>Loading…</Text>;
  if (!members.length) return <Text style={styles.sheetNote}>No activity yet. Minutes count while a signed-in member has the app open on screen.</Text>;
  return <>
    <Text style={styles.sheetNote}>Minutes count while a member has the app open on screen (Eastern days). Most recent first.</Text>
    {members.map((member) => <View key={member.accountId} style={styles.secretRow}>
      <View style={styles.secretInfo}>
        <Text style={styles.sheetLabel}>{member.username ?? 'Unknown account'}</Text>
        <Text style={styles.sheetNote}>Today {minutesLabel(member.todayMinutes)} · 7 days {minutesLabel(member.weekMinutes)} · all {minutesLabel(member.totalMinutes)}</Text>
        <Text style={styles.sheetNote}>Last seen {new Date(member.lastSeen).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
          {member.topTabs.length ? ` · most on ${member.topTabs.map((item) => item.tab).join(', ')}` : ''}</Text>
      </View>
    </View>)}
  </>;
}

/** Secrets, owner view: every account that unlocked GKR+, each with Remove (it loses GKR+ on its next load). */
function SecretsOwner() {
  const { request } = useAuth();
  const [rows, setRows] = useState<{ accountId: string; username: string | null; unlockedAt: string }[] | null>(null);
  const [note, setNote] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    void request('/v1/owner/secrets').then(async (response) => response.ok
      ? (await response.json() as { unlocked: { accountId: string; username: string | null; unlockedAt: string }[] }).unlocked : null)
      .then((list) => { if (!active) return; if (list) setRows(list); else setNote('Could not load the list. Try again.'); })
      .catch(() => { if (active) setNote('Could not load the list. Try again.'); });
    return () => { active = false; };
  }, [request, version]);
  const remove = async (accountId: string, name: string) => {
    const response = await request(`/v1/owner/secrets/${encodeURIComponent(accountId)}`, { method: 'DELETE' }).catch(() => null);
    setNote(response?.ok ? `Removed ${name}: GKR+ is locked for them again.` : 'Could not remove. Try again.');
    setVersion((value) => value + 1);
  };
  return <>
    <Text style={styles.sheetNote}>You always have GKR+. These accounts unlocked it with the password; Remove locks it again.</Text>
    {rows === null ? <Text style={styles.sheetNote}>Loading…</Text>
      : !rows.length ? <Text style={styles.sheetNote}>No one has unlocked GKR+ yet.</Text>
      : rows.map((row) => {
        const name = row.username ?? 'Unknown account';
        return <View key={row.accountId} style={styles.secretRow}>
          <View style={styles.secretInfo}>
            <Text style={styles.sheetLabel}>{name}</Text>
            {!!row.unlockedAt && <Text style={styles.sheetNote}>Unlocked {new Date(row.unlockedAt).toLocaleDateString()}</Text>}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${name}`} onPress={() => void remove(row.accountId, name)}>
            <Text style={styles.secretRemove}>Remove</Text></Pressable>
        </View>;
      })}
    {!!note && <Text style={styles.sheetNote}>{note}</Text>}
  </>;
}

/** Secrets: a password that unlocks GKR+ for this account. */
function SecretsUnlock({ unlocked }: { unlocked: boolean }) {
  const { request } = useAuth();
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (unlocked) return <Text style={styles.sheetNote}>GKR+ is unlocked on this account. It&apos;s in the tab bar.</Text>;
  const unlock = async () => {
    setBusy(true); setNote('');
    try {
      const response = await request('/v1/secrets/unlock', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }) });
      if (response.ok) { setPassword(''); setNote('Unlocked: GKR+ is now in your tab bar.'); gkrPlusAccess.changed(); }
      else setNote(response.status === 429 ? 'Too many tries. Wait a minute and try again.' : 'That password doesn’t unlock anything.');
    } catch { setNote('Could not reach CrownIQ. Check your connection.'); }
    finally { setBusy(false); }
  };
  return <>
    <Text style={styles.sheetLabel}>Password</Text>
    <TextInput accessibilityLabel="Secrets password" autoCapitalize="none" autoCorrect={false} secureTextEntry value={password}
      onChangeText={setPassword} onSubmitEditing={() => void unlock()} style={styles.input} placeholder="Enter the password"
      placeholderTextColor={colors.textFaint} />
    <PrimaryButton label={busy ? 'Checking…' : 'Unlock'} onPress={() => { if (!busy && password) void unlock(); }} />
    {!!note && <Text style={styles.sheetNote}>{note}</Text>}
  </>;
}

/** The version row: this copy's build against the server's. Tapping it reloads the app (a home-screen copy has no
 * pull-to-refresh). */
function AppVersion() {
  const { request } = useAuth();
  const [server, setServer] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void request('/v1/version').then(async (response) => response.ok ? (await response.json() as { commit: string | null }).commit : null)
      .then((commit) => { if (active) setServer(commit); }).catch(() => undefined);
    return () => { active = false; };
  }, [request]);
  const old = isOutdated(appCommit, server);
  const version = appCommit ?? server ?? 'unknown';
  return <Row icon={old ? 'update' : 'check-circle-outline'} last title={old ? 'Update ready: tap to load' : 'App version'}
    detail={old ? `${appCommit} → ${server}` : `${version} · up to date · tap to reload`}
    onPress={Platform.OS === 'web' && typeof window !== 'undefined' ? () => window.location.reload() : undefined} />;
}

export default function MoreScreen() {
  const { profile, logout, request, setUsername, demo } = useAuth();
  const { viewMode, setViewMode, ready, hiddenTips, showAllTips } = useDraft();
  const [owner, setOwner] = useState(false);
  const gkrPlus = useGkrPlusAccess();
  const [stats, setStats] = useState<{ picks: number; crowns: number; rate: number | null } | null>(null);
  const { feedback: openFeedback } = useLocalSearchParams<{ feedback?: string }>();
  const [sheet, setSheet] = useState<'account' | 'payouts' | 'feedback' | 'updates' | 'review' | 'scout' | 'secrets' | 'activity' | null>(null);
  // A "report it" nudge elsewhere in the app opens Beta feedback here.
  const [lastOpen, setLastOpen] = useState<string | undefined>(undefined);
  if (openFeedback && openFeedback !== lastOpen && !demo) { setLastOpen(openFeedback); setSheet('feedback'); }
  const [payoutApp, setPayoutApp] = useState<PickApp>('prizepicks');
  const payouts = usePayouts();
  const [name, setName] = useState(profile?.username ?? ''), [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    if (demo) return;
    // Only a clear "not the owner" (404) hides the admin tools; a slow or failed check tries again instead.
    let tries = 0, timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => void request('/v1/owner/research/status').then((response) => {
      if (!active) return;
      if (response.ok) setOwner(true);
      else if (response.status === 404 || response.status === 401) setOwner(false);
      else if (++tries < 4) timer = setTimeout(check, 3000);
    }).catch(() => { if (active && ++tries < 4) timer = setTimeout(check, 3000); });
    check();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [profile?.publicId, request, demo]);
  useFocusEffect(useCallback(() => {
    let active = true;
    void Promise.all([request('/v1/me/picks?limit=50'), request('/v1/me/crowns')]).then(async ([picks, crowns]) => {
      if (!picks.ok || !crowns.ok) return;
      const [p, c] = await Promise.all([picks.json(), crowns.json()]) as [{ total: number; picks: { result: string }[] },
        { crowns: unknown[] }];
      const graded = p.picks.filter((pick) => pick.result === 'WIN' || pick.result === 'LOSS');
      if (active) setStats({ picks: p.total, crowns: c.crowns.length,
        rate: graded.length ? graded.filter((pick) => pick.result === 'WIN').length / graded.length : null });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [request]));
  const rename = async () => {
    try {
      const response = await request('/v1/social/profile', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: name.trim() }) });
      if (response.status === 403) { setMessage('Demo mode is read-only. Sign in to change your username.'); return; }
      if (!response.ok) throw new Error('Taken or invalid');
      setUsername(name.trim()); setMessage('Display username updated.');
    } catch { setMessage('That username is unavailable. Try a different one.'); }
  };
  const go = (path: Href) => router.push(path);
  const plan = profile?.plan === 'DEMO' ? 'Demo' : profile?.plan === 'LIFETIME' ? 'Lifetime Member' : profile?.plan === 'GUEST' ? 'Guest pass · 3 days'
    : profile?.plan === 'FREE' ? 'Free Plan' : profile?.plan ?? 'Free Plan';
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView contentContainerStyle={styles.content}>
      <AppHeader subtitle="Settings & Account" />
      <View style={styles.profile}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{(profile?.username ?? '?').slice(0, 1).toUpperCase()}</Text></View>
        <View style={styles.profileCopy}>
          <Pressable accessibilityRole="button" onPress={() => setSheet('account')} style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>{profile?.username ?? 'Your profile'}</Text>
            <Icon name="pencil-outline" size={18} color={colors.textMuted} /></Pressable>
          <Text style={styles.email} numberOfLines={1}>{profile?.email ?? (demo ? 'No account in demo mode' : 'Provider sign-in')}</Text>
          <View style={styles.plan}><Icon name="crown" size={16} color={colors.neon} /><Text style={styles.planText}>{plan}</Text></View>
        </View>
      </View>
      <View style={styles.stats}>
        <View style={styles.stat}><Text style={styles.statValue}>{stats?.picks ?? '—'}</Text><Text style={styles.statLabel}>Saved picks</Text></View>
        <View style={[styles.stat, styles.statDivider]}><Text style={styles.statValue}>{stats?.crowns ?? '—'}</Text>
          <Text style={styles.statLabel}>Crowns</Text></View>
        <View style={[styles.stat, styles.statDivider]}><Text style={styles.statValue}>
          {stats?.rate === null || !stats ? '—' : `${Math.round(stats.rate * 100)}%`}</Text><Text style={styles.statLabel}>Hit rate</Text></View>
      </View>

      <Text style={styles.heading}>Beta</Text>
      <View style={styles.group}>
        <Row icon="bug-outline" title="Beta feedback" detail="Report a bug or idea" onPress={demo ? undefined : () => setSheet('feedback')} />
        <Row icon="bullhorn-outline" title="Updates" detail="Patches and fixes" onPress={demo ? undefined : () => setSheet('updates')} />
        {owner && <Row icon="clipboard-check-outline" title="Review feedback" detail="Owner" onPress={() => setSheet('review')} />}
        {owner && <Row icon="timer-outline" title="Member activity" detail="Owner · time on the app" onPress={() => setSheet('activity')} />}
        <AppVersion />
      </View>

      <Text style={styles.heading}>App Settings</Text>
      <View style={styles.group}>
        <Row icon="help-circle-outline" title="How to use CrownIQ" detail="What each tab does" onPress={() => go('/guide')} />
        <Row icon="account-outline" title="Account" detail="Display username" onPress={() => setSheet('account')} />
        <Row icon="view-grid-outline" title="Board view" detail={viewMode === 'LITE' ? 'Lite · top qualified' : 'Full · every line'}
          onPress={ready ? () => setViewMode(viewMode === 'LITE' ? 'FULL' : 'LITE') : undefined} />
        <Row icon="cash-multiple" title="Payout estimates" detail="By app" onPress={() => setSheet('payouts')} />
        <Row icon="lightbulb-on-outline" title="Pick tips" detail={hiddenTips.length
          ? `${hiddenTips.length} hidden · tap to show again` : 'On · advice before weaker picks'}
          onPress={hiddenTips.length ? showAllTips : undefined} />
        {owner && <Row icon="image-text" title="Tip check" detail="Owner · upload a service's picks" onPress={() => go('/(tabs)/tips')} />}
        <Row icon="account-group-outline" title="Social" detail="Top 10 and Crowns" onPress={() => go('/(tabs)/social')} />
        <Row icon="key-variant" title="Secrets" detail={gkrPlus ? 'GKR+ unlocked' : 'Enter a password'} onPress={demo ? undefined : () => setSheet('secrets')} />
        <Row icon="lifebuoy" title="Play responsibly" detail="1-800-MY-RESET" last onPress={() => openExternal(helpUrl)} />
      </View>

      <View style={styles.adminHead}><Text style={styles.heading}>Admin Tools</Text>
        {!owner && <View style={styles.ownerOnly}><Icon name="lock" size={16} color={colors.gold} />
          <Text style={styles.ownerText}>Owner only</Text></View>}</View>
      <View style={styles.group}>
        <Row icon="database-outline" title="Data health" detail="Board diagnostics" locked={!owner} onPress={() => go('/owner/board')} />
        <Row icon="refresh" title="Refresh boards" detail="Pull or reanalyze" locked={!owner} onPress={() => go('/owner/board')} />
        <Row icon="magnify" title="Research desk" detail="Private stat research" locked={!owner} onPress={() => go('/owner/research')} />
        <Row icon="binoculars" title="Scout queue" detail="Lines waiting · Ask all" locked={!owner} onPress={() => setSheet('scout')} />
        <Row icon="pulse" title="Learning" detail="Tracked outcomes" locked={!owner} last onPress={() => go('/owner/learning')} />
      </View>

      <Pressable accessibilityRole="button" onPress={() => void logout()} style={styles.logout}>
        <Icon name="logout" size={22} color={colors.red} /><Text style={styles.logoutText}>{demo ? 'Exit demo' : 'Log Out'}</Text>
      </Pressable>
      <Text style={styles.footnote}>CrownIQ analysis is uncertain and no selection is guaranteed. Set limits and take a
        break when you need one. Confidential help: call or text 1-800-MY-RESET.</Text>
    </ScrollView>

    <Sheet visible={sheet === 'account'} title="Account" onClose={() => setSheet(null)}>
      <Text style={styles.sheetLabel}>Display username</Text>
      <TextInput accessibilityLabel="Display username" autoCapitalize="none" autoCorrect={false} value={name}
        onChangeText={setName} style={styles.input} placeholder="Your public username" placeholderTextColor={colors.textFaint} />
      <PrimaryButton label="Update username" onPress={() => void rename()} />
      {!!message && <Text style={styles.sheetNote}>{message}</Text>}
      {!!profile?.publicId && !demo && <Text selectable style={styles.sheetNote}>Profile ID: {profile.publicId}</Text>}
      {!demo && profile?.plan !== 'GUEST' && <ChangePassword />}
      {owner && <MemberResetCode />}
      {owner && <MemberAccess />}
      {!demo && profile?.plan !== 'GUEST' && <DeleteAccount />}
    </Sheet>
    <Sheet visible={sheet === 'feedback'} title="Beta feedback" onClose={() => { setSheet(null); router.setParams({ feedback: undefined }); }}><BetaFeedback /></Sheet>
    <Sheet visible={sheet === 'activity'} title="Member activity" onClose={() => setSheet(null)}>{sheet === 'activity' && <MemberActivity />}</Sheet>
    <Sheet visible={sheet === 'secrets'} title="Secrets" onClose={() => setSheet(null)}>{sheet === 'secrets' && (owner ? <SecretsOwner /> : <SecretsUnlock unlocked={gkrPlus} />)}</Sheet>
    <Sheet visible={sheet === 'updates'} title="Updates" onClose={() => setSheet(null)}><PatchNotes /></Sheet>
    <Sheet visible={sheet === 'scout'} title="Scout queue" onClose={() => setSheet(null)}>{sheet === 'scout' && <ScoutQueue />}</Sheet>
    <Sheet visible={sheet === 'review'} title="Review feedback" onClose={() => setSheet(null)}><FeedbackReview /></Sheet>
    <Sheet visible={sheet === 'payouts'} title="Payout estimates" onClose={() => setSheet(null)}>
      <Segmented label="Pick'em app" options={pickApps} value={payoutApp} onChange={setPayoutApp} />
      <Text style={styles.sheetNote}>“Needs” is how often each pick must hit for that entry to break even; lower is easier.
        These are the apps’ standard payouts. The apps set the real ones and pay less on Goblins, Demons and some lines.</Text>
      {entryBreakEvens(payouts[payoutApp]).map((entry) => <View key={`${entry.mode}${entry.legs}`} style={styles.payoutRow}>
        <Text style={styles.payoutLegs}>{entryName(entry.legs, entry.mode)}</Text>
        <Text style={styles.payoutValues}>{Object.entries(payouts[payoutApp][entry.mode][entry.legs] ?? {})
          .sort((a, b) => Number(b[0]) - Number(a[0])).map(([hits, multiplier]) => `${hits}/${entry.legs}: ${multiplier}x`).join('   ')}</Text>
        <Text style={styles.payoutNeeds}>{percent1(entry.breakEven)}</Text>
      </View>)}
    </Sheet>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 12 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.surface, borderWidth: 1.5,
    borderColor: alpha(colors.mint, 0.5), borderRadius: radius.lg, padding: 14 },
  avatar: { width: 76, height: 76, borderRadius: 38, borderWidth: 2.5, borderColor: colors.mint, alignItems: 'center',
    justifyContent: 'center', backgroundColor: colors.mintWash },
  avatarText: { color: colors.text, fontSize: 32, fontWeight: '800' },
  profileCopy: { flex: 1, minWidth: 0, gap: 4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: colors.text, fontSize: 23, fontWeight: '900', flexShrink: 1 },
  email: { color: colors.textMuted, fontSize: 13 },
  plan: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.mint,
    borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 4 },
  planText: { color: colors.mint, fontSize: 13, fontWeight: '800' },
  stats: { flexDirection: 'row', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    paddingVertical: 12 },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.borderStrong },
  statValue: { color: colors.mint, fontSize: 21, fontWeight: '900' },
  statLabel: { color: colors.textMuted, fontSize: 12 },
  heading: { color: colors.text, fontSize: 19, fontWeight: '800', marginTop: 6 },
  group: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 58 },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderStrong },
  locked: { opacity: 0.6 },
  rowTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  rowDetail: { flex: 1, color: colors.textMuted, fontSize: 13, textAlign: 'right' },
  adminHead: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  ownerOnly: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  ownerText: { color: colors.gold, fontSize: 13, fontWeight: '700' },
  logout: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 54, borderWidth: 1.5,
    borderColor: alpha(colors.red, 0.6), borderRadius: radius.md, backgroundColor: alpha(colors.red, 0.06), marginTop: 6 },
  logoutText: { color: colors.red, fontSize: 16, fontWeight: '800' },
  footnote: { color: colors.textMuted, fontSize: 11.5, lineHeight: 17, textAlign: 'center' },
  sheetLabel: { color: colors.text, fontSize: 14, fontWeight: '700' },
  input: { backgroundColor: colors.surfaceSunken, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    color: colors.text, fontSize: 16, paddingHorizontal: 14, minHeight: 50 },
  secretRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  secretInfo: { flex: 1, gap: 2 },
  secretRemove: { color: colors.red, fontSize: 14, fontWeight: '800' },
  sheetNote: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  payoutRow: { flexDirection: 'row', gap: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderStrong },
  payoutLegs: { color: colors.text, fontSize: 14, fontWeight: '800', width: 104 },
  payoutNeeds: { color: colors.mint, fontSize: 14, fontWeight: '800' },
  payoutValues: { color: colors.textMuted, fontSize: 13, flex: 1 },
});
