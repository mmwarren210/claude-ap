import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { byLabels, linkPanels, rankAll, sourceLabels } from '../all-picks';
import type { AnyPick, PickSource } from '../all-picks';
import { backing, sideLabel } from '../app-lines';
import type { AppLine } from '../app-lines';
import { formatLine, gameTime, marketLabel } from '../insights';
import { colors, radius } from '../theme';
import { useAiPicks } from '../use-ai-picks';
import { useBoard } from '../use-board';
import { useHistoryReads } from '../use-history-reads';
import { useRankings } from '../use-rankings';
import { Notice } from './Screen';
import { picked } from './ui/MultiPick';
import { emptyFilter, FilterBar } from './FilterBar';
import type { FilterValue } from './FilterBar';
import { PlayerAvatar } from './ui/PlayerAvatar';

type BookPick = { id: string; sport?: string; playerName: string; market: string; line: number; side: 'MORE' | 'LESS'; eventStartTime: string;
  by?: 'GKR' | 'HISTORY' | 'VALUE'; score?: number; gkr: { score: number } | null; note?: string | null; american: number | null };
const word = (side: 'MORE' | 'LESS') => side === 'MORE' ? 'More' : 'Less';
const odds = (american: number | null) => american === null ? '' : ` (${american > 0 ? '+' : ''}${american})`;

/** The best picks on every board, ranked together; chips narrow it to one board. */
export function AllPicks({ only }: { only?: PickSource } = {}) {
  const { request, demo } = useAuth();
  const { data: board, nowMs } = useBoard();
  const { data: ranked } = useRankings();
  const { reads: scout } = useAiPicks();
  const history = useHistoryReads();
  // Each board's picks, filled in as they arrive (one slow board never holds up the rest); a single-board tab loads only it.
  const [loaded, setLoaded] = useState<Partial<Record<PickSource, AnyPick[]>>>({});
  // Platforms (several at once) and sports narrow the list.
  const [filter, setFilter] = useState<FilterValue>(emptyFilter);
  const sources = only ? [only] : filter.platforms, sports = filter.sports;
  useFocusEffect(useCallback(() => {
    if (demo) return;
    let active = true;
    const json = async <T,>(path: string): Promise<T | null> => {
      const response = await request(path).catch(() => null);
      return response?.ok ? await response.json() as T : null;
    };
    const loaders: Partial<Record<PickSource, () => Promise<AnyPick[]>>> = {
      ...Object.fromEntries((['underdog', 'pick6', 'dabble'] as const).map((app) => [app, async () =>
        ((await json<{ lines: AppLine[] }>(`/v1/apps/${app}/board`))?.lines ?? []).flatMap((line): AnyPick[] => {
          const back = backing(line);
          return back ? [{ key: `${line.playerId}|${line.market ?? line.stat}`, source: app, sport: line.sport, by: back.by, title: line.playerName,
            detail: `${line.stat} · ${sideLabel(app, back.side)} ${formatLine(line.threshold)}`, strength: back.score, edge: null,
            startTime: line.eventStartTime, lineId: null, note: back.by === 'HISTORY' ? line.history?.text ?? null : null,
            photoUrl: line.playerImageUrl, playerId: line.playerId }] : [];
        })])),
      ...Object.fromEntries((['draftkings', 'hardrock', 'pinnacle', 'kalshi'] as const).map((book) => [book, async () =>
        ((await json<{ picks: BookPick[] }>(`/v1/books/${book}/picks`))?.picks ?? []).map((pick): AnyPick => ({
          key: `${pick.playerName}|${pick.market}`, source: book, sport: pick.sport, by: pick.by ?? 'GKR', title: pick.playerName,
          detail: `${marketLabel(pick.market)} · ${pick.side === 'MORE' ? 'Over' : 'Under'} ${formatLine(pick.line)}${odds(pick.american)}`,
          strength: pick.gkr?.score ?? pick.score ?? 0, edge: null, startTime: pick.eventStartTime, lineId: null, note: pick.note ?? null }))])),
    };
    for (const [name, load] of Object.entries(loaders) as [PickSource, () => Promise<AnyPick[]>][]) {
      if (only && name !== only) continue;
      void load().catch(() => []).then((picks) => { if (active) setLoaded((current) => ({ ...current, [name]: picks })); });
    }
    return () => { active = false; };
  }, [request, demo, only]));
  const others = useMemo(() => Object.values(loaded).flat(), [loaded]);
  const waiting = only ? only !== 'prizepicks' && !loaded[only] : Object.keys(loaded).length === 0;
  const prizePicks = useMemo(() => {
    const lines = new Map(board?.board.lines.map((line) => [line.id, line]));
    const out: AnyPick[] = [];
    for (const card of ranked?.rankings ?? []) out.push({ key: `${card.playerId}|${card.market}`, source: 'prizepicks', by: 'GKR',
      title: card.playerName, detail: `${marketLabel(card.market)} · ${word(card.direction as 'MORE' | 'LESS')} ${formatLine(card.threshold)}`,
      strength: card.score, edge: null, startTime: card.eventStartTime, lineId: card.lineId, note: null });
    for (const [lineId, read] of scout ?? []) {
      const line = lines.get(lineId);
      if (line && read.kind !== 'second' && read.pick !== 'PASS' && (read.score ?? 0) >= 55) out.push({ key: `${line.playerId}|${line.market}`,
        source: 'prizepicks', by: 'SCOUT', title: line.playerName, detail: `${marketLabel(line.market)} · ${word(read.pick)} ${formatLine(line.threshold)}`,
        strength: read.score ?? 0, edge: null, startTime: line.eventStartTime, lineId, note: null });
    }
    for (const [lineId, read] of history ?? []) {
      const line = lines.get(lineId);
      if (line && read.direction !== 'PASS' && !read.lean && !read.trend && read.score !== null) out.push({ key: `${line.playerId}|${line.market}`,
        source: 'prizepicks', by: 'HISTORY', title: line.playerName,
        detail: `${marketLabel(line.market)} · ${word(read.direction)} ${formatLine(line.threshold)}`, strength: read.score, edge: null,
        startTime: line.eventStartTime, lineId, note: read.text });
    }
    return out;
  }, [board, ranked, scout, history]);
  // Every app's and book's pick opens the player's panel and shows the photo (Underdog and Pick6 share PrizePicks'
  // player ids; books match by name).
  const linked = useMemo(() => linkPanels(others, board?.board.lines ?? [], nowMs), [others, board, nowMs]);
  const photoFor = (pick: AnyPick) => pick.photoUrl ?? (() => {
    const id = pick.playerId ?? (pick.lineId ? board?.board.lines.find((line) => line.id === pick.lineId)?.playerId : null);
    return id ? board?.playerMedia?.[id]?.photoUrl ?? null : null;
  })();
  const all = useMemo(() => rankAll([...prizePicks, ...linked], nowMs), [prizePicks, linked, nowMs]);
  const lineSport = useMemo(() => new Map(board?.board.lines.map((line) => [line.id, line.sport])), [board]);
  const sportOf = (pick: AnyPick) => pick.sport ?? (pick.lineId ? lineSport.get(pick.lineId) : undefined);
  const inSources = all.filter((pick) => picked(sources, pick.source));
  const shown = inSources.filter((pick) => !sports.length || sports.includes(sportOf(pick) ?? '')).slice(0, 60);
  const counts = new Map<string, number>(), sportCounts = new Map<string, number>();
  for (const pick of all) counts.set(pick.source, (counts.get(pick.source) ?? 0) + 1);
  for (const pick of inSources) { const sport = sportOf(pick); if (sport) sportCounts.set(sport, (sportCounts.get(sport) ?? 0) + 1); }
  return <View style={styles.wrap}>
    {all.length > 0 && <FilterBar value={filter} onChange={setFilter} games={[]} stats={[]} placeholder={only ? 'Filter: all sports' : 'Filter: all platforms and sports'}
      platformName={(key) => sourceLabels[key as PickSource] ?? key}
      {...(only ? {} : { platforms: (Object.keys(sourceLabels) as PickSource[]).filter((item) => counts.get(item))
        .map((item) => ({ key: item, label: sourceLabels[item], count: counts.get(item) })) })}
      sports={[...sportCounts].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, label: key, count }))} />}
    {!shown.length && (waiting ? <Notice title="Loading picks" detail="One moment." />
      : <Notice title="No picks right now" detail="Check back after the next update." />)}
    {shown.map((pick, index) => <Pressable key={`${pick.source}|${pick.key}|${pick.by}`} accessibilityRole="button" disabled={!pick.lineId}
      onPress={() => pick.lineId && router.push({ pathname: '/player/[lineId]', params: { lineId: pick.lineId } })} style={styles.card}>
      <Text style={styles.rank}>#{index + 1}</Text>
      <PlayerAvatar name={pick.title} photoUrl={photoFor(pick)} size={44} ring={colors.borderStrong} />
      <View style={styles.grow}>
        <Text style={styles.title} numberOfLines={1}>{pick.title}</Text>
        <Text style={styles.detail} numberOfLines={2}>{pick.detail}</Text>
        <Text style={styles.meta} numberOfLines={1}>{sourceLabels[pick.source]} · {gameTime(pick.startTime)}</Text>
        {!!pick.note && <Text style={styles.meta} numberOfLines={2}>{pick.note}</Text>}
      </View>
      <View style={styles.badge}>
        <Text style={[styles.by, { color: pick.by === 'GKR' ? colors.mint : pick.by === 'SCOUT' ? colors.electric
          : pick.by === 'HISTORY' ? colors.royal : colors.gold }]}>{byLabels[pick.by]}</Text>
        <Text style={styles.value}>{pick.edge !== null ? `+${(pick.edge * 100).toFixed(1)}` : Math.round(pick.strength)}</Text>
      </View>
    </Pressable>)}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  explain: { color: colors.textMuted, fontSize: 12.5, lineHeight: 18 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: 12 },
  rank: { color: colors.textMuted, fontSize: 15, fontWeight: '900', width: 34 },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: colors.text, fontSize: 16, fontWeight: '800' },
  detail: { color: colors.mint, fontSize: 14, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: 12 },
  badge: { alignItems: 'center', minWidth: 56 },
  by: { fontSize: 11, fontWeight: '900' },
  value: { color: colors.text, fontSize: 20, fontWeight: '900' },
});
