import type { Analysis, PropLine } from '@crowniq/contracts';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../auth';
import { evidenceDetail, matchup } from '../../components/BoardCard';
import { windows } from '../../components/BoardView';
import { Notice } from '../../components/Screen';
import { Sheet } from '../../components/Sheet';
import { useTipFlow } from '../../components/TipSheet';
import { BooksBadge } from '../../components/ui/BooksBadge';
import { useBooks } from '../../use-books';
import { BookLadder } from '../../components/BookLadder';
import { AppHeader } from '../../components/ui/AppHeader';
import { alpha } from '../../components/ui/color';
import { GhostButton, PrimaryButton, Segmented } from '../../components/ui/Controls';
import { EvidenceBadge } from '../../components/ui/EvidenceBadge';
import { GameBars } from '../../components/ui/GameBars';
import { Icon } from '../../components/ui/Icon';
import { PlayerAvatar } from '../../components/ui/PlayerAvatar';
import { ScoreRing } from '../../components/ui/ScoreRing';
import { scoreBreakdown } from '../../gkr-labels';
import { formatLine, gameTime, lineStats, marketAbbrev, marketLabel, percent, signed } from '../../insights';
import type { Window } from '../../insights';
import { bandColor, bandLabel, colors, lineStyleOf, lineStyles, radius } from '../../theme';
import type { LineStyle } from '../../theme';
import { useBoard } from '../../use-board';
import { useDraft } from '../../use-draft';
import { usePlayerGames } from '../../use-player-games';
import { agreementText, aiPlay, lateNews, providerName, SCOUT, scoutVerdict, useAiPicks, verdictText } from '../../use-ai-picks';

/** GKR couldn't score these (no model for the stat, or its data is missing); ChatGPT and Claude can research them. */
const AI_ELIGIBLE = new Set(['MODEL_SUPPORT_INCOMPLETE', 'STALE_OR_MISSING_EVIDENCE', 'INSUFFICIENT_MODEL_COVERAGE',
  'MODEL_CALIBRATION_UNAPPROVED']);
const askErrors: Readonly<Record<string, string>> = {
  DAILY_LIMIT_REACHED: `You’ve used today’s Ask ${SCOUT} picks. More tomorrow.`,
  GKR_SCORES_THIS_LINE: 'GKR already has a read on this line.', EVENT_STARTED: 'This game has started.',
  AI_UNCONFIGURED: `${SCOUT} is off on this server.`,
};

type TrackedHistory = { label: string; recent: { eventDate: string; actual: number | null; grade: string;
  line: number; direction: string }[] };

function SupportingStat({ line, selected, status, onPress }: { line: PropLine; selected: boolean; status: string;
  onPress: () => void }) {
  const { log } = usePlayerGames(line);
  const avg = lineStats(log, line.threshold, 'MORE', 'L10').average;
  return <Pressable accessibilityRole="button" onPress={onPress} style={[styles.support, selected && styles.supportActive]}>
    <Text style={styles.supportLabel}>{marketAbbrev(line.market)}</Text>
    <Text style={[styles.supportValue, selected && { color: colors.mint }]}>{avg === null ? '—' : avg.toFixed(1)}</Text>
    <Text style={styles.supportSub}>L10 AVG</Text>
    <Text style={[styles.supportStatus, status !== 'PASS' && { color: colors.mint }]} numberOfLines={1}>{status}</Text>
  </Pressable>;
}

function LadderRow({ line, analysis, current, onPress }: { line: PropLine; analysis: Analysis | undefined;
  current: boolean; onPress: () => void }) {
  const direction = analysis?.direction === 'LESS' ? 'LESS' : 'MORE';
  const { log } = usePlayerGames(line);
  const rate = lineStats(log, line.threshold, direction, 'L10').rate;
  const style = lineStyles[lineStyleOf(line.lineType)];
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: current }} onPress={onPress}
    style={[styles.ladderRow, current && styles.ladderActive]}>
    <Text style={styles.ladderLine}>{formatLine(line.threshold)}</Text>
    <Text style={[styles.ladderRate, (rate ?? 0) >= 0.6 && { color: colors.mint }]}>{percent(rate)}</Text>
    <Text style={styles.ladderScore}>{analysis?.score === null || analysis?.score === undefined ? '—' : Math.round(analysis.score)}</Text>
    <Text style={[styles.ladderBand, { color: bandColor(analysis?.scoreBand) }]}>{bandLabel(analysis?.scoreBand)}</Text>
    <View style={[styles.ladderStyle, { borderColor: alpha(style.color, 0.45), backgroundColor: alpha(style.color, 0.08) }]}>
      <Icon name={style.icon} size={14} color={style.color} /><Text style={[styles.ladderStyleText, { color: style.color }]}>
        {style.short}</Text></View>
  </Pressable>;
}

/** Display-only context from the server: injury report, Pinnacle game lines, prediction markets. */
type GameContext = {
  injury: { status: string; injury: string | null; returnDate: string | null; note: string | null } | null;
  teamInjuries: { player: string; position: string | null; status: string }[];
  game: { market: string; home: string; away: string; line: number | null; homeFair: number | null; awayFair: number | null }[];
  markets: { platform: string; question: string; outcomes: { name: string; probability: number }[] }[];
};

function contextLines(context: GameContext, playerName: string): string[] {
  const lines: string[] = [];
  if (context.injury) lines.push(`Injury report: ${context.injury.status}${context.injury.injury ? ` · ${context.injury.injury}` : ''}` +
    `${context.injury.returnDate ? ` · expected back ${context.injury.returnDate}` : ''}`);
  if (context.injury?.note) lines.push(context.injury.note);
  const others = context.teamInjuries.filter((item) => item.player !== playerName);
  if (others.length) lines.push(`Also on the team report: ${others.slice(0, 5).map((item) =>
    `${item.player}${item.position ? ` (${item.position})` : ''} ${item.status}`).join(', ')}`);
  const money = context.game.find((item) => item.market === 'moneyline');
  if (money?.homeFair !== null && money?.homeFair !== undefined && money.awayFair !== null)
    lines.push(`Pinnacle win chance: ${money.home} ${Math.round(money.homeFair * 100)}% · ${money.away} ${Math.round(money.awayFair! * 100)}%`);
  const spread = context.game.find((item) => item.market === 'spread');
  if (spread?.line !== null && spread?.line !== undefined) lines.push(`Pinnacle spread: ${spread.home} ${spread.line > 0 ? '+' : ''}${spread.line}`);
  const total = context.game.find((item) => item.market === 'total');
  if (total?.line !== null && total?.line !== undefined) lines.push(`Pinnacle game total: ${total.line}`);
  for (const market of context.markets) lines.push(`${market.platform === 'kalshi' ? 'Kalshi' : 'Polymarket'}: ${market.question} · ` +
    market.outcomes.slice(0, 3).map((item) => `${item.name} ${Math.round(item.probability)}%`).join(' · '));
  return lines;
}

export default function PlayerResearch() {
  const { request, demo } = useAuth();
  const { lineId } = useLocalSearchParams<{ lineId: string }>();
  const { data, freshness, nowMs } = useBoard();
  const { legs } = useDraft();
  const books = useBooks();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [window, setWindow] = useState<Window>('L5');
  const [notice, setNotice] = useState('');
  const tips = useTipFlow(setNotice);
  const [marketOpen, setMarketOpen] = useState(false);
  const [audit, setAudit] = useState(false);
  const line = data?.board.lines.find((item) => item.id === (selectedId ?? lineId));
  const analyses = useMemo(() => new Map(data?.analyses.map((item) => [item.lineId, item])), [data]);
  const analysis = line ? analyses.get(line.id) : undefined;
  const related = useMemo(() => line ? data?.board.lines.filter((item) => item.eventId === line.eventId &&
    item.playerId === line.playerId) ?? [] : [], [data, line]);
  const ladder = useMemo(() => line ? related.filter((item) => item.market === line.market &&
    item.lineType !== 'UNKNOWN_ALTERNATE').sort((a, b) => a.threshold - b.threshold) : [], [related, line]);
  const markets = useMemo(() => {
    const best = new Map<string, PropLine>();
    for (const item of related) {
      const current = best.get(item.market);
      if (!current || item.lineType === 'REGULAR' && current.lineType !== 'REGULAR') best.set(item.market, item);
    }
    return [...best.values()];
  }, [related]);
  const { reads: aiReads, ask } = useAiPicks();
  const ai = line ? aiReads?.get(line.id) : undefined;
  const [asking, setAsking] = useState(false);
  // Each stat's status: GKR's best play, else the AI read's, else PASS. Choosing a stat opens its best line.
  const statusOf = (market: string): { text: string; lineId: string | null } => {
    const lines = related.filter((item) => item.market === market);
    const gkr = lines.map((item) => ({ item, a: analyses.get(item.id) })).filter(({ a }) => a && a.direction !== 'PASS' && a.score !== null)
      .sort((x, y) => y.a!.score! - x.a!.score!)[0];
    if (gkr) return { text: `GKR ${Math.round(gkr.a!.score!)} ${gkr.a!.direction} ${formatLine(gkr.item.threshold)}`, lineId: gkr.item.id };
    const read = lines.map((item) => ({ item, r: aiReads?.get(item.id) })).filter(({ r }) => aiPlay(r))
      .sort((x, y) => (y.r!.score ?? 0) - (x.r!.score ?? 0))[0];
    if (read) return { text: `${SCOUT} ${read.r!.score} ${read.r!.pick} ${formatLine(read.item.threshold)}`, lineId: read.item.id };
    return { text: 'PASS', lineId: null };
  };
  const aiSide = (!analysis || analysis.direction === 'PASS') && aiPlay(ai) ? ai!.pick as 'MORE' | 'LESS' : null;
  const direction = aiSide ?? (analysis?.direction === 'LESS' ? 'LESS' : 'MORE');
  const { log } = usePlayerGames(line);
  const stats = line ? lineStats(log, line.threshold, direction, window, line.opponent) : null;
  const [history, setHistory] = useState<{ key: string; value: TrackedHistory } | null>(null);
  const [context, setContext] = useState<{ lineId: string; value: GameContext } | null>(null);
  useEffect(() => {
    if (!line || demo) return;
    let active = true;
    void request(`/v1/context/line/${encodeURIComponent(line.id)}`)
      .then((response) => response.ok ? response.json() : null)
      .then((value: GameContext | null) => { if (active && value) setContext({ lineId: line.id, value }); })
      .catch(() => undefined);
    return () => { active = false; };
    // The line id identifies everything shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line?.id, demo]);
  const historyKey = line ? [line.sport, line.playerId, line.market].join('/') : '';
  useEffect(() => {
    if (!line || demo) return;
    let active = true;
    void request(`/v1/history/${encodeURIComponent(line.sport)}/${encodeURIComponent(line.playerId)}/${encodeURIComponent(line.market)}`)
      .then((response) => response.ok ? response.json() : null)
      .then((value: TrackedHistory | null) => { if (active && value?.recent?.length) setHistory({ key: historyKey, value }); })
      .catch(() => undefined);
    return () => { active = false; };
    // historyKey identifies the player and market.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyKey, demo, request]);

  if (!data || !line) return <SafeAreaView style={styles.safe} edges={['top']}><ScrollView contentContainerStyle={styles.content}>
    <AppHeader subtitle="Player Research" back />
    <Notice title="Line unavailable" detail="This line is no longer on the saved board." />
  </ScrollView></SafeAreaView>;

  const started = Date.parse(line.eventStartTime) <= nowMs;
  const pass = (!analysis || analysis.direction === 'PASS') && !aiSide;
  const gkrPass = !analysis || analysis.direction === 'PASS';
  const canAsk = gkrPass && !ai && !started && !demo && (!analysis || !analysis.reasonCode || AI_ELIGIBLE.has(analysis.reasonCode));
  const askAi = async () => {
    setAsking(true); setNotice('');
    const result = await ask(line.id);
    setAsking(false);
    if (result.error) setNotice(askErrors[result.error] ?? 'ChatGPT and Claude couldn’t answer right now. Try again soon.');
  };
  const styleOf = lineStyleOf(line.lineType);
  const pickStyle = (style: LineStyle) => {
    const options = ladder.filter((item) => lineStyleOf(item.lineType) === style);
    const best = options.sort((a, b) => (analyses.get(b.id)?.score ?? -1) - (analyses.get(a.id)?.score ?? -1))[0];
    if (best) setSelectedId(best.id);
  };
  const step = (delta: number) => {
    const index = ladder.findIndex((item) => item.id === line.id);
    const next = ladder[index + delta];
    if (next) setSelectedId(next.id);
  };
  const inCrown = legs.some((leg) => leg.line.id === line.id);
  // GKR's side when it scores one; otherwise the first side PrizePicks offers, as the user's own call.
  const modelSide = !gkrPass && analysis ? analysis.direction as 'MORE' | 'LESS' : aiSide;
  const otherSide = line.availableDirections.find((side) => side !== modelSide) ?? null;
  const addSide = (side: 'MORE' | 'LESS') => tips.attempt(line, analysis, side, `Added ${side} to your Crown.`);
  const addToCrown = () => addSide(modelSide ?? otherSide ?? 'MORE');
  const savePick = () => {
    void request('/v1/me/picks', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineId: line.id }) }).then(async (response) => {
      if (response.ok) setNotice('Saved to your profile. See Results.');
      else if (response.status === 403) setNotice('Demo mode is read-only. Sign in to save picks.');
      else setNotice('This line is stale or unavailable. Refresh the Board.');
    }).catch(() => setNotice('Could not save the pick. Try again online.'));
  };
  const share = () => void Share.share({ message: `CrownIQ research: ${line.playerName} ${marketLabel(line.market)} ` +
    `${pass ? 'PASS' : direction} ${formatLine(line.threshold)} (${lineStyles[styleOf].label}). Confirm the line in PrizePicks.` });
  const breakdown = analysis && !pass ? scoreBreakdown(analysis) : null;
  const photo = data.playerMedia?.[line.playerId]?.photoUrl;

  return <SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView contentContainerStyle={styles.content}>
      <AppHeader subtitle="Player Research" back right={<Pressable accessibilityRole="button" accessibilityLabel="Share"
        onPress={share} style={styles.share}><Icon name="share-variant-outline" size={22} color={colors.text} /></Pressable>} />

      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <PlayerAvatar name={line.playerName} photoUrl={photo} ring={colors.mint} size={92} />
          <View style={styles.identity}>
            <Text style={styles.name} numberOfLines={2}>{line.playerName}</Text>
            <Text style={styles.meta}><Text style={styles.strong}>{line.league}</Text>{line.team ? `   ${line.team}` : ''}</Text>
            <Text style={styles.meta}>{matchup(line)} · {gameTime(line.eventStartTime)}</Text>
          </View>
          <ScoreRing score={analysis?.score ?? null} band={analysis?.scoreBand} size={84} />
        </View>
        <View style={styles.styles}>
          {(['GOBLIN', 'KINGS', 'DEMON'] as const).map((style) => {
            const available = ladder.some((item) => lineStyleOf(item.lineType) === style);
            const meta = lineStyles[style], active = styleOf === style;
            return <Pressable key={style} accessibilityRole="button" disabled={!available}
              accessibilityState={{ selected: active, disabled: !available }} onPress={() => pickStyle(style)}
              style={[styles.styleButton, active && { borderColor: meta.color, backgroundColor: alpha(meta.color, 0.12) },
                !available && styles.dim]}>
              <Icon name={meta.icon} size={20} color={meta.color} />
              <View style={styles.styleCopy}><Text style={[styles.styleName, { color: meta.color }]} numberOfLines={1}>
                {meta.short}</Text><Text style={styles.styleHint} numberOfLines={1}>{meta.hint}</Text></View>
            </Pressable>;
          })}
        </View>
        <View style={styles.pickerRow}>
          <Pressable accessibilityRole="button" onPress={() => setMarketOpen(true)} style={styles.market}>
            <View style={styles.marketCopy}><Text style={styles.small}>Market</Text>
              <Text style={styles.marketName} numberOfLines={1}>{marketLabel(line.market)}</Text></View>
            <Icon name="chevron-down" size={22} color={colors.text} />
          </Pressable>
          <View style={styles.stepper}>
            <Pressable accessibilityRole="button" accessibilityLabel="Lower line" onPress={() => step(-1)} style={styles.stepButton}>
              <Icon name="minus" size={22} color={colors.text} /></Pressable>
            <View style={styles.stepValue}><Text style={styles.small}>{pass ? 'PASS' : direction}</Text>
              <Text style={styles.stepNumber}>{formatLine(line.threshold)}</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Higher line" onPress={() => step(1)} style={styles.stepButton}>
              <Icon name="plus" size={22} color={colors.text} /></Pressable>
          </View>
        </View>
        {ladder.length > 1 && <View style={styles.ladder}>
          <View style={styles.ladderHead}>{['Line', 'L10', 'Score', 'Band', 'Style'].map((label) =>
            <Text key={label} style={styles.ladderHeadText}>{label}</Text>)}</View>
          {ladder.map((item) => <LadderRow key={item.id} line={item} analysis={analyses.get(item.id)}
            current={item.id === line.id} onPress={() => setSelectedId(item.id)} />)}
        </View>}
      </View>

      {started ? <Notice title="Event started" detail="This line can no longer be added or saved." />
        : freshness !== 'DEMO' && <Text style={styles.note}>Saved snapshot. Lines can move near game time; confirm the exact line and direction in PrizePicks within an hour of the start.</Text>}

      <Segmented label="Hit-rate window" options={windows} value={window} onChange={setWindow} />
      <View style={styles.statRow}>
        <View style={styles.statCell}><Text style={styles.small}>HIT RATE</Text>
          <Text style={[styles.statBig, { color: (stats?.rate ?? 0) >= 0.6 ? colors.mint : colors.text }]}>{percent(stats?.rate)}</Text>
          <Text style={styles.statSub}>{stats?.sample ? `${stats.hits}/${stats.sample}` : 'no games'}</Text></View>
        <View style={styles.statCell}><Text style={styles.small}>AVG</Text>
          <Text style={styles.statBig}>{stats?.average === null || !stats ? '—' : stats.average.toFixed(1)}</Text></View>
        <View style={styles.statCell}><Text style={styles.small}>STREAK</Text>
          <Text style={styles.statBig}>{stats?.streak ?? 0}{(stats?.streak ?? 0) >= 3 ? ' 🔥' : ''}</Text></View>
        <View style={styles.statCell}><Text style={styles.small}>DIFF</Text>
          <Text style={[styles.statBig, { color: (stats?.diff ?? 0) > 0 ? colors.mint : colors.red }]}>{signed(stats?.diff)}</Text></View>
      </View>
      <View style={styles.panel}><EvidenceBadge quality={analysis?.evidenceQuality ?? 'NONE'} detail={evidenceDetail(analysis)} /></View>
      <View style={styles.panel}><GameBars games={stats?.games ?? []} threshold={line.threshold} /></View>

      {markets.length > 0 && <View style={styles.section}>
        <Text style={styles.sectionTitle}>Supporting stats</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.supportRow}>
          {markets.map((item) => <SupportingStat key={item.market} line={item} selected={item.market === line.market}
            status={statusOf(item.market).text} onPress={() => setSelectedId(statusOf(item.market).lineId ?? item.id)} />)}
        </ScrollView>
      </View>}

      {breakdown && <View style={styles.section}>
        <Text style={styles.sectionTitle}>Why GKR {Math.round(analysis!.score!)}</Text>
        <View style={styles.panel}>
          <Text style={styles.groupTitle}>Player context · {breakdown.contextTotal.toFixed(1)}</Text>
          {breakdown.context.map((row) => <View key={row.key} style={styles.factor}>
            <View style={styles.factorCopy}><Text style={styles.factorName}>{row.label}</Text>
              {row.detail ? <Text style={styles.factorDetail}>{row.detail}</Text> : null}</View>
            <Text style={[styles.factorValue, !row.measured && styles.factorMissing]}>{row.value}</Text>
          </View>)}
          {breakdown.adjustments.length > 0 && <Text style={[styles.groupTitle, styles.groupGap]}>
            Line adjustments · {signed(breakdown.adjustmentTotal)}</Text>}
          {breakdown.adjustments.map((row) => <View key={row.key} style={styles.factor}>
            <View style={styles.factorCopy}><Text style={styles.factorName}>{row.label}</Text>
              {row.detail ? <Text style={styles.factorDetail}>{row.detail}</Text> : null}</View>
            <Text style={[styles.factorValue, { color: row.contribution >= 0 ? colors.mint : colors.red }]}>{row.value}</Text>
          </View>)}
          <View style={styles.total}><Text style={styles.totalText}>GKR score</Text>
            <Text style={styles.totalValue}>{breakdown.contextTotal.toFixed(1)} {breakdown.adjustmentTotal >= 0 ? '+' : '−'}{' '}
              {Math.abs(breakdown.adjustmentTotal).toFixed(1)} = {analysis!.score!.toFixed(1)}</Text></View>
          <Pressable accessibilityRole="button" onPress={() => setAudit(!audit)}><Text style={styles.link}>
            {audit ? 'Hide audit details' : 'Show audit details'}</Text></Pressable>
          {audit && analysis!.scoreBreakdown.map((item, index) => <Text key={index} style={styles.audit}>
            {item.name}: {item.contribution} · {item.explanation}</Text>)}
        </View>
      </View>}

      {analysis && (analysis.supportingFactors.length > 0 || analysis.opposingFactors.length > 0) && <View style={styles.section}>
        <Text style={styles.sectionTitle}>Supporting and risk factors</Text>
        <View style={styles.panel}>
          {analysis.supportingFactors.map((item, index) => <Text key={`s${index}`} style={styles.factorLine}>
            <Text style={{ color: colors.mint }}>+ </Text>{item}</Text>)}
          {analysis.opposingFactors.map((item, index) => <Text key={`o${index}`} style={styles.factorLine}>
            <Text style={{ color: colors.red }}>− </Text>{item}</Text>)}
        </View>
      </View>}
      {ai && (gkrPass ? ai.kind !== 'second' : ai.kind === 'second') && <View style={styles.section}>
        <Text style={styles.sectionTitle}>{gkrPass ? `${SCOUT} · ${ai.pick === 'PASS' ? 'PASS' : `${ai.pick} ${formatLine(line.threshold)}`}`
          + (ai.score !== null ? ` · ${ai.score}` : '') : `${SCOUT} second opinion · ${verdictText[scoutVerdict(ai, analysis?.direction)!]}`}</Text>
        <View style={styles.panel}>
          <Text style={styles.factorDetail}>{agreementText(ai)}. {gkrPass ? `GKR can’t score this stat yet, so ${SCOUT} (ChatGPT ` +
            `and Claude) researched it. This is ${SCOUT}’s score, not a GKR score.` : `${SCOUT} (ChatGPT and Claude) researched ` +
            `this line on its own, without seeing GKR’s pick${ai.pick === 'PASS' ? '' : `, and picked ${ai.pick} at ${ai.score}`}. ` +
            'GKR’s score is unchanged.'}</Text>
          {!!lateNews(ai) && <Text style={styles.lateNews}>Late news: {lateNews(ai)}</Text>}
          {ai.providers.map((item) => <View key={item.provider} style={styles.aiProvider}>
            <Text style={styles.factorName}>{providerName(item.provider)} · {item.pick}{item.pick !== 'PASS' ? ` · ${item.confidence}` : ''}</Text>
            {!!item.summary && <Text style={styles.factorLine}>{item.summary}</Text>}
            {item.reasons.map((reason, index) => <Text key={index} style={styles.factorDetail}>
              • {reason.text}{reason.url ? <Text style={styles.link} onPress={() => void Linking.openURL(reason.url!)}> (source)</Text> : null}
            </Text>)}
          </View>)}
        </View>
      </View>}
      {canAsk && <GhostButton label={asking ? `${SCOUT} is researching…` : `Ask ${SCOUT} (ChatGPT + Claude)`} icon="binoculars"
        onPress={() => void askAi()} disabled={asking} />}
      {pass && analysis && <Notice title="PASS" detail={analysis.rationale} />}
      {analysis?.reviewStatus === 'SECOND_LOOK' && <Notice title="2nd Look"
        detail="CrownIQ gave this line another research pass after an initial PASS. It is a review flag, not a score bonus." />}
      {!!analysis?.contextEvidenceIds?.length && <Text style={styles.note}>Web context (not scored):{' '}
        {analysis.contextEvidenceIds.length} {analysis.contextEvidenceIds.length === 1 ? 'finding' : 'findings'}.</Text>}
      <BooksBadge view={books?.get(line.id)} side={modelSide} />
      {!started && <BookLadder line={line} />}
      {context?.lineId === line.id && contextLines(context.value, line.playerName).length > 0 && <View style={styles.section}>
        <Text style={styles.sectionTitle}>Game news</Text>
        <View style={styles.panel}>{contextLines(context.value, line.playerName).map((text, index) =>
          <Text key={index} style={styles.factorLine}>{text}</Text>)}
          <Text style={styles.small}>For your information only. Not part of the GKR score.</Text></View>
      </View>}
      {history?.key === historyKey && <View style={styles.section}>
        <Text style={styles.sectionTitle}>{history.value.label}</Text>
        <View style={styles.panel}>{history.value.recent.map((item, index) => <Text key={index} style={styles.factorLine}>
          {item.eventDate} · {item.direction} {item.line} · {item.actual ?? '—'} · {item.grade}</Text>)}</View>
      </View>}
      {!!notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
      {!inCrown && !started && modelSide && otherSide && <Pressable accessibilityRole="button"
        onPress={() => addSide(otherSide)} style={styles.savePick}>
        <Text style={styles.link}>Like {otherSide} instead? Add it as your call</Text></Pressable>}
      <Pressable accessibilityRole="button" onPress={savePick} style={styles.savePick}>
        <Text style={styles.link}>Save this pick to Results</Text></Pressable>
    </ScrollView>

    <View style={styles.footer}>
      <GhostButton label={inCrown ? 'In your Crown' : modelSide ? 'Add to Crown' : `Add ${otherSide ?? 'MORE'}`}
        icon="crown" onPress={addToCrown} disabled={inCrown || started} style={styles.footerButton} />
      <PrimaryButton label="View Crown" icon="arrow-right" onPress={() => router.push('/(tabs)/crown')} style={styles.footerButton} />
    </View>

    {tips.sheet}
    <Sheet visible={marketOpen} title="Market" onClose={() => setMarketOpen(false)}>
      {markets.map((item) => <Pressable key={item.market} accessibilityRole="button" style={styles.marketOption}
        onPress={() => { setSelectedId(statusOf(item.market).lineId ?? item.id); setMarketOpen(false); }}>
        <Text style={styles.marketName}>{marketLabel(item.market)}</Text>
        <Text style={[styles.small, statusOf(item.market).text !== 'PASS' && { color: colors.mint }]}>
          {statusOf(item.market).text === 'PASS' ? `PASS · ${formatLine(item.threshold)}` : statusOf(item.market).text}</Text></Pressable>)}
    </Sheet>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 28, gap: 14 },
  share: { width: 44, height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong,
    alignItems: 'center', justifyContent: 'center' },
  hero: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.xl, padding: 14, gap: 14 },
  heroTop: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  identity: { flex: 1, minWidth: 0, gap: 3 },
  name: { color: colors.text, fontSize: 25, fontWeight: '900' },
  meta: { color: colors.textMuted, fontSize: 14 },
  strong: { color: colors.text, fontWeight: '700' },
  styles: { flexDirection: 'row', gap: 6 },
  styleButton: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1.5, borderColor: colors.borderStrong,
    borderRadius: radius.md, paddingHorizontal: 8, paddingVertical: 8, backgroundColor: colors.surfaceSunken },
  styleCopy: { flex: 1, minWidth: 0 },
  styleName: { fontSize: 12.5, fontWeight: '800' },
  styleHint: { color: colors.textMuted, fontSize: 10.5 },
  dim: { opacity: 0.4 },
  pickerRow: { flexDirection: 'row', gap: 8 },
  market: { flex: 1, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.surfaceSunken },
  marketCopy: { flex: 1, minWidth: 0 },
  small: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  marketName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  stepper: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, backgroundColor: colors.surfaceSunken },
  stepButton: { width: 42, height: 56, alignItems: 'center', justifyContent: 'center' },
  stepValue: { alignItems: 'center', minWidth: 62 },
  stepNumber: { color: colors.text, fontSize: 22, fontWeight: '900' },
  ladder: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: 'hidden' },
  ladderHead: { flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.surfaceSunken },
  ladderHeadText: { flex: 1, color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  ladderRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, minHeight: 46,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  ladderActive: { backgroundColor: colors.mintWash, borderColor: colors.mint, borderWidth: 1.5, borderRadius: radius.sm },
  ladderLine: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '800' },
  ladderRate: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '700' },
  ladderScore: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '800' },
  ladderBand: { flex: 1, fontSize: 11, fontWeight: '800' },
  ladderStyle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderRadius: radius.sm,
    paddingHorizontal: 5, paddingVertical: 3 },
  ladderStyleText: { fontSize: 11, fontWeight: '700' },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  statRow: { flexDirection: 'row', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, paddingVertical: 12 },
  statCell: { flex: 1, alignItems: 'center', gap: 2 },
  statBig: { color: colors.text, fontSize: 23, fontWeight: '900' },
  statSub: { color: colors.textMuted, fontSize: 12 },
  panel: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: 12, gap: 8 },
  section: { gap: 10 },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  supportRow: { gap: 8 },
  support: { width: 92, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, padding: 10,
    backgroundColor: colors.surface },
  supportActive: { borderColor: colors.mint, backgroundColor: colors.mintWash },
  supportLabel: { color: colors.text, fontSize: 13, fontWeight: '800' },
  supportValue: { color: colors.text, fontSize: 22, fontWeight: '900' },
  supportSub: { color: colors.textMuted, fontSize: 11 },
  supportStatus: { color: colors.textFaint, fontSize: 11, fontWeight: '800', marginTop: 2 },
  lateNews: { color: colors.amber, fontSize: 13, lineHeight: 18, fontWeight: '700' },
  aiProvider: { gap: 3, marginTop: 8 },
  groupTitle: { color: colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },
  groupGap: { marginTop: 8 },
  factor: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  factorCopy: { flex: 1, minWidth: 0 },
  factorName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  factorDetail: { color: colors.textMuted, fontSize: 12, lineHeight: 16 },
  factorValue: { color: colors.text, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  factorMissing: { color: colors.textFaint, fontWeight: '600' },
  total: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: colors.border,
    paddingTop: 10, marginTop: 4 },
  totalText: { color: colors.text, fontSize: 14, fontWeight: '800' },
  totalValue: { color: colors.mint, fontSize: 14, fontWeight: '900' },
  link: { color: colors.mint, fontSize: 13, fontWeight: '800' },
  audit: { color: colors.textFaint, fontSize: 11, lineHeight: 15 },
  factorLine: { color: colors.text, fontSize: 13.5, lineHeight: 19 },
  notice: { color: colors.mint, fontSize: 13, fontWeight: '700' },
  savePick: { alignItems: 'center', paddingVertical: 6 },
  footer: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12,
    borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background },
  footerButton: { flex: 1 },
  marketOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 48,
    borderBottomWidth: 1, borderBottomColor: colors.border },
});
