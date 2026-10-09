import { edgeBoardPageSchema } from '@crowniq/contracts';
import type { EdgeBoardPage, EdgeBoardRow } from '@crowniq/contracts';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../auth';
import { formatLine, marketLabel, moveBadges, pct, ratingColor, ratingLabel, tierLabel } from '../edge-format';
import { edgeSlip, useEdgeSlip } from '../edge-slip';
import { platformShort, useEdgePlatform } from '../edge-platform';
import { palette } from '../theme';
import { Notice } from './Screen';
import { edgeQuery, EdgeFilters } from './EdgeFilters';
import type { FilterValue } from './FilterBar';

type Filter = 'all' | 'picks' | 'no_read';
type Sort = 'rank' | 'start' | 'edge' | 'probability';
const filters: { key: Filter; label: string }[] = [{ key: 'all', label: 'Every line' }, { key: 'picks', label: 'Edge reads' },
  { key: 'no_read', label: 'No read' }];
const sorts: { key: Sort; label: string }[] = [{ key: 'rank', label: 'Best' }, { key: 'start', label: 'Start time' }, { key: 'edge', label: 'Biggest edge' },
  { key: 'probability', label: 'Hit %' }];
const PAGE = 60;

/** Every line on the board with Edge's read, including lines GKR skips and lines Edge cannot read. */
export function EdgeBoardView({ filter, onFilter }: { filter: FilterValue; onFilter: (next: FilterValue) => void }) {
  const { request } = useAuth();
  const platform = useEdgePlatform();
  const slip = useEdgeSlip();
  const [show, setShow] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('rank');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [state, setState] = useState<{ key: string; rows: EdgeBoardRow[]; total: number; sports: string[]; markets: { market: string; lines: number }[];
    games: EdgeBoardPage['games']; message: string } | null>(null);
  const { sport, market, event } = edgeQuery(filter);
  const key = JSON.stringify([platform, sport, market, event, show, sort, search.trim(), limit]);
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ platform, filter: show, sort, limit: String(Math.min(limit, 200)) });
    if (sport) params.set('sport', sport);
    if (market) params.set('market', market);
    if (event) params.set('event', event);
    if (search.trim()) params.set('q', search.trim());
    const timer = setTimeout(() => {
      void request('/v1/edge/board?' + params.toString()).then(async (response) => {
        if (!active) return;
        if (!response.ok) { setState({ key, rows: [], total: 0, sports: [], markets: [], games: [], message: response.status === 503 ? 'Edge is waiting for a saved board.' : 'Could not load the Edge board.' }); return; }
        const page = edgeBoardPageSchema.parse(await response.json());
        setState({ key, rows: page.rows, total: page.total, sports: page.sports, markets: page.markets ?? [], games: page.games ?? [], message: '' });
      }).catch(() => { if (active) setState({ key, rows: [], total: 0, sports: [], markets: [], games: [], message: 'Could not load the Edge board.' }); });
    }, search ? 250 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [show, key, limit, request, search, sort, sport, market, event, platform]);
  const inSlip = new Set(slip.map((leg) => leg.lineId));
  const current = state; // keep the previous page visible while a new query loads
  return <View style={styles.wrap}>
    <TextInput accessibilityLabel="Search players" value={search} onChangeText={(value) => { setSearch(value); setLimit(PAGE); }}
      placeholder="Search a player" placeholderTextColor={palette.muted} style={styles.search} autoCorrect={false} />
    <EdgeFilters value={filter} onChange={(next) => { onFilter(next); setLimit(PAGE); }} counts={current} />
    <Chips options={filters} value={show} onChange={(value) => { setShow(value); setLimit(PAGE); }} />
    <Chips options={sorts} value={sort} onChange={(value) => { setSort(value); setLimit(PAGE); }} />
    {!current ? <Notice title="Loading the Edge board" detail="Reading every line on the saved board." />
      : current.message ? <Notice title="Unavailable" detail={current.message} />
      : <>
        <Text style={styles.meta}>{current.total} lines · Edge reads every line it has data for. Lines with no data are listed as No read.</Text>
        {current.rows.map((row) => row.kind === 'PICK'
          ? <PickRow key={row.pick.key + row.pick.side} row={row} inSlip={inSlip.has(row.pick.lineId)} />
          : <View key={row.line.lineId} style={[styles.row, styles.noRead]}>
            <View style={styles.rowMain}>
              <Text style={styles.name}>{row.line.playerName}</Text>
              <Text style={styles.line}>{platformShort(row.line.platform)} {formatLine(row.line.threshold)} {marketLabel(row.line.market)}{row.line.lineType !== 'REGULAR' ? ` · ${row.line.lineType === 'UNKNOWN_ALTERNATE' ? 'ALT' : row.line.lineType}` : ''}</Text>
              <Text style={styles.muted}>{row.line.sport} · {row.line.eventName}</Text>
              <Text style={styles.muted}>{row.line.note}</Text>
            </View>
            <Text style={styles.noReadTag}>NO READ</Text>
          </View>)}
        {current.rows.length < current.total && limit < 200 &&
          <Pressable accessibilityRole="button" onPress={() => setLimit((value) => value + PAGE)} style={styles.more}>
            <Text style={styles.link}>Show more ({current.total - current.rows.length} left)</Text></Pressable>}
        {current.rows.length < current.total && limit >= 200 &&
          <Text style={styles.muted}>Showing the first 200. Narrow by sport or search to see the rest.</Text>}
      </>}
  </View>;
}

function PickRow({ row, inSlip }: { row: Extract<EdgeBoardRow, { kind: 'PICK' }>; inSlip: boolean }) {
  const pick = row.pick, color = ratingColor(pick.rating, palette);
  return <View style={styles.row}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Edge detail for ${pick.playerName}`} style={styles.rowMain}
      onPress={() => router.push({ pathname: '/edge/[lineId]', params: { lineId: pick.lineId, platform: pick.platform } })}>
      <Text style={styles.name}>{pick.playerName}</Text>
      <Text style={styles.line}>{marketLabel(pick.market)} · {platformShort(pick.platform)} {formatLine(pick.threshold)} · Edge {formatLine(pick.fairLine)}</Text>
      <Text style={styles.muted}>{moveBadges(pick).length ? `${moveBadges(pick).join(' · ')} · ` : ''}{pick.sport} · {tierLabel[pick.tier]}{pick.lineType !== 'REGULAR' ? ` · ${pick.lineType === 'UNKNOWN_ALTERNATE' ? 'ALT' : pick.lineType}` : ''}</Text>
      {pick.reasons[0] && <Text style={styles.muted} numberOfLines={2}>{pick.reasons[0]}</Text>}
    </Pressable>
    <View style={styles.side}>
      <Text style={[styles.call, { color: pick.edge !== null && pick.rating !== 'NONE' ? color : palette.text }]}>{pick.side}</Text>
      <Text style={styles.hit}>{pct(pick.probability, 0)}</Text>
      <Text style={[styles.rating, { color: pick.edge === null ? palette.muted : color }]}>{pick.ev !== undefined ? `EV ${pick.ev >= 0 ? '+' : '−'}${Math.abs(pick.ev * 100).toFixed(1)}%` : pick.edge === null ? `≥${pick.requiredPayoutFactor.toFixed(2)}×` : ratingLabel[pick.rating]}</Text>
      <Pressable accessibilityRole="button" onPress={() => edgeSlip.toggle(pick)} style={[styles.add, inSlip && styles.addOn]}>
        <Text style={[styles.addText, inSlip && { color: palette.green }]}>{inSlip ? '✓' : '+'}</Text></Pressable>
    </View>
  </View>;
}

function Chips<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return <View style={styles.chips}>{options.map((option) => <Pressable key={String(option.key)} accessibilityRole="button"
    onPress={() => onChange(option.key)} style={[styles.chip, value === option.key && styles.chipOn]}>
    <Text style={[styles.chipText, value === option.key && styles.chipTextOn]}>{option.label}</Text></Pressable>)}</View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  search: { backgroundColor: palette.card, borderColor: palette.border, borderWidth: 1, borderRadius: 14, color: palette.text,
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 },
  chipOn: { backgroundColor: palette.greenDim, borderColor: palette.green },
  chipText: { color: palette.muted, fontSize: 11, fontWeight: '800' },
  chipTextOn: { color: palette.green },
  meta: { color: palette.muted, fontSize: 11 },
  row: { flexDirection: 'row', gap: 10, backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, borderRadius: 14, padding: 12 },
  noRead: { opacity: .7 },
  rowMain: { flex: 1, gap: 2 },
  name: { color: palette.text, fontSize: 15, fontWeight: '800' },
  line: { color: palette.text, fontSize: 12, fontWeight: '700' },
  muted: { color: palette.muted, fontSize: 11, lineHeight: 15 },
  side: { alignItems: 'flex-end', gap: 2, minWidth: 70 },
  call: { fontSize: 13, fontWeight: '900' },
  hit: { color: palette.text, fontSize: 20, fontWeight: '900' },
  rating: { fontSize: 9, fontWeight: '900', letterSpacing: .6 },
  add: { borderWidth: 1, borderColor: palette.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 2, marginTop: 2 },
  addOn: { borderColor: palette.green, backgroundColor: palette.greenDim },
  addText: { color: palette.muted, fontSize: 14, fontWeight: '900' },
  noReadTag: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  more: { alignSelf: 'center', padding: 10 },
  link: { color: palette.green, fontSize: 13, fontWeight: '800' },
});
