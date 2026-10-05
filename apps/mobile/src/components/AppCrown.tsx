import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { backing, sideLabel } from '../app-lines';
import type { AppLine, Side } from '../app-lines';
import { buildSlip } from '../app-slip';
import { entryName, entryOutlook, formatLine, gameTime, percent1 } from '../insights';
import { appNames, copyAndOpen, slipText } from '../port';
import { SCOUT } from '../scout';
import { colors, radius, rankAccents } from '../theme';
import { useBoard } from '../use-board';
import { usePayouts } from '../use-payouts';
import { alpha } from './ui/color';
import { GhostButton, PrimaryButton } from './ui/Controls';
import { GlowCard } from './ui/GlowCard';
import { Icon } from './ui/Icon';
import { PlayerAvatar } from './ui/PlayerAvatar';

// The Crown generator on Underdog and Pick6 (owner, 2026-10-05): built from that app's own lines and numbers, which
// differ from PrizePicks'. These apps have no Goblins or Demons; a pick's payout multiplier (when the app sets one)
// shows instead. Legs: GKR at 80+, then Scout's plays, then History plays.

type Leg = { line: AppLine; side: Side };
const byLabel = { GKR: 'GKR', SCOUT, HISTORY: 'History' } as const;

export function AppCrown({ app, size }: { app: 'underdog' | 'pick6'; size: number }) {
  const { request, demo } = useAuth();
  const { nowMs } = useBoard();
  const [lines, setLines] = useState<AppLine[] | null>(null);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [built, setBuilt] = useState(0);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    if (demo) { setLines([]); return; }
    const response = await request(`/v1/apps/${app}/board`).catch(() => null);
    const body = response?.ok ? await response.json() as { lines: AppLine[] } : null;
    setLines(body?.lines ?? []);
  }, [app, request, demo]);
  useFocusEffect(useCallback(() => { setLegs([]); setBuilt(0); setMessage(''); void load(); }, [load]));

  const payouts = usePayouts()[app];
  const backedCount = (lines ?? []).filter((line) => backing(line) && Date.parse(line.eventStartTime) > nowMs).length;
  const entry = legs.length >= 2 ? (['FLEX', 'POWER'] as const).flatMap((mode) => {
    const outlook = entryOutlook(payouts, legs.length, mode);
    return outlook ? [{ mode, ...outlook }] : [];
  }).sort((a, b) => a.breakEven - b.breakEven)[0] ?? null : null;
  // Underdog and Pick6 multiply the entry's payout by each pick's own multiplier (a boost above 1x, a cut below).
  const boost = Math.round(legs.reduce((product, leg) => product * (leg.line.multipliers?.[leg.side] ?? 1), 1) * 100) / 100;

  const generate = () => {
    const next = buildSlip(lines ?? [], size, nowMs, built * size, backing);
    setBuilt(built + 1); setLegs(next);
    setMessage(next.length < 2 ? `Fewer than 2 ${appNames[app]} lines are backed right now.`
      : next.length < size ? `Only ${next.length} ${appNames[app]} lines qualify right now.` : '');
  };
  const save = async () => {
    const response = await request('/v1/me/crowns', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app, personal: true, lineIds: legs.map((leg) => leg.line.id),
        directions: Object.fromEntries(legs.map((leg) => [leg.line.id, leg.side])) }) }).catch(() => null);
    setMessage(response?.ok ? 'Saved to Your Picks in Results. It’s graded once the games finish.'
      : response?.status === 403 ? 'Demo mode is read-only. Sign in to save.'
        : 'Could not save. A line may have moved or started; generate again.');
  };
  const copy = () => void copyAndOpen(app, slipText(app, legs.map((leg) => ({ player: leg.line.playerName, stat: leg.line.stat,
    line: leg.line.threshold, side: leg.side })))).then((how) => setMessage(how === 'copied'
    ? `Picks copied. Find each player in ${appNames[app]}.` : `Tap Copy in the share sheet, then find each player in ${appNames[app]}.`))
    .catch(() => undefined);

  return <View style={styles.wrap}>
    <GlowCard accent={colors.mint}>
      <View style={styles.head}><Icon name="crown" size={40} color={colors.neon} />
        <View style={styles.grow}><Text style={styles.title}>{appNames[app]} Crown</Text>
          <Text style={styles.meta}>Built from {appNames[app]}’s own lines and numbers · {lines === null ? 'loading…'
            : `${backedCount} backed lines`}</Text></View></View>
      {entry && <Text style={styles.breakEven}>Play {entryName(legs.length, entry.mode)}: {entry.fullHit}x
        {boost !== 1 ? `, times ${boost} from the picks’ multipliers` : ''}. Each pick needs to hit {percent1(entry.breakEven)} to
        break even.</Text>}
      <View style={styles.actions}>
        <PrimaryButton label={built ? 'Generate New' : 'Generate'} icon="shuffle-variant" style={styles.action}
          disabled={!backedCount} onPress={generate} />
        <GhostButton label="Save" icon="content-save-outline" style={styles.action} disabled={legs.length < 2}
          onPress={() => void save()} />
      </View>
      <Text style={styles.note}>Legs: GKR 80 and up first, then {SCOUT}’s plays, then History plays. One per player, at most
        two per game, at least two teams. {appNames[app]} has no Goblins or Demons; a pick’s own payout shows when the app
        sets one.</Text>
    </GlowCard>
    {!!message && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
    {legs.map((leg, index) => {
      const back = backing(leg.line), accent = rankAccents[index % rankAccents.length];
      const multiplier = leg.line.multipliers?.[leg.side];
      return <View key={leg.line.id} style={[styles.leg, { borderColor: alpha(accent, 0.55) }]}>
        <PlayerAvatar name={leg.line.playerName} photoUrl={leg.line.playerImageUrl} ring={accent} size={52} />
        <View style={styles.grow}>
          <Text style={styles.name} numberOfLines={1}>{leg.line.playerName}</Text>
          <Text style={styles.meta} numberOfLines={1}>{leg.line.league} · {leg.line.team ?? leg.line.eventName} ·{' '}
            {gameTime(leg.line.eventStartTime)}</Text>
          <Text style={styles.pick}>{sideLabel(app, leg.side)} {formatLine(leg.line.threshold)} {leg.line.stat}
            {multiplier && multiplier !== 1 ? ` · ${multiplier}x` : ''}</Text>
        </View>
        {back && <View style={styles.badge}><Text style={styles.badgeBy}>{byLabel[back.by]}</Text>
          <Text style={styles.badgeScore}>{Math.round(back.score)}</Text></View>}
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${leg.line.playerName}`} hitSlop={8}
          onPress={() => setLegs(legs.filter((item) => item !== leg))} style={styles.remove}>
          <Icon name="close" size={18} color={colors.textMuted} /></Pressable>
      </View>;
    })}
    {legs.length >= 2 && <GhostButton label={`Copy picks & open ${appNames[app]}`} icon="open-in-new" onPress={copy} />}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: colors.text, fontSize: 21, fontWeight: '900' },
  meta: { color: colors.textMuted, fontSize: 12.5 },
  breakEven: { color: colors.text, fontSize: 13, lineHeight: 19, marginTop: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  action: { flex: 1 },
  note: { color: colors.textMuted, fontSize: 11.5, lineHeight: 16, marginTop: 12 },
  message: { color: colors.mint, fontSize: 13, fontWeight: '700' },
  leg: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface, borderWidth: 1.5,
    borderRadius: radius.lg, padding: 12 },
  name: { color: colors.text, fontSize: 16, fontWeight: '800' },
  pick: { color: colors.mint, fontSize: 15, fontWeight: '900', marginTop: 3 },
  badge: { alignItems: 'center', minWidth: 52, marginRight: 16 },
  badgeBy: { color: colors.textMuted, fontSize: 11, fontWeight: '800' },
  badgeScore: { color: colors.text, fontSize: 20, fontWeight: '900' },
  remove: { position: 'absolute', top: 8, right: 8 },
});
