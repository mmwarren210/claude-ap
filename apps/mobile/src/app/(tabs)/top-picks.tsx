import type { Analysis, RankingCard, SecondLookCard } from '@crowniq/contracts';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { evidenceDetail, matchup } from '../../components/BoardCard';
import { optionLabel } from '../../components/FilterSheet';
import { Notice } from '../../components/Screen';
import { Sheet } from '../../components/Sheet';
import { AppHeader } from '../../components/ui/AppHeader';
import { alpha } from '../../components/ui/color';
import { ChipRow, FilterChip, PrimaryButton, Segmented } from '../../components/ui/Controls';
import { Icon } from '../../components/ui/Icon';
import { LineBadge } from '../../components/ui/LineBadge';
import { PlayerAvatar } from '../../components/ui/PlayerAvatar';
import { ScoreRing } from '../../components/ui/ScoreRing';
import { rateTone, StatStrip } from '../../components/ui/StatStrip';
import { formatLine, gameTime, lineStats, marketLabel, percent } from '../../insights';
import { colors, radius, rankAccents } from '../../theme';
import { useAuth } from '../../auth';
import { BooksBadge } from '../../components/ui/BooksBadge';
import { useBooks } from '../../use-books';
import { useBoard } from '../../use-board';
import { useTipFlow } from '../../components/TipSheet';
import { usePlayerGames } from '../../use-player-games';
import { useRankings } from '../../use-rankings';
import { ScoutVerdict } from '../../components/ScoutVerdict';
import { useAiPicks } from '../../use-ai-picks';
import type { AiRead } from '../../use-ai-picks';

type Card = RankingCard | SecondLookCard;
type ListFilter = { sport: string; date: string; lineType: string };
const sizes = [2, 3, 4, 5, 6].map((value) => ({ value, label: `Top ${value}` }));

function insight(card: Card, l10: ReturnType<typeof lineStats>, l5: ReturnType<typeof lineStats>,
  analysis: Analysis | undefined): { icon: 'file-document-outline' | 'signal-cellular-3'; title: string; detail: string } {
  if (l10.rate !== null && l10.rate >= 0.7) return { icon: 'file-document-outline', title: 'HISTORY', detail: 'Strong L10 trend' };
  if (l5.rate !== null && l5.rate >= 0.8) return { icon: 'file-document-outline', title: 'HISTORY', detail: 'Strong L5 trend' };
  return { icon: 'signal-cellular-3', title: 'CONTEXT', detail: card.dangerZone ? 'Close to the line'
    : evidenceDetail(analysis) };
}

function PickCard({ card, rank, accent, photoUrl, analysis, scout, onAdd }: { card: Card; rank: number | null;
  accent: string; photoUrl: string | null | undefined; analysis: Analysis | undefined; scout?: AiRead; onAdd: () => void }) {
  const { log } = usePlayerGames(card);
  const l5 = lineStats(log, card.threshold, card.direction, 'L5');
  const l10 = lineStats(log, card.threshold, card.direction, 'L10');
  const h2h = lineStats(log, card.threshold, card.direction, 'H2H', card.opponent);
  const note = insight(card, l10, l5, analysis);
  const books = useBooks();
  return <View style={[styles.card, { borderColor: alpha(accent, 0.6), shadowColor: accent }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`View ${card.playerName}`} style={styles.tap}
      onPress={() => router.push({ pathname: '/player/[lineId]', params: { lineId: card.lineId } })}>
    <View style={styles.top}>
      <Text style={[styles.rank, { color: accent }]}>{rank === null ? '2nd' : `#${rank}`}</Text>
      <PlayerAvatar name={card.playerName} photoUrl={photoUrl} ring={accent} size={64} />
      <View style={styles.identity}>
        <Text style={styles.name} numberOfLines={1}>{card.playerName}</Text>
        <Text style={styles.meta} numberOfLines={1}><Text style={styles.strong}>{card.league}</Text>
          {card.team ? `   ${card.team}` : ''}</Text>
        <Text style={styles.meta} numberOfLines={1}>{matchup(card)} ·{' '}
          {gameTime(card.eventStartTime)}</Text>
      </View>
      <LineBadge lineType={card.lineType} compact />
    </View>
    <View style={styles.middle}>
      <View style={styles.lineBox}>
        <Text style={styles.market} numberOfLines={1}>{marketLabel(card.market)}</Text>
        <Text style={styles.pick} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {card.direction} {formatLine(card.threshold)}</Text>
      </View>
      <ScoreRing score={card.score} band={card.scoreBand} size={68} />
      <View style={styles.insight}>
        <Icon name={note.icon} size={20} color={colors.mint} />
        <Text style={styles.insightTitle}>{note.title}</Text>
        <Text style={styles.insightText} numberOfLines={2}>{note.detail}</Text>
      </View>
    </View>
    <View style={styles.strip}><StatStrip stats={[
      { label: 'L5', value: percent(l5.rate), tone: rateTone(l5.rate) },
      { label: 'L10', value: percent(l10.rate), tone: rateTone(l10.rate) },
      { label: 'AVG', value: l10.average === null ? '—' : l10.average.toFixed(1) },
      { label: card.opponent ? `vs ${card.opponent}` : 'H2H', value: h2h.average === null ? '—' : h2h.average.toFixed(1) },
    ]} /></View>
    <BooksBadge view={books?.get(card.lineId)} side={card.direction} />
    <ScoutVerdict read={scout} gkrDirection={card.direction} />
    </Pressable>
    <PrimaryButton label="Add to Crown" icon="plus" onPress={onAdd} />
  </View>;
}

/** One +EV pick from the server: sportsbooks' no-vig chance at the same number against the break-even. */
type EvPick = { lineId: string; playerName: string; market: string; threshold: number; side: 'MORE' | 'LESS';
  eventStartTime: string; fairProbability: number; edge: number;
  books: { book: string; fair: number }[]; gkr: { direction: string; score: number | null } | null };
type EvResponse = { fetchedAt: string | null; breakEven: number; picks: EvPick[] };
const bookNames: Readonly<Record<string, string>> = { draftkings: 'DraftKings', hardrock: 'Hard Rock' };

function EvCard({ pick, onAdd }: { pick: EvPick; onAdd: () => void }) {
  const agrees = pick.gkr && pick.gkr.direction === pick.side && pick.gkr.score !== null;
  const gkrText = !pick.gkr ? 'Not on the GKR board' : pick.gkr.direction === 'PASS' ? 'GKR: PASS on this line'
    : agrees ? `GKR agrees: ${pick.gkr.direction} · ${Math.round(pick.gkr.score!)}` : `GKR leans ${pick.gkr.direction}`;
  return <Pressable accessibilityRole="button" style={styles.evCard}
    onPress={() => router.push({ pathname: '/player/[lineId]', params: { lineId: pick.lineId } })}>
    <View style={styles.evTop}>
      <View style={styles.evBody}>
        <Text style={styles.evName} numberOfLines={1}>{pick.playerName}</Text>
        <Text style={styles.evPick}>{marketLabel(pick.market)} · {pick.side} {formatLine(pick.threshold)}</Text>
        <Text style={styles.note}>{gameTime(pick.eventStartTime)}</Text>
      </View>
      <View style={styles.evNumbers}>
        <Text style={styles.evEdge}>+{(pick.edge * 100).toFixed(1)}%</Text>
        <Text style={styles.note}>fair {(pick.fairProbability * 100).toFixed(1)}%</Text>
      </View>
    </View>
    <Text style={styles.note}>{pick.books.map((book) => `${bookNames[book.book] ?? book.book} ${(book.fair * 100).toFixed(1)}%`).join(' · ')}</Text>
    <View style={styles.evTop}>
      <Text style={[styles.note, agrees && styles.evAgree]}>{gkrText}</Text>
      <Pressable accessibilityRole="button" onPress={onAdd} hitSlop={8}><Text style={styles.link}>Add to Crown</Text></Pressable>
    </View>
  </Pressable>;
}

export default function TopPicksScreen() {
  const { request, demo } = useAuth();
  const [mode, setMode] = useState<'GKR' | 'EV'>('GKR');
  const { reads: scoutReads } = useAiPicks();
  const [ev, setEv] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; value: EvResponse | null }>({ status: 'idle', value: null });
  useEffect(() => {
    if (mode !== 'EV' || demo) return;
    let active = true;
    void request('/v1/ev').then(async (response) => {
      if (!active) return;
      setEv(response.ok ? { status: 'ready', value: await response.json() as EvResponse } : { status: 'error', value: null });
    }).catch(() => { if (active) setEv({ status: 'error', value: null }); });
    return () => { active = false; };
  }, [mode, demo, request]);
  const { data: board, nowMs, freshness } = useBoard();
  const { status, data, message, retry } = useRankings();
  const [size, setSize] = useState(5);
  const [filter, setFilter] = useState<ListFilter>({ sport: 'ALL', date: 'ALL', lineType: 'ALL' });
  const [sheet, setSheet] = useState<keyof ListFilter | null>(null);
  const [notice, setNotice] = useState('');
  const tips = useTipFlow(setNotice);
  const lineById = useMemo(() => new Map(board?.board.lines.map((line) => [line.id, line])), [board]);
  const analysisById = useMemo(() => new Map(board?.analyses.map((item) => [item.lineId, item])), [board]);
  const keep = (card: Card) => Date.parse(card.eventStartTime) > nowMs &&
    (filter.sport === 'ALL' || card.sport === filter.sport) &&
    (filter.lineType === 'ALL' || card.lineType === filter.lineType) &&
    (filter.date === 'ALL' || card.eventStartTime.slice(0, 10) === filter.date);
  const rankings = (data?.rankings ?? []).filter(keep);
  const watchlist = (data?.watchlist ?? []).filter(keep);
  const options: Record<keyof ListFilter, string[]> = {
    sport: [...new Set((data?.rankings ?? []).map((card) => card.sport))],
    date: [...new Set((data?.rankings ?? []).map((card) => card.eventStartTime.slice(0, 10)))].sort(),
    lineType: ['REGULAR', 'GOBLIN', 'DEMON'],
  };
  const addCard = (card: Card) => {
    const line = lineById.get(card.lineId), analysis = analysisById.get(card.lineId);
    if (!line || !analysis || analysis.direction === 'PASS') { setNotice('That line is no longer on the board.'); return; }
    tips.attempt(line, analysis, analysis.direction, `Added ${card.playerName} to your Crown.`);
  };
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView contentContainerStyle={styles.content}>
      <AppHeader subtitle="Top Picks" />
      <Segmented label="Pick list" options={[{ value: 'GKR' as const, label: 'GKR picks' }, { value: 'EV' as const, label: '+EV' }]}
        value={mode} onChange={setMode} />
      {mode === 'EV' ? <>
        <Text style={styles.sectionText}>Sportsbooks’ no-vig chance for the same player, stat and number, against the
          {` ${((ev.value?.breakEven ?? 0.5421) * 100).toFixed(1)}%`} PrizePicks’ easiest entry needs per pick. Standard lines only.
          Separate from GKR scores.</Text>
        {demo ? <Notice title="+EV needs a profile" detail="Sign in to see live +EV picks." />
          : ev.status !== 'ready' ? <Notice title={ev.status === 'error' ? '+EV unavailable' : 'Loading +EV picks'}
            detail={ev.status === 'error' ? 'Sportsbook prices are not connected yet. Try again later.' : 'Comparing sportsbook prices.'} />
            : !ev.value?.picks.length ? <Notice title="No +EV picks right now"
              detail="No standard line beats the break-even at the sportsbooks' prices. Check back after the next update." />
              : ev.value.picks.slice(0, 50).map((pick) => <EvCard key={pick.lineId} pick={pick} onAdd={() => {
                const line = lineById.get(pick.lineId);
                if (!line) { setNotice('That line is no longer on the board.'); return; }
                tips.attempt(line, analysisById.get(pick.lineId), pick.side, `Added ${pick.playerName} to your Crown.`);
              }} />)}
        {!!notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
      </> : <>
      <Segmented label="How many top picks" options={sizes} value={size} onChange={setSize} />
      <ChipRow>
        <FilterChip label={filter.sport === 'ALL' ? 'All Sports' : optionLabel('sport', filter.sport)}
          active={filter.sport !== 'ALL'} onPress={() => setSheet('sport')} />
        <FilterChip icon="calendar-blank-outline" label={filter.date === 'ALL' ? 'Date' : optionLabel('date', filter.date)}
          active={filter.date !== 'ALL'} onPress={() => setSheet('date')} />
        <FilterChip icon="chart-line" label={filter.lineType === 'ALL' ? 'Line Style' : optionLabel('lineType', filter.lineType)}
          active={filter.lineType !== 'ALL'} onPress={() => setSheet('lineType')} />
      </ChipRow>
      {freshness !== 'DEMO' && board && <Text style={styles.note}>Saved snapshot. Lines can move near game time; confirm the exact line and direction in
        PrizePicks within an hour of the start.</Text>}
      {!!notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
      {!data ? <Notice title={status === 'loading' ? 'Loading top picks' : 'Top picks pending'}
        detail={message || 'Checking the saved full-board analysis.'} />
        : rankings.length === 0 ? <Notice title="No top picks right now"
          detail="Nothing on the board scores 80 or higher for these filters. PASS is a valid result." />
          : rankings.slice(0, size).map((card, index) => <PickCard key={card.lineId} card={card} rank={card.rank} scout={scoutReads?.get(card.lineId)}
            accent={rankAccents[index % rankAccents.length]} analysis={analysisById.get(card.lineId)}
            photoUrl={board?.playerMedia?.[card.playerId]?.photoUrl} onAdd={() => addCard(card)} />)}
      {data && rankings.length > size && <Text style={styles.more}>{rankings.length - size} more qualified
        {rankings.length - size === 1 ? ' pick' : ' picks'} below the cut. Raise the Top count to see them.</Text>}
      {watchlist.length > 0 && <View style={styles.section}>
        <Text style={styles.sectionTitle}>2nd Look watchlist</Text>
        <Text style={styles.sectionText}>Re-researched lines scoring 68–79. They are not top picks; review the evidence first.</Text>
        {watchlist.map((card) => <PickCard key={card.lineId} card={card} rank={null} accent={colors.textMuted}
          analysis={analysisById.get(card.lineId)} photoUrl={board?.playerMedia?.[card.playerId]?.photoUrl}
          onAdd={() => addCard(card)} />)}
      </View>}
      {!data && <Pressable accessibilityRole="button" onPress={retry}><Text style={styles.link}>Retry</Text></Pressable>}
      </>}
    </ScrollView>
    {tips.sheet}
    {sheet && <Sheet visible title={{ sport: 'Sport', date: 'Date', lineType: 'Line style' }[sheet]} onClose={() => setSheet(null)}>
      <View style={styles.options}>
        {['ALL', ...options[sheet]].map((option) => <Pressable key={option} accessibilityRole="button"
          accessibilityState={{ selected: filter[sheet] === option }} style={[styles.option, filter[sheet] === option && styles.optionActive]}
          onPress={() => { setFilter((current) => ({ ...current, [sheet]: option })); setSheet(null); }}>
          <Text style={styles.optionText}>{optionLabel(sheet, option)}</Text></Pressable>)}
      </View>
    </Sheet>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 14 },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  notice: { color: colors.mint, fontSize: 13, fontWeight: '700' },
  evCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 14, gap: 8 },
  evTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  evBody: { flex: 1, gap: 2 },
  evName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  evPick: { color: colors.mint, fontSize: 15, fontWeight: '700' },
  evNumbers: { alignItems: 'flex-end' },
  evEdge: { color: colors.mint, fontSize: 22, fontWeight: '900' },
  evAgree: { color: colors.gold, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderWidth: 1.5, borderRadius: radius.lg, padding: 14, gap: 12,
    shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  rank: { fontSize: 22, fontWeight: '900', marginTop: 4, minWidth: 34 },
  identity: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: colors.text, fontSize: 20, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: 13.5 },
  strong: { color: colors.text, fontWeight: '700' },
  middle: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  lineBox: { flex: 1, minWidth: 0, backgroundColor: alpha(colors.mint, 0.06), borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8 },
  market: { color: colors.text, fontSize: 15, fontWeight: '700' },
  pick: { color: colors.mint, fontSize: 22, fontWeight: '900' },
  tap: { gap: 12 },
  insight: { width: 88, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, padding: 8, gap: 2,
    backgroundColor: colors.surfaceSunken },
  insightTitle: { color: colors.text, fontSize: 12, fontWeight: '800', letterSpacing: 0.4 },
  insightText: { color: colors.textMuted, fontSize: 11.5, lineHeight: 15 },
  strip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingVertical: 6,
    backgroundColor: colors.surfaceSunken },
  more: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  section: { gap: 10, marginTop: 8 },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  sectionText: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  link: { color: colors.mint, fontWeight: '800', textAlign: 'center' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { paddingHorizontal: 12, minHeight: 42, justifyContent: 'center', borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md },
  optionActive: { borderColor: colors.mint, backgroundColor: colors.mintWash },
  optionText: { color: colors.text, fontWeight: '600' },
});
