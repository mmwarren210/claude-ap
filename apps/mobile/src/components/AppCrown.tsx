import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../auth';
import { backing, sideLabel } from '../app-lines';
import type { AppLine, Backing, Side } from '../app-lines';
import { buildSlip } from '../app-slip';
import { entryName, entryOutlook, formatLine, gameTime, percent1 } from '../insights';
import { appNames, copyAndOpen, slipText } from '../port';
import { SCOUT } from '../scout';
import { colors, radius, rankAccents } from '../theme';
import { useBoard } from '../use-board';
import { usePayouts } from '../use-payouts';
import { alpha } from './ui/color';
import { GhostButton, PrimaryButton, Segmented } from './ui/Controls';
import { useCrownLegs } from '../crown-legs';
import { inSports, SportPicker } from './ui/SportPicker';
import { GlowCard } from './ui/GlowCard';
import { Icon } from './ui/Icon';
import { PlayerAvatar } from './ui/PlayerAvatar';
import { ScoreRing } from './ui/ScoreRing';

// The Crown generator on Underdog and DK Pick'em (owner, 2026-10-05): built from that app's own lines and numbers, laid
// out like the PrizePicks Crown (summary, scored legs, projected payout). These apps have no Goblins or Demons; a pick's
// own payout multiplier shows instead. Legs: GKR at 80+, then Scout's plays, then History plays. It builds one as soon as
// the lines load.

type Leg = { line: AppLine; side: Side };
const byLabel: Readonly<Record<Backing['by'], string>> = { GKR: 'GKR', SCOUT, HISTORY: 'History' };
const ringTint: Readonly<Record<Backing['by'], string | undefined>> = { GKR: undefined, SCOUT: colors.electric, HISTORY: colors.royal };
const band = (score: number) => score >= 92 ? 'CROWN_ELITE' as const : score >= 86 ? 'CROWN_STRONG' as const
  : score >= 80 ? 'PLAYABLE' as const : score >= 74 ? 'LEAN' as const : 'WEAK' as const;

function LegCard({ app, leg, accent, onRemove }: { app: 'underdog' | 'pick6'; leg: Leg; accent: string; onRemove: () => void }) {
  const back = backing(leg.line), multiplier = leg.line.multipliers?.[leg.side];
  return <View style={[styles.leg, { borderColor: alpha(accent, 0.55) }]}>
    <PlayerAvatar name={leg.line.playerName} photoUrl={leg.line.playerImageUrl} ring={accent} size={58} />
    <View style={styles.grow}>
      <Text style={styles.legName} numberOfLines={1}>{leg.line.playerName}</Text>
      <Text style={styles.meta} numberOfLines={1}>{leg.line.team ?? leg.line.league}{leg.line.opponent ? ` · vs ${leg.line.opponent}` : ''} ·{' '}
        {gameTime(leg.line.eventStartTime)}</Text>
      <View style={styles.legPick}><Text style={styles.legMarket} numberOfLines={1}>{leg.line.stat}</Text>
        <Text style={styles.legLine}>{sideLabel(app, leg.side).toUpperCase()} {formatLine(leg.line.threshold)}</Text></View>
      {back?.by === 'HISTORY' && !!leg.line.history?.text && <Text style={styles.why} numberOfLines={2}>{leg.line.history.text}</Text>}
    </View>
    <View style={styles.side}>
      {!!multiplier && multiplier !== 1 && <Text style={[styles.tag, multiplier > 1 ? styles.boost : styles.cut]}>
        {multiplier > 1 ? 'BOOST' : 'PAYS'} {multiplier}x</Text>}
      {back && <ScoreRing score={back.score} size={56} band={back.by === 'GKR' ? band(back.score) : undefined} who={byLabel[back.by]}
        {...(back.by === 'GKR' ? {} : { label: byLabel[back.by].toUpperCase(), tint: ringTint[back.by] })} />}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${leg.line.playerName}`} hitSlop={8} onPress={onRemove}
      style={styles.remove}><Icon name="close" size={18} color={colors.textMuted} /></Pressable>
  </View>;
}

export function AppCrown({ app, size }: { app: 'underdog' | 'pick6'; size: number }) {
  const { request, demo } = useAuth();
  const { nowMs } = useBoard();
  const [lines, setLines] = useState<AppLine[] | null>(null);
  // Picks added on the board, or the last generated Crown (shared with the board); until then, one built from the lines.
  const [stored, setStored] = useCrownLegs<Leg>(app);
  const [kind, setKind] = useState<'ANY' | 'STANDARD' | 'BOOSTED' | 'GKR'>('ANY');
  const [sports, setSports] = useState<string[]>([]);
  const [built, setBuilt] = useState(0);
  const [name, setName] = useState<string | null>(null), [editing, setEditing] = useState(false);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    if (demo) { setLines([]); return; }
    const response = await request(`/v1/apps/${app}/board`).catch(() => null);
    const body = response?.ok ? await response.json() as { lines: AppLine[] } : null;
    setLines(body?.lines ?? []);
  }, [app, request, demo]);
  useFocusEffect(useCallback(() => { setBuilt(0); setMessage(''); setLines(null); void load(); }, [load]));

  const payouts = usePayouts()[app];
  // The line type to build from: any backed line, standard payouts only, boosted picks only, or GKR's picks only.
  const pickOf = useCallback((line: AppLine) => {
    const back = backing(line);
    if (!back || !inSports(sports, line.league)) return null;
    const multiplier = line.multipliers?.[back.side] ?? 1;
    if (kind === 'STANDARD' && multiplier !== 1 || kind === 'BOOSTED' && multiplier <= 1.01 || kind === 'GKR' && back.by !== 'GKR') return null;
    return back;
  }, [kind, sports]);
  const first = useMemo(() => buildSlip(lines ?? [], size, nowMs, 0, pickOf), [lines, size, nowMs, pickOf]);
  const legs: readonly Leg[] = stored.length ? stored : first;
  const backedCount = (lines ?? []).filter((line) => backing(line) && Date.parse(line.eventStartTime) > nowMs).length;
  const setLegs = (next: readonly Leg[]) => setStored(next);
  const generate = (round: number) => {
    const next = buildSlip(lines ?? [], size, nowMs, round * size, pickOf);
    setBuilt(round + 1); setLegs(next); setName(null);
    setMessage(next.length < 2 ? `Fewer than 2 ${appNames[app]} lines are backed right now.`
      : next.length < size ? `Only ${next.length} ${appNames[app]} lines qualify right now.` : '');
  };

  const backs = legs.map((leg) => backing(leg.line)).filter((item): item is Backing => !!item);
  const average = backs.length ? backs.reduce((sum, item) => sum + item.score, 0) / backs.length : null;
  const gkrLegs = backs.filter((item) => item.by === 'GKR').length;
  const confidence = average === null ? '—' : average >= 90 ? 'High' : average >= 85 ? 'Strong' : average >= 75 ? 'Solid' : 'Low';
  const crownName = name ?? `${appNames[app]} Crown`;
  // Underdog and DK Pick'em multiply the entry's payout by each pick's own multiplier (a boost above 1x, a cut below).
  const boost = Math.round(legs.reduce((product, leg) => product * (leg.line.multipliers?.[leg.side] ?? 1), 1) * 100) / 100;
  const outlook = (mode: 'POWER' | 'FLEX') => legs.length >= 2 ? entryOutlook(payouts, legs.length, mode) : null;
  const power = outlook('POWER'), flex = outlook('FLEX');
  const easier = flex && (!power || flex.breakEven <= power.breakEven) ? { mode: 'FLEX' as const, ...flex }
    : power ? { mode: 'POWER' as const, ...power } : null;
  const times = (value: number) => `${Math.round(value * boost * 100) / 100}x`;

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
    <SportPicker options={[...new Set((lines ?? []).map((line) => line.league))].sort()} selected={sports}
      onChange={(next) => { setSports(next); setStored([]); setBuilt(0); }} />
    <Segmented label="Line type" value={kind} onChange={(value) => { setKind(value); setStored([]); setBuilt(0); }}
      options={[{ value: 'ANY' as const, label: 'Any' }, { value: 'STANDARD' as const, label: 'Standard' },
        { value: 'BOOSTED' as const, label: 'Boosted' }, { value: 'GKR' as const, label: 'GKR only' }]} />
    <GlowCard accent={colors.mint}>
      <View style={styles.head}>
        <Icon name="crown" size={54} color={colors.neon} />
        <View style={styles.grow}>
          {editing ? <TextInput value={crownName} onChangeText={setName} onBlur={() => setEditing(false)} autoFocus maxLength={30}
            style={styles.nameInput} accessibilityLabel="Crown name" />
            : <Pressable accessibilityRole="button" onPress={() => setEditing(true)} style={styles.nameRow}>
              <Text style={styles.title} numberOfLines={1}>{crownName}</Text>
              <Icon name="pencil-outline" size={18} color={colors.textMuted} /></Pressable>}
          <Text style={styles.meta}>{legs.length} {legs.length === 1 ? 'Leg' : 'Legs'} · {stored.length && !built ? 'Hand-picked' : 'Auto-built'} from {appNames[app]}’s own lines ·
            {' '}{lines === null ? 'loading…' : `${backedCount} backed`}</Text>
          <View style={styles.confidence}><Icon name="creation" size={15} color={colors.mint} />
            <Text style={styles.confidenceText}>{confidence} confidence</Text></View>
        </View>
      </View>
      <View style={styles.metrics}>
        <View style={styles.metric}><Text style={styles.metricValue}>{average === null ? '—' : average.toFixed(1)}</Text>
          <Text style={styles.metricLabel}>Avg Score</Text></View>
        <View style={[styles.metric, styles.divider]}><Text style={styles.metricValue}>{gkrLegs}/{legs.length}</Text>
          <Text style={styles.metricLabel}>GKR legs</Text></View>
        <View style={[styles.metric, styles.divider]}><Text style={styles.metricValue}>{boost === 1 ? '—' : `${boost}x`}</Text>
          <Text style={styles.metricLabel}>Pick payouts</Text></View>
      </View>
    </GlowCard>

    {!!message && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
    {legs.map((leg, index) => <LegCard key={leg.line.id} app={app} leg={leg} accent={rankAccents[index % rankAccents.length]}
      onRemove={() => setLegs(legs.filter((item) => item !== leg))} />)}

    <GlowCard accent={colors.mint}>
      <View style={styles.head}><Icon name="chart-bar" size={26} color={colors.mint} />
        <View style={styles.grow}><Text style={styles.panelTitle}>Projected Outcome</Text>
          <Text style={styles.meta}>Estimated {appNames[app]} payout if every leg hits</Text></View></View>
      <View style={styles.metrics}>
        <View style={styles.metric}><Text style={styles.metricValue}>{power ? times(power.fullHit) : '—'}</Text>
          <Text style={styles.metricLabel}>{app === 'underdog' ? 'Standard' : 'Power'}</Text></View>
        <View style={[styles.metric, styles.divider]}><Text style={styles.metricValue}>{flex ? times(flex.fullHit) : '—'}</Text>
          <Text style={styles.metricLabel}>Flex</Text></View>
        <View style={[styles.metric, styles.divider]}><Text style={styles.metricValue}>{confidence}</Text>
          <Text style={styles.metricLabel}>Confidence</Text></View>
      </View>
      <Text style={styles.breakEven}>{easier ? `Best play: ${entryName(legs.length, easier.mode)}. Each pick needs to hit ` +
        `${percent1(easier.breakEven)} of the time to break even.` : legs.length >= 2
        ? `CrownIQ doesn’t have ${appNames[app]}’s ${legs.length}-pick payout yet. Check it in the app before you play.` : ''}
        {boost !== 1 ? ` Payouts include the picks’ own multipliers (${boost}x).` : ''}</Text>
      <View style={styles.actions}>
        <PrimaryButton label={built ? 'Generate New' : 'Generate'} icon="shuffle-variant" style={styles.action}
          disabled={!backedCount} onPress={() => generate(built || 1)} />
        <GhostButton label="Save Crown" icon="crown" style={styles.action} disabled={legs.length < 2} onPress={() => void save()} />
      </View>
    </GlowCard>
    {legs.length >= 2 && <GhostButton label={`Copy picks & open ${appNames[app]}`} icon="open-in-new" onPress={copy} />}
    {stored.length > 0 && <GhostButton label="Clear Crown" icon="close" onPress={() => { setStored([]); setBuilt(0); }} />}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0, gap: 3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: colors.text, fontSize: 23, fontWeight: '900', flexShrink: 1 },
  nameInput: { color: colors.text, fontSize: 21, fontWeight: '800', borderBottomWidth: 1, borderColor: colors.mint, paddingVertical: 2 },
  meta: { color: colors.textMuted, fontSize: 13 },
  confidence: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  confidenceText: { color: colors.mint, fontSize: 13, fontWeight: '700' },
  metrics: { flexDirection: 'row', marginTop: 14 },
  metric: { flex: 1, alignItems: 'center', gap: 2 },
  divider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.borderStrong },
  metricValue: { color: colors.text, fontSize: 20, fontWeight: '900' },
  metricLabel: { color: colors.textMuted, fontSize: 12 },
  panelTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  breakEven: { color: colors.text, fontSize: 13, lineHeight: 19, marginTop: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  action: { flex: 1 },
  note: { color: colors.textMuted, fontSize: 11.5, lineHeight: 16, marginTop: 12 },
  message: { color: colors.mint, fontSize: 13, fontWeight: '700' },
  leg: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface, borderWidth: 1.5,
    borderRadius: radius.lg, padding: 12 },
  legName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  legPick: { marginTop: 4, alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.surfaceSunken },
  legMarket: { color: colors.text, fontSize: 12.5, fontWeight: '700' },
  legLine: { color: colors.mint, fontSize: 19, fontWeight: '900' },
  why: { color: colors.textMuted, fontSize: 11.5, marginTop: 2 },
  side: { alignItems: 'center', gap: 6, marginRight: 18 },
  tag: { fontSize: 10.5, fontWeight: '900', borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  boost: { color: colors.mint, borderColor: colors.mint },
  cut: { color: colors.amber, borderColor: colors.amber },
  remove: { position: 'absolute', top: 10, right: 8 },
});
