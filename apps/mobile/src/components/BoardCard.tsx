import { BooksBadge } from './ui/BooksBadge';
import { useBooks } from '../use-books';
import { aiPlay, SCOUT } from '../use-ai-picks';
import type { AiRead } from '../use-ai-picks';
import { ScoutVerdict } from './ScoutVerdict';
import type { BooksPick } from '../use-books';
import type { HistoryRead } from '../use-history-reads';
import { historyPlay } from '../use-history-reads';
import type { Analysis, PropLine } from '@crowniq/contracts';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatLine, gameTime, lineStats, marketLabel, percent, signed } from '../insights';
import type { Window } from '../insights';
import { colors, radius } from '../theme';
import { usePlayerGames } from '../use-player-games';
import { alpha } from './ui/color';
import { EvidenceBadge } from './ui/EvidenceBadge';
import { GlowCard } from './ui/GlowCard';
import { Icon } from './ui/Icon';
import { LineBadge } from './ui/LineBadge';
import { PlayerAvatar } from './ui/PlayerAvatar';
import { ScoreRing } from './ui/ScoreRing';
import type { Stat } from './ui/StatStrip';
import { rateTone, StatStrip } from './ui/StatStrip';

import { matchup } from '../matchup';
export { matchup };

export function evidenceDetail(analysis: Analysis | undefined): string {
  if (!analysis || analysis.evidenceQuality === 'NONE') return 'No attributed evidence';
  const support = analysis.supportingFactors.length, risks = analysis.opposingFactors.length;
  if (support >= 2 && risks === 0) return 'Multiple edges align';
  if (risks > 0) return `${risks} open ${risks === 1 ? 'risk' : 'risks'}`;
  return 'Trend + matchup';
}

/** Hit-rate strip for one window; L5 also shows L10, like the mockups. */
export function windowStats(stats: ReturnType<typeof lineStats>, l10: ReturnType<typeof lineStats>,
  window: Window): Stat[] {
  const label = window === 'AVG' ? 'L10' : window;
  return [
    { label, value: percent(stats.rate), tone: rateTone(stats.rate) },
    ...(window === 'L5' ? [{ label: 'L10', value: percent(l10.rate), tone: rateTone(l10.rate) }] : []),
    { label: 'AVG', value: stats.average === null ? '—' : stats.average.toFixed(1) },
    { label: 'STREAK', value: String(stats.streak), suffix: stats.streak >= 3 ? '🔥' : undefined },
    { label: 'DIFF', value: signed(stats.diff), tone: stats.diff === null ? 'plain' : stats.diff > 0 ? 'good' : 'bad' },
  ];
}

export const BoardCard = memo(function BoardCard({ line, analysis, ai, booksPick, historyRead, betaLine = null, more = 0, photoUrl, accent, window, expired = false,
  onPress }: { line: PropLine; analysis: Analysis | undefined; ai?: AiRead; booksPick?: BooksPick; historyRead?: HistoryRead;
  betaLine?: string | null; more?: number; photoUrl: string | null | undefined;
  accent: string; window: Window; expired?: boolean; onPress: () => void }) {
  const gkrPass = !analysis || analysis.direction === 'PASS';
  // Where GKR can't score, the Scout read is the pick, labeled as such.
  const aiPick = gkrPass && aiPlay(ai) ? ai! : null;
  // Next, the free History Read: the player's recent results against this line (labeled History, never a GKR score).
  const historyPick = gkrPass && !aiPick && (!ai || ai.kind === 'second') && historyPlay(historyRead) ? historyRead! : null;
  // Then the side DraftKings and Hard Rock back (labeled Books, never a GKR score).
  const booksSide = gkrPass && !aiPick && !historyPick && booksPick && (!ai || ai.kind === 'second') ? booksPick : null;
  const direction = aiPick ? aiPick.pick as 'MORE' | 'LESS' : historyPick ? historyPick.direction as 'MORE' | 'LESS'
    : booksSide ? booksSide.side
    : analysis?.direction === 'LESS' ? 'LESS' : 'MORE';
  const { log } = usePlayerGames(line);
  const stats = lineStats(log, line.threshold, direction, window, line.opponent);
  const l10 = lineStats(log, line.threshold, direction, 'L10');
  const pass = gkrPass && !aiPick && !historyPick && !booksSide;
  const books = useBooks();
  return <Pressable accessibilityRole="button" onPress={onPress}
    accessibilityLabel={`${line.playerName}, ${marketLabel(line.market)} ${pass ? 'PASS' : direction} ${line.threshold}`}>
    <GlowCard accent={accent}>
      <View style={styles.top}>
        <PlayerAvatar name={line.playerName} photoUrl={photoUrl} ring={accent} size={72} />
        <View style={styles.identity}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>{line.playerName}</Text>
            <Icon name="file-document-outline" size={16} color={colors.textMuted} />
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            <Text style={styles.league}>{line.league}</Text>{line.team ? `   ${line.team}` : ''}</Text>
          <Text style={styles.meta} numberOfLines={1}>{matchup(line)} · {gameTime(line.eventStartTime)}</Text>
        </View>
        <LineBadge lineType={line.lineType} compact />
      </View>

      <View style={styles.middle}>
        <View style={styles.lineBox}>
          <Text style={styles.market} numberOfLines={1}>{marketLabel(line.market)}</Text>
          <Text style={[styles.pick, pass && styles.passPick]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {pass ? 'PASS' : direction} {formatLine(line.threshold)}</Text>
        </View>
        <View style={styles.ringBox}><ScoreRing score={aiPick ? aiPick.score : historyPick ? historyPick.score
          : booksSide ? Math.round(booksSide.fair * 100) : analysis?.score ?? null}
          band={aiPick || historyPick || booksSide ? undefined : analysis?.scoreBand} size={64}
          {...aiPick || historyPick || booksSide ? { label: historyPick?.lean && !aiPick ? 'LEAN' : 'PLAY',
            tint: historyPick?.lean && !aiPick ? colors.amber : colors.mint, who: aiPick ? SCOUT : historyPick ? 'History' : 'Books' } : {}} />
          {aiPick && <Text style={styles.aiTag}>{SCOUT.toUpperCase()}</Text>}
          {historyPick && <Text style={[styles.aiTag, { color: colors.royal }]}>HISTORY</Text>}
          {booksSide && <Text style={styles.aiTag}>BOOKS</Text>}
</View>
        <View style={styles.edgeBox}>
          <Text style={[styles.edge, (stats.edge ?? 0) < 0 && styles.edgeBad]}>
            {stats.edge === null ? '—' : `${signed(stats.edge * 100)}%`}</Text>
          <View style={styles.edgeRow}><Text style={styles.edgeLabel}>vs line</Text>
            <Icon name="signal-cellular-3" size={18} color={colors.mint} /></View>
        </View>
      </View>

      <View style={styles.strip}><StatStrip stats={windowStats(stats, l10, window)} /></View>
      <View style={styles.evidence}><EvidenceBadge quality={analysis?.evidenceQuality ?? 'NONE'}
        detail={evidenceDetail(analysis)} /></View>
      <BooksBadge view={books?.get(line.id)} side={pass ? null : direction} />
      {!!betaLine && <Text style={[styles.aiNote, { color: colors.gold }]}>{betaLine}</Text>}
      {!gkrPass && <ScoutVerdict read={ai} gkrDirection={analysis?.direction} />}
      {aiPick && <ScoutVerdict read={ai} gkrDirection={undefined} />}
      {booksSide && <Text style={styles.aiNote}>GKR can’t score this stat yet. DraftKings and Hard Rock give {booksSide.side}{' '}
        {Math.round(booksSide.fair * 100)}% with their cut removed; this is the books’ number, not a GKR score.</Text>}
      {historyPick && <Text style={styles.aiNote}>History {historyPick.lean ? 'lean' : 'read'}: {historyPick.text}. From {historyPick.source}; not a GKR score.</Text>}
      {aiPick && <Text style={styles.aiNote}>GKR can’t score this stat yet. {SCOUT} researched it;
        this is {SCOUT}’s score, not a GKR score.</Text>}
      {more > 0 && <Text style={styles.more}>+{more} more {more === 1 ? 'play' : 'plays'} on {line.playerName.split(' ')[0]}’s page</Text>}
      {expired && <Text style={styles.expired}>Evidence expired, reanalysis needed</Text>}
    </GlowCard>
  </Pressable>;
});

const styles = StyleSheet.create({
  top: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  identity: { flex: 1, minWidth: 0, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: colors.text, fontSize: 21, fontWeight: '800', flexShrink: 1 },
  meta: { color: colors.textMuted, fontSize: 13.5 },
  league: { color: colors.text, fontWeight: '700' },
  middle: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'stretch' },
  lineBox: { flex: 1, minWidth: 0, backgroundColor: alpha(colors.mint, 0.06), borderWidth: 1,
    borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, justifyContent: 'center' },
  market: { color: colors.text, fontSize: 15, fontWeight: '700' },
  pick: { color: colors.mint, fontSize: 22, fontWeight: '900', letterSpacing: -0.4 },
  passPick: { color: colors.textMuted },
  ringBox: { width: 78, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, backgroundColor: colors.surfaceSunken },
  edgeBox: { width: 88, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    backgroundColor: colors.surfaceSunken, paddingHorizontal: 10, justifyContent: 'center' },
  edge: { color: colors.mint, fontSize: 19, fontWeight: '900' },
  edgeBad: { color: colors.red },
  edgeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  edgeLabel: { color: colors.textMuted, fontSize: 13 },
  expired: { color: colors.amber, fontSize: 13, fontWeight: '700', marginTop: 8 },
  aiTag: { color: colors.blue, fontSize: 10.5, fontWeight: '800', marginTop: 2 },
  aiNote: { color: colors.textMuted, fontSize: 12, marginTop: 8, lineHeight: 16 },
  more: { color: colors.mint, fontSize: 13, fontWeight: '700', marginTop: 8 },
  strip: { marginTop: 10, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingVertical: 6, backgroundColor: colors.surfaceSunken },
  evidence: { marginTop: 8, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.surfaceSunken },
});
