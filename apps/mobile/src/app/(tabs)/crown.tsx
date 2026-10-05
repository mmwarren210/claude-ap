import type { Analysis, PropLine } from '@crowniq/contracts';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../auth';
import { matchup } from '../../components/BoardCard';
import { AppHeader } from '../../components/ui/AppHeader';
import { alpha } from '../../components/ui/color';
import { GhostButton, PrimaryButton, Segmented } from '../../components/ui/Controls';
import { GlowCard } from '../../components/ui/GlowCard';
import { useTipFlow } from '../../components/TipSheet';
import { Icon } from '../../components/ui/Icon';
import { LineBadge } from '../../components/ui/LineBadge';
import { PlayerAvatar } from '../../components/ui/PlayerAvatar';
import { ScoreRing } from '../../components/ui/ScoreRing';
import { crownIssueMessage, crownMinimumLineScore, formatLine, entryName, entryOutlook, gameTime, lineStats, marketLabel, percent1, signed } from '../../insights';
import { usePayouts } from '../../use-payouts';
import { pickApps } from '../../components/AppBoard';
import { autoCrown, betterSwap, checkLeg, gkrBacked, shareCrown } from '../../state';
import { PortSheet } from '../../components/PortSheet';
import { appNames } from '../../port';
import type { PickApp } from '../../port';
import type { CrownLeg } from '../../state';
import { colors, lineStyleOf, radius, rankAccents } from '../../theme';
import { useBoard } from '../../use-board';
import { useDraft } from '../../use-draft';
import { usePlayerGames } from '../../use-player-games';
import { useRankings } from '../../use-rankings';
import { ReportNudge } from '../../components/ReportNudge';

const sizes = [2, 3, 4, 5, 6].map((value) => ({ value, label: `Top ${value}` }));

function defaultName(legs: readonly CrownLeg[]): string {
  const counts = { KINGS: 0, GOBLIN: 0, DEMON: 0, UNKNOWN: 0 };
  for (const leg of legs) counts[lineStyleOf(leg.line.lineType)]++;
  if (counts.DEMON > legs.length / 2) return 'Demon Line';
  if (counts.GOBLIN > legs.length / 2) return 'Goblin Line';
  return "King's Crown";
}

function LegCard({ leg, accent, photoUrl, minimum, onRemove, onEdge }: { leg: CrownLeg; accent: string;
  photoUrl: string | null | undefined; minimum: number; onRemove: () => void; onEdge: (edge: number | null) => void }) {
  const { log } = usePlayerGames(leg.line);
  const edge = lineStats(log, leg.line.threshold, leg.direction, 'L10').edge;
  useEffect(() => { onEdge(edge); }, [edge, onEdge]);
  const below = leg.score !== null && leg.score < minimum;
  const yours = leg.score === null || !!leg.yourCall?.length;
  return <View style={[styles.leg, { borderColor: alpha(accent, 0.55) }]}>
    <PlayerAvatar name={leg.line.playerName} photoUrl={photoUrl} ring={accent} size={58} />
    <Pressable accessibilityRole="button" style={styles.legBody}
      onPress={() => router.push({ pathname: '/player/[lineId]', params: { lineId: leg.line.id } })}>
      <Text style={styles.legName} numberOfLines={1}>{leg.line.playerName}</Text>
      <Text style={styles.legMeta} numberOfLines={1}>{leg.line.team ? `${leg.line.team} · ` : ''}{matchup(leg.line)} ·{' '}
        {gameTime(leg.line.eventStartTime)}</Text>
      <View style={styles.legPick}><Text style={styles.legMarket}>{marketLabel(leg.line.market)}</Text>
        <Text style={styles.legLine}>{leg.direction} {formatLine(leg.line.threshold)}</Text></View>
      {below && <Text style={styles.legWarn}>Below the {minimum} minimum for this Crown size</Text>}
      {yours && <Text style={styles.legCall}>Your call{leg.score === null ? ' · no GKR score' : ''}</Text>}
    </Pressable>
    <View style={styles.legSide}>
      <LineBadge lineType={leg.line.lineType} compact />
      <ScoreRing score={leg.score} band={leg.score === null ? 'PASS' : leg.score >= 92 ? 'CROWN_ELITE'
        : leg.score >= 86 ? 'CROWN_STRONG' : leg.score >= 80 ? 'PLAYABLE' : leg.score >= 74 ? 'LEAN' : 'WEAK'} size={54} />
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${leg.line.playerName}`} onPress={onRemove}
      hitSlop={8} style={styles.remove}><Icon name="close" size={18} color={colors.textMuted} /></Pressable>
  </View>;
}

function Suggestion({ line, analysis, photoUrl, onAdd }: { line: PropLine; analysis: Analysis; photoUrl: string | null | undefined;
  onAdd: () => void }) {
  return <View style={styles.suggestion}>
    <View style={styles.suggestionTop}>
      <PlayerAvatar name={line.playerName} photoUrl={photoUrl} size={44} ring={colors.borderStrong} />
      <View style={styles.legBody}><Text style={styles.suggestionName} numberOfLines={1}>{line.playerName}</Text>
        <Text style={styles.legMeta} numberOfLines={1}>{marketLabel(line.market)}</Text>
        <Text style={styles.suggestionLine}>{analysis.direction} {formatLine(line.threshold)}</Text></View>
      <ScoreRing score={analysis.score} band={analysis.scoreBand} size={48} />
    </View>
    <GhostButton label="Add" icon="plus" onPress={onAdd} style={styles.suggestionAdd} />
  </View>;
}

export default function CrownScreen() {
  const { request, demo } = useAuth();
  const { data: board, nowMs } = useBoard();
  const { data: ranked } = useRankings();
  const { legs, remove, replace, hiddenTips, hideTips } = useDraft();
  const [size, setSize] = useState(4);
  const [offset, setOffset] = useState(0);
  const [built, setBuilt] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [edges, setEdges] = useState<Record<string, number | null>>({});
  const [message, setMessage] = useState('');
  const [portApp, setPortApp] = useState<PickApp | null>(null);
  const [playApp, setPlayApp] = useState<PickApp>('prizepicks');
  const tips = useTipFlow(setMessage);
  const [keptLeg, setKeptLeg] = useState<string | null>(null);
  const analyses = useMemo(() => new Map(board?.analyses.map((item) => [item.lineId, item])), [board]);
  const lines = useMemo(() => new Map(board?.board.lines.map((item) => [item.id, item])), [board]);
  const candidates = useMemo(() => (ranked?.rankings ?? []).flatMap((card) => {
    const line = lines.get(card.lineId), analysis = analyses.get(card.lineId);
    return line && analysis && Date.parse(line.eventStartTime) > nowMs ? [{ line, analysis }] : [];
  }), [ranked, lines, analyses, nowMs]);
  const minimum = crownMinimumLineScore[Math.max(2, Math.min(6, legs.length || size))] ?? 80;
  const crownName = name ?? defaultName(legs);
  const scores = legs.flatMap((leg) => leg.score === null ? [] : [leg.score]);
  const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
  const backed = gkrBacked(legs);
  const elite = legs.filter((leg) => analyses.get(leg.line.id)?.evidenceQuality === 'HIGH').length;
  const knownEdges = legs.map((leg) => edges[leg.line.id]).filter((edge): edge is number => typeof edge === 'number');
  const avgEdge = knownEdges.length ? knownEdges.reduce((sum, edge) => sum + edge, 0) / knownEdges.length : null;
  const confidence = average === null ? '—' : average >= 90 ? 'High' : average >= 85 ? 'Strong' : average >= 80 ? 'Solid' : 'Low';
  const payouts = usePayouts();
  const entryLegs = legs.length || size;
  const power = entryOutlook(payouts[playApp], entryLegs, 'POWER'), flex = entryOutlook(payouts[playApp], entryLegs, 'FLEX');
  // The entry that needs the lowest hit rate per pick, which is the one to play when both exist.
  const easier = flex && (!power || flex.breakEven <= power.breakEven) ? { mode: 'FLEX' as const, ...flex }
    : power ? { mode: 'POWER' as const, ...power } : null;
  const suggestions = candidates.filter(({ line }) => !legs.some((leg) => leg.line.id === line.id))
    .filter(({ line, analysis }) => analysis.direction !== 'PASS' &&
      (({ block, tips: advice }) => !block && !advice.length)(checkLeg(legs, line, analysis, analysis.direction, nowMs)))
    .slice(0, 2);
  // A clearly stronger qualified pick for the weakest leg, unless the user hid this tip or kept that leg.
  const swap = hiddenTips.includes('WEAKER_TICKET') ? null : betterSwap(legs, candidates, nowMs);
  const showSwap = swap && swap.weakest.line.id !== keptLeg ? swap : null;

  const generate = () => {
    const next = autoCrown(candidates, size, crownMinimumLineScore[size], built ? offset + 1 : 0, nowMs);
    setOffset(built ? offset + 1 : 0); setBuilt(true); setName(null); replace(next);
    setMessage(next.length < size ? `Only ${next.length} picks meet the ${crownMinimumLineScore[size]} minimum for a ` +
      `${size}-leg Crown right now.` : '');
  };
  const save = async (path: string, done: string) => {
    try {
      if (!backed && path !== '/v1/me/crowns') {
        setMessage('Social only shows Crowns GKR fully backs, so the Top 10 stays fair. Save this one privately or ' +
          'share the text instead.'); return;
      }
      // A Crown with your-call legs saves to the profile as personal: kept, but outside GKR's tracked record.
      // The profile save always sends each leg's side: if GKR's Crown rules turn it down, the server keeps it as
      // the user's own picks instead of dropping it.
      const ids = legs.map((leg) => leg.line.id), directions = Object.fromEntries(legs.map((leg) => [leg.line.id, leg.direction]));
      const response = await request(path, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(backed ? path === '/v1/me/crowns' ? { lineIds: ids, directions } : { lineIds: ids }
          : { lineIds: ids, personal: true, directions }) });
      if (response.ok) {
        const body = await response.json().catch(() => ({})) as { personal?: boolean; belowGkr?: string[] };
        setMessage(path === '/v1/me/crowns' && body.personal ? `Saved to Your Picks in Results. ${backed
          ? 'A leg is under GKR’s bar for this Crown size, so it’s graded with your picks, not GKR’s record.'
          : 'It’s graded there, separate from GKR’s record.'}` : done);
        return;
      }
      const body = await response.json().catch(() => ({})) as { code?: string; issues?: string[] };
      setMessage(body.code === 'DEMO_READ_ONLY' ? 'Demo mode is read-only. Sign in to save Crowns.'
        : crownIssueMessage(body.issues));
    } catch { setMessage('Could not reach CrownIQ. Your draft is still on this device.'); }
  };

  return <SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView contentContainerStyle={styles.content}>
      <AppHeader subtitle="Your Crown" />
      <Segmented label="Crown size" options={sizes} value={size} onChange={setSize} />
      <GlowCard accent={colors.mint}>
        <View style={styles.summary}>
          <Icon name="crown" size={54} color={colors.neon} />
          <View style={styles.summaryCopy}>
            {editing ? <TextInput value={crownName} onChangeText={setName} onBlur={() => setEditing(false)} autoFocus
              style={styles.nameInput} accessibilityLabel="Crown name" maxLength={30} />
              : <Pressable accessibilityRole="button" onPress={() => setEditing(true)} style={styles.nameRow}>
                <Text style={styles.crownName} numberOfLines={1}>{crownName}</Text>
                <Icon name="pencil-outline" size={18} color={colors.textMuted} /></Pressable>}
            <Text style={styles.summaryMeta}>{legs.length} {legs.length === 1 ? 'Leg' : 'Legs'} · {built ? 'Auto-built' : 'Hand-picked'}</Text>
            <View style={styles.confidence}><Icon name="creation" size={15} color={colors.mint} />
              <Text style={styles.confidenceText}>{confidence} confidence</Text></View>
          </View>
        </View>
        <View style={styles.metrics}>
          <View style={styles.metric}><Text style={styles.metricValue}>{average === null ? '—' : average.toFixed(1)}</Text>
            <Text style={styles.metricLabel}>Avg GKR Score</Text></View>
          <View style={[styles.metric, styles.metricDivider]}><Text style={styles.metricValue}>{elite}/{legs.length}</Text>
            <Text style={styles.metricLabel}>Strong Evidence</Text></View>
          <View style={[styles.metric, styles.metricDivider]}><Text style={styles.metricValue}>
            {avgEdge === null ? '—' : `${signed(avgEdge * 100)}%`}</Text><Text style={styles.metricLabel}>Avg Edge</Text></View>
        </View>
      </GlowCard>

      {legs.length === 0 && <View style={styles.empty}><Text style={styles.emptyTitle}>Your Crown is empty</Text>
        <Text style={styles.emptyText}>Add picks from Top Picks or a player’s research screen, or let CrownIQ build one.</Text></View>}
      {legs.map((leg, index) => <LegCard key={leg.line.id} leg={leg} accent={rankAccents[index % rankAccents.length]}
        photoUrl={board?.playerMedia?.[leg.line.playerId]?.photoUrl} minimum={minimum} onRemove={() => remove(leg.line.id)}
        onEdge={(edge) => setEdges((current) => current[leg.line.id] === edge ? current : { ...current, [leg.line.id]: edge })} />)}

      {suggestions.length > 0 && legs.length < 6 && <View style={styles.panel}>
        <View style={styles.panelHead}><Icon name="swap-horizontal" size={22} color={colors.mint} />
          <View style={styles.legBody}><Text style={styles.panelTitle}>Swap Suggestions</Text>
            <Text style={styles.legMeta}>Qualified picks that fit this Crown’s rules</Text></View>
          <Pressable accessibilityRole="button" onPress={() => router.push('/(tabs)/top-picks')}>
            <Text style={styles.link}>View More</Text></Pressable></View>
        <View style={styles.suggestions}>{suggestions.map(({ line, analysis }) => <Suggestion key={line.id} line={line}
          analysis={analysis} photoUrl={board?.playerMedia?.[line.playerId]?.photoUrl}
          onAdd={() => tips.attempt(line, analysis, analysis.direction as 'MORE' | 'LESS', `Added ${line.playerName}.`)} />)}</View>
      </View>}

      {showSwap && <View style={[styles.panel, styles.tipPanel]}>
        <View style={styles.panelHead}><Icon name="lightbulb-on-outline" size={22} color={colors.gold} />
          <View style={styles.legBody}><Text style={styles.panelTitle}>This Crown could be stronger</Text>
            <Text style={styles.legMeta}>{showSwap.weakest.line.playerName} ({showSwap.weakest.score === null ? 'your call'
              : `GKR ${Math.round(showSwap.weakest.score)}`}) is your weakest leg. {showSwap.line.playerName}{' '}
              {marketLabel(showSwap.line.market)} {showSwap.analysis.direction} {formatLine(showSwap.line.threshold)} scores
              GKR {Math.round(showSwap.analysis.score ?? 0)} and fits this Crown.</Text></View></View>
        <Text style={styles.quip}>Just looking out for you. You’re only human, after all.</Text>
        <View style={styles.actions}>
          <PrimaryButton label="Swap it" icon="swap-horizontal" style={styles.action} onPress={() => {
            replace([...legs.filter((leg) => leg !== showSwap.weakest), { line: showSwap.line,
              direction: showSwap.analysis.direction as 'MORE' | 'LESS', score: showSwap.analysis.score,
              modelVersion: showSwap.analysis.modelVersion }]);
            setMessage(`Swapped in ${showSwap.line.playerName}.`);
          }} />
          <GhostButton label="Keep mine" icon="account-check-outline" tone={colors.gold} style={styles.action}
            onPress={() => setKeptLeg(showSwap.weakest.line.id)} />
        </View>
        <Pressable accessibilityRole="button" onPress={() => hideTips(['WEAKER_TICKET'])}>
          <Text style={styles.dismiss}>Don’t show swap tips again</Text></Pressable>
      </View>}

      <GlowCard accent={colors.mint}>
        <View style={styles.panelHead}><Icon name="chart-bar" size={26} color={colors.mint} />
          <View style={styles.legBody}><Text style={styles.panelTitle}>Projected Outcome</Text>
            <Text style={styles.legMeta}>Estimated payout if every leg hits, by app</Text></View></View>
        <View style={styles.appPicker}><Segmented label="Pick'em app" options={pickApps} value={playApp} onChange={setPlayApp} /></View>
        <View style={styles.metrics}>
          <View style={styles.metric}><Text style={styles.metricValue}>{power ? `${power.fullHit}x` : '—'}</Text>
            <Text style={styles.metricLabel}>Power</Text></View>
          <View style={[styles.metric, styles.metricDivider]}><Text style={styles.metricValue}>{flex ? `${flex.fullHit}x` : '—'}</Text>
            <Text style={styles.metricLabel}>Flex</Text></View>
          <View style={[styles.metric, styles.metricDivider]}><Text style={styles.metricValue}>{confidence}</Text>
            <Text style={styles.metricLabel}>Confidence</Text></View>
        </View>
        <Text style={styles.breakEven}>{easier ? `Best play: ${entryName(entryLegs, easier.mode)}. Each pick needs to hit ` +
          `${percent1(easier.breakEven)} of the time to break even.` : `${appNames[playApp]} has no ${entryLegs}-pick entry.`}
          {easier && power && flex ? ` (${easier.mode === 'FLEX' ? 'Power' : 'Flex'} needs ` +
            `${percent1(easier.mode === 'FLEX' ? power.breakEven : flex.breakEven)}.)` : ''}</Text>
        <Text style={styles.disclaimer}>No win probability is shown: CrownIQ’s model is not calibrated yet. Payouts are
          estimates; {appNames[playApp]} sets the real multipliers, which change on Goblins, Demons and some lines.</Text>
        <View style={styles.actions}>
          <PrimaryButton label={built ? 'Generate New' : 'Generate'} icon="shuffle-variant" onPress={generate}
            style={styles.action} disabled={!candidates.length} />
          <GhostButton label="Save Crown" icon="crown" onPress={() => void save('/v1/me/crowns',
            'Saved to GKR Picks in Results. It’s graded once the games finish.')} disabled={legs.length < 2} style={styles.action} />
        </View>
      </GlowCard>
      {!!message && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
      {!backed && legs.length > 0 && <Text style={styles.disclaimer}>This Crown has your-call legs. It saves to your
        profile as a personal Crown, outside GKR’s tracked record and the Social Top 10.</Text>}
      {legs.length >= 2 && <View style={styles.panel}>
        <Text style={styles.panelTitle}>Play it on</Text>
        <Text style={styles.legMeta}>Copy these picks and open the app. Underdog and Pick6 show each player’s line there first.</Text>
        <View style={styles.actions}>{(['prizepicks', 'underdog', 'pick6'] as const).map((app) => <GhostButton key={app}
          label={app === 'pick6' ? 'Pick6' : appNames[app]} style={styles.action} onPress={() => setPortApp(app)} />)}</View>
      </View>}
      {legs.length >= 2 && <View style={styles.actions}>
        <GhostButton label="Share text" icon="share-variant-outline" onPress={() => void Share.share({ message: shareCrown(legs) })}
          style={styles.action} />
        <GhostButton label={demo ? 'Share (sign in)' : 'Share to Social'} icon="account-group-outline" style={styles.action}
          onPress={() => void save('/v1/social/crowns', 'Shared to Social.')} />
      </View>}
      <ReportNudge where="crown" />
    </ScrollView>
    {tips.sheet}
    <PortSheet key={portApp ?? 'closed'} app={portApp} legs={legs} onClose={() => setPortApp(null)} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 14 },
  summary: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  summaryCopy: { flex: 1, minWidth: 0, gap: 3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  crownName: { color: colors.text, fontSize: 23, fontWeight: '900', flexShrink: 1 },
  nameInput: { color: colors.text, fontSize: 21, fontWeight: '800', borderBottomWidth: 1, borderColor: colors.mint, paddingVertical: 2 },
  summaryMeta: { color: colors.textMuted, fontSize: 14 },
  confidence: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  confidenceText: { color: colors.mint, fontSize: 13, fontWeight: '700' },
  metrics: { flexDirection: 'row', marginTop: 14 },
  appPicker: { marginTop: 12 },
  breakEven: { color: colors.text, fontSize: 13, lineHeight: 19, marginTop: 12, fontWeight: '600' },
  metric: { flex: 1, alignItems: 'center', gap: 2 },
  metricDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.borderStrong },
  metricValue: { color: colors.text, fontSize: 20, fontWeight: '900' },
  metricLabel: { color: colors.textMuted, fontSize: 12 },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 14 },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  emptyText: { color: colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  leg: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface, borderWidth: 1.5,
    borderRadius: radius.lg, padding: 12 },
  legBody: { flex: 1, minWidth: 0, gap: 2 },
  legName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  legMeta: { color: colors.textMuted, fontSize: 12.5 },
  legPick: { marginTop: 4, alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.surfaceSunken },
  legMarket: { color: colors.text, fontSize: 12.5, fontWeight: '700' },
  legLine: { color: colors.mint, fontSize: 19, fontWeight: '900' },
  legWarn: { color: colors.amber, fontSize: 11.5, marginTop: 2 },
  legCall: { color: colors.gold, fontSize: 11.5, fontWeight: '700', marginTop: 2 },
  tipPanel: { borderColor: alpha(colors.gold, 0.5), gap: 12 },
  quip: { color: colors.gold, fontSize: 13, fontStyle: 'italic' },
  dismiss: { color: colors.textMuted, fontSize: 13, textAlign: 'center', paddingVertical: 4 },
  legSide: { alignItems: 'center', gap: 6, marginRight: 18 },
  remove: { position: 'absolute', top: 10, right: 8 },
  panel: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: 12, gap: 12 },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  panelTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  link: { color: colors.mint, fontSize: 13, fontWeight: '800' },
  suggestions: { gap: 8 },
  suggestion: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, padding: 10,
    gap: 8, backgroundColor: colors.surfaceSunken },
  suggestionTop: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  suggestionName: { color: colors.text, fontSize: 14, fontWeight: '800' },
  suggestionLine: { color: colors.mint, fontSize: 15, fontWeight: '900' },
  suggestionAdd: { minHeight: 40, paddingHorizontal: 12 },
  disclaimer: { color: colors.textMuted, fontSize: 11.5, lineHeight: 16, marginTop: 12 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  action: { flex: 1 },
  message: { color: colors.mint, fontSize: 13, fontWeight: '700' },
});
