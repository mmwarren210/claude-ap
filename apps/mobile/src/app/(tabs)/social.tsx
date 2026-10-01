import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../auth';
import { Notice } from '../../components/Screen';
import { AppHeader } from '../../components/ui/AppHeader';
import { alpha } from '../../components/ui/color';
import { Icon } from '../../components/ui/Icon';
import { PlayerAvatar } from '../../components/ui/PlayerAvatar';
import { formatLine, marketAbbrev } from '../../insights';
import { colors, radius, rankAccents } from '../../theme';

type User = { publicId: string; displayName: string; wins: number; losses: number; pushes: number; graded: number;
  hitRate: number | null };
type Crown = { publicCrownId: string; ownerPublicId: string; createdAt: string; legs: { playerName: string; market: string;
  direction: string; exactLine: number; grade?: string }[] };

function CrownRow({ crown, owner }: { crown: Crown; owner: string | null }) {
  const won = crown.legs.filter((leg) => leg.grade === 'WIN').length;
  const graded = crown.legs.filter((leg) => leg.grade === 'WIN' || leg.grade === 'LOSS').length;
  return <Pressable accessibilityRole="button" style={styles.crown}
    onPress={() => router.push({ pathname: '/social/crown/[id]', params: { id: crown.publicCrownId } })}>
    <View style={styles.crownHead}><Icon name="crown" size={24} color={colors.neon} />
      <Text style={styles.crownTitle}>{crown.legs.length}-leg Crown{owner ? ` · ${owner}` : ''}</Text>
      <Text style={styles.crownDate}>{new Date(crown.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</Text></View>
    <Text style={styles.crownLegs} numberOfLines={2}>{crown.legs.map((leg) =>
      `${leg.playerName} ${marketAbbrev(leg.market)} ${formatLine(leg.exactLine)}${leg.direction === 'MORE' ? '+' : '−'}`).join(' · ')}</Text>
    {graded > 0 && <Text style={styles.crownGraded}>{won}/{graded} legs hit</Text>}
  </Pressable>;
}

export default function SocialScreen() {
  const { request } = useAuth();
  const [users, setUsers] = useState<User[]>([]), [crowns, setCrowns] = useState<Crown[]>([]),
    [following, setFollowing] = useState<Crown[]>([]), [status, setStatus] = useState('Loading public profiles…');
  useFocusEffect(useCallback(() => {
    let active = true;
    void Promise.all([request('/v1/social/top-users'), request('/v1/social/recent-crowns'),
      request('/v1/social/following-crowns')])
      .then(async ([top, recent, followed]) => {
        if (!top.ok || !recent.ok || !followed.ok) throw new Error('Social is unavailable. Try again later.');
        return Promise.all([top.json(), recent.json(), followed.json()]);
      }).then(([top, recent, followed]) => {
        if (!active) return;
        setUsers(top.users ?? []); setCrowns(recent.crowns ?? []); setFollowing(followed.crowns ?? []);
        setStatus('Public Crowns stay private until their owners share them.');
      })
      .catch((error: unknown) => { if (active) setStatus(error instanceof Error ? error.message : 'Social unavailable.'); });
    return () => { active = false; };
  }, [request]));
  const nameOf = (id: string) => users.find((user) => user.publicId === id)?.displayName ?? null;
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView contentContainerStyle={styles.content}>
      <AppHeader subtitle="Community" />
      <View style={styles.sectionHead}><Text style={styles.sectionTitle}>Top 10</Text>
        <Text style={styles.sectionNote}>20+ graded public picks · ranked by wins</Text></View>
      {users.length === 0 ? <Notice title="No qualifying users yet" detail={status} />
        : <View style={styles.board}>{users.map((user, index) => <Pressable key={user.publicId} accessibilityRole="button"
          style={[styles.user, index > 0 && styles.userDivider]}
          onPress={() => router.push({ pathname: '/social/[publicId]', params: { publicId: user.publicId } })}>
          <Text style={[styles.rank, index < 3 && { color: rankAccents[index] }]}>{index + 1}</Text>
          <PlayerAvatar name={user.displayName} size={44} ring={index < 3 ? rankAccents[index] : colors.textMuted} />
          <View style={styles.grow}><Text style={styles.userName}>{user.displayName}</Text>
            <Text style={styles.userMeta}>{user.wins}-{user.losses}-{user.pushes} · {user.graded} graded</Text></View>
          <View style={styles.rate}><Text style={styles.rateValue}>{user.hitRate === null ? '—' : `${Math.round(user.hitRate * 100)}%`}</Text>
            <Text style={styles.userMeta}>hit rate</Text></View>
        </Pressable>)}</View>}
      <View style={styles.sectionHead}><Text style={styles.sectionTitle}>Following</Text></View>
      {following.length === 0 ? <Text style={styles.sectionNote}>Follow a user to see their newest public Crowns here.</Text>
        : following.map((crown) => <CrownRow key={`f-${crown.publicCrownId}`} crown={crown} owner={nameOf(crown.ownerPublicId)} />)}
      <View style={styles.sectionHead}><Text style={styles.sectionTitle}>Recent public Crowns</Text></View>
      {crowns.length === 0 ? <Text style={styles.sectionNote}>No Crowns shared yet.</Text>
        : crowns.map((crown) => <CrownRow key={crown.publicCrownId} crown={crown} owner={nameOf(crown.ownerPublicId)} />)}
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 12 },
  sectionHead: { gap: 2, marginTop: 4 },
  sectionTitle: { color: colors.text, fontSize: 19, fontWeight: '800' },
  sectionNote: { color: colors.textMuted, fontSize: 12.5 },
  board: { backgroundColor: colors.surface, borderWidth: 1.5, borderColor: alpha(colors.mint, 0.45), borderRadius: radius.lg },
  user: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  userDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderStrong },
  rank: { color: colors.textMuted, fontSize: 17, fontWeight: '900', width: 24, textAlign: 'center' },
  grow: { flex: 1, minWidth: 0 },
  userName: { color: colors.text, fontSize: 15.5, fontWeight: '800' },
  userMeta: { color: colors.textMuted, fontSize: 12 },
  rate: { alignItems: 'flex-end' },
  rateValue: { color: colors.mint, fontSize: 17, fontWeight: '900' },
  crown: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 12, gap: 6 },
  crownHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  crownTitle: { color: colors.text, fontSize: 15, fontWeight: '800', flex: 1 },
  crownDate: { color: colors.textMuted, fontSize: 12 },
  crownLegs: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  crownGraded: { color: colors.mint, fontSize: 12.5, fontWeight: '700' },
});
