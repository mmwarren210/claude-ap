import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useCrownLegs } from '../crown-legs';
import { buildBookSlip, parlayAmerican } from '../slip-builders';
import { colors } from '../theme';
import { useBoard } from '../use-board';
import { sourceNames } from './BoardPicker';
import type { Sportsbook } from './BoardPicker';
import { Notice } from './Screen';
import { BookCard, bookUrls, odds, SlipTray, usePicks } from './SourceBoards';
import type { BookPick } from './SourceBoards';
import { PrimaryButton, Segmented } from './ui/Controls';
import { GlowCard } from './ui/GlowCard';
import { Icon } from './ui/Icon';
import { SizeStepper } from './ui/SizeStepper';
import { inSports, SportPicker } from './ui/SportPicker';
import { DayPicker } from './ui/DayPicker';
import { chosenDay, gameDays, onDay } from '../game-days';
import { formatLine, marketLabel } from '../insights';

// Crown generators for the sportsbooks (DraftKings, Hard Rock), beside the
// pick'em ones (owner, 2026-10-05). Each builds from its own board, which already carries GKR, the History Read at the
// book's number and the books' fair prices; picks added on the board show here too. Sizes: DraftKings up to 8, Hard Rock
// up to 20.

function Remove({ onPress }: { onPress: () => void }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={styles.remove}>
    <Icon name="close" size={16} color={colors.textMuted} /><Text style={styles.removeText}>Remove from Crown</Text></Pressable>;
}

function Summary({ title, lines, stats }: { title: string; lines: string; stats: { value: string; label: string }[] }) {
  return <GlowCard accent={colors.mint}>
    <View style={styles.head}><Icon name="crown" size={50} color={colors.neon} />
      <View style={styles.grow}><Text style={styles.title} numberOfLines={1}>{title}</Text><Text style={styles.meta}>{lines}</Text></View></View>
    <View style={styles.metrics}>{stats.map((stat, index) => <View key={stat.label} style={[styles.metric, index > 0 && styles.divider]}>
      <Text style={styles.metricValue}>{stat.value}</Text><Text style={styles.metricLabel}>{stat.label}</Text></View>)}</View>
  </GlowCard>;
}

type BookKind = 'ANY' | 'GKR' | 'HISTORY' | 'VALUE' | 'FAIR';
const bookKinds = [{ value: 'ANY' as const, label: 'Any' }, { value: 'GKR' as const, label: 'GKR' },
  { value: 'HISTORY' as const, label: 'History' }, { value: 'VALUE' as const, label: 'Value' }, { value: 'FAIR' as const, label: 'Fair price' }];

export function BookCrown({ book }: { book: Sportsbook }) {
  const { picks, state } = usePicks<BookPick>(`/v1/books/${book}/picks`);
  const { nowMs } = useBoard();
  const [stored, setStored] = useCrownLegs<BookPick>(book);
  const max = book === 'draftkings' ? 8 : 20;
  const [size, setSize] = useState(3), [kind, setKind] = useState<BookKind>('ANY'), [built, setBuilt] = useState(0);
  const [sports, setSports] = useState<string[]>([]), [picked, setPicked] = useState<string | null>(null);
  const days = useMemo(() => gameDays(picks.map((pick) => pick.eventStartTime), nowMs), [picks, nowMs]);
  const day = chosenDay(picked, days, nowMs);
  const pool = useMemo(() => picks.filter((pick) => inSports(sports, pick.league) && onDay(day, pick.eventStartTime) &&
    (kind === 'ANY' || (kind === 'FAIR' ? !pick.pricey : (pick.by ?? 'GKR') === kind))), [picks, kind, sports, day]);
  const first = useMemo(() => buildBookSlip(pool, size, nowMs, 0), [pool, size, nowMs]);
  const legs = stored.length ? stored : first;
  const parlay = parlayAmerican(legs);
  const scores = legs.map((pick) => pick.gkr?.score ?? pick.score ?? 0);
  const name = sourceNames[book];
  return <View style={styles.wrap}>
    <SizeStepper value={size} onChange={(value) => { setSize(value); setStored([]); setBuilt(0); }} max={max} />
    <DayPicker days={days} day={day} nowMs={nowMs} onChange={(next) => { setPicked(next); setStored([]); setBuilt(0); }} />
    <SportPicker options={[...new Set(picks.map((pick) => pick.league))].sort()} selected={sports}
      onChange={(next) => { setSports(next); setStored([]); setBuilt(0); }} />
    <Segmented label="Pick type" value={kind} onChange={(value) => { setKind(value); setStored([]); setBuilt(0); }} options={bookKinds} />
    <Summary title={`${name} Crown`} lines={`${legs.length} ${legs.length === 1 ? 'pick' : 'picks'} · ${stored.length && !built ? 'Hand-picked'
      : 'Auto-built'} from ${pool.length} backed ${name} props`} stats={[
      { value: scores.length ? (scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(1) : '—', label: 'Avg Score' },
      { value: `${legs.filter((pick) => pick.gkr).length}/${legs.length}`, label: 'GKR legs' },
      { value: parlay === null ? '—' : odds(parlay), label: 'Parlay' }]} />
    <View style={styles.actions}>
      <PrimaryButton label={built ? 'Generate New' : 'Generate'} icon="shuffle-variant" style={styles.action} disabled={!pool.length}
        onPress={() => { setStored(buildBookSlip(pool, size, nowMs, (built || 1) * size)); setBuilt((built || 1) + 1); }} />
    </View>
    {state !== 'ready' && <Notice title={state === 'loading' ? 'Loading picks' : 'Picks unavailable'} detail="One moment." />}
    {legs.map((pick) => <BookCard key={pick.id} book={book} pick={pick} action={<Remove onPress={() => setStored(legs.filter((item) => item.id !== pick.id))} />} />)}
    <SlipTray appName={name} url={bookUrls[book]} onClear={() => { setStored([]); setBuilt(0); }}
      lines={legs.map((pick) => `${pick.playerName} · ${marketLabel(pick.market)} ${pick.side === 'MORE' ? 'Over' : 'Under'} ${formatLine(pick.line)} (${odds(pick.american)})`)}
      summary={legs.length >= 2 && parlay !== null ? `As a ${legs.length}-leg parlay: ${odds(parlay)}. A parlay pays only if every leg wins; ` +
        'each leg also works as a single bet.' : ''} />
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0, gap: 3 },
  title: { color: colors.text, fontSize: 23, fontWeight: '900' },
  meta: { color: colors.textMuted, fontSize: 13 },
  metrics: { flexDirection: 'row', marginTop: 14 },
  metric: { flex: 1, alignItems: 'center', gap: 2 },
  divider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.borderStrong },
  metricValue: { color: colors.text, fontSize: 20, fontWeight: '900' },
  metricLabel: { color: colors.textMuted, fontSize: 12 },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1 },
  note: { color: colors.textMuted, fontSize: 11.5, lineHeight: 16 },
  remove: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 4 },
  removeText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
});
