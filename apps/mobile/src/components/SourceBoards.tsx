import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Linking, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth';
import { formatLine, gameTime, marketLabel } from '../insights';
import { colors, radius } from '../theme';
import { BoardPicker, sourceNames } from './BoardPicker';
import type { BoardSource, MarketPlatform, Sportsbook } from './BoardPicker';
import { Notice } from './Screen';
import { AppHeader } from './ui/AppHeader';
import { ChipRow, FilterChip, GhostButton } from './ui/Controls';
import { PlayerAvatar } from './ui/PlayerAvatar';
import { ScoreRing } from './ui/ScoreRing';

type Side = 'MORE' | 'LESS';
/** One DraftKings or Hard Rock pick, as /v1/books/:book/picks serves it: GKR's side at the book's number. */
type BookPick = { id: string; league: string; playerName: string; team: string | null; opponent: string | null;
  eventStartTime: string; market: string; line: number; side: Side; gkr: { score: number }; american: number | null;
  impliedChance: number | null; pricey: boolean; fairChance: number;
  otherBook: { book: Sportsbook; american: number | null } | null;
  prizePicks: { line: number; lineType: string; sides: Side[];
    gkr: { direction: string; score: number | null; reasonCode: string | null } | null } | null };
/** One Kalshi or Polymarket pick: a game market priced below Pinnacle's no-vig chance. */
type MarketPick = { id: string; league: string; game: string; startTime: string; kind: 'WINNER' | 'SPREAD'; side: string;
  price: number; cost: number; fair: number; edge: number; url: string | null };

const bookUrls: Readonly<Record<Sportsbook, string>> = { draftkings: 'https://sportsbook.draftkings.com/',
  hardrock: 'https://app.hardrock.bet/' };
const marketUrls: Readonly<Record<MarketPlatform, string>> = { kalshi: 'https://kalshi.com/sports',
  polymarket: 'https://polymarket.com/sports' };
const odds = (american: number | null) => american === null ? '—' : american > 0 ? `+${american}` : `−${-american}`;
const pct = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`;
const cents = (value: number) => `${(value * 100).toFixed(1).replace(/\.0$/, '')}¢`;
const impliedOf = (american: number | null) => american === null ? null
  : american < 0 ? -american / (-american + 100) : 100 / (american + 100);

/** Loads one picks route when the screen is focused; demo mode shows a sign-in notice instead. */
function usePicks<T>(path: string): { picks: T[]; fetchedAt: string | null; state: 'loading' | 'ready' | 'error' | 'demo' } {
  const { request, demo } = useAuth();
  const [value, setValue] = useState<{ picks: T[]; fetchedAt: string | null; state: 'loading' | 'ready' | 'error' | 'demo' }>(
    { picks: [], fetchedAt: null, state: 'loading' });
  useFocusEffect(useCallback(() => {
    if (demo) { setValue({ picks: [], fetchedAt: null, state: 'demo' }); return; }
    let active = true;
    setValue((current) => ({ ...current, state: 'loading' }));
    void request(path).then(async (response) => {
      const body = response.ok ? await response.json() as { picks?: T[]; fetchedAt?: string | null } : null;
      if (active) setValue(body ? { picks: body.picks ?? [], fetchedAt: body.fetchedAt ?? null, state: 'ready' }
        : { picks: [], fetchedAt: null, state: 'error' });
    }).catch(() => { if (active) setValue({ picks: [], fetchedAt: null, state: 'error' }); });
    return () => { active = false; };
  }, [request, demo, path]));
  return value;
}

function ago(fetchedAt: string | null) {
  if (!fetchedAt) return '';
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(fetchedAt)) / 60_000));
  return ` · prices ${minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} ago`;
}

function prizePicksNote(pick: BookPick) {
  const reference = pick.prizePicks;
  if (!reference) return 'Not on PrizePicks';
  if (reference.gkr && reference.gkr.direction !== 'PASS' && reference.gkr.score !== null)
    return `PrizePicks ${formatLine(reference.line)} · GKR ${Math.round(reference.gkr.score)} ${reference.gkr.direction}`;
  if (!reference.sides.includes(pick.side)) return `PrizePicks ${formatLine(reference.line)} is a ` +
    `${reference.lineType === 'DEMON' ? 'Demon' : reference.lineType === 'GOBLIN' ? 'Goblin' : 'line'} (More only), so GKR ` +
    'can’t pick Less there';
  return `PrizePicks ${formatLine(reference.line)} · GKR passes there`;
}

function BookCard({ book, pick }: { book: Sportsbook; pick: BookPick }) {
  const other = pick.otherBook, better = other && impliedOf(pick.american) !== null && impliedOf(other.american) !== null &&
    impliedOf(pick.american)! < impliedOf(other.american)!;
  return <View style={styles.card}>
    <View style={styles.top}>
      <PlayerAvatar name={pick.playerName} photoUrl={null} size={48} ring={colors.mint} />
      <View style={styles.grow}>
        <Text style={styles.name} numberOfLines={1}>{pick.playerName}</Text>
        <Text style={styles.meta} numberOfLines={1}>{pick.league}{pick.team ? ` · ${pick.team}` : ''}
          {pick.opponent ? ` vs ${pick.opponent}` : ''}</Text>
        <Text style={styles.meta}>{gameTime(pick.eventStartTime)}</Text>
      </View>
      {pick.pricey && <Text style={styles.pricey}>PRICEY</Text>}
    </View>
    <View style={styles.middle}>
      <View style={styles.grow}>
        <Text style={styles.stat} numberOfLines={1}>{marketLabel(pick.market)}</Text>
        <Text style={styles.pick} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {pick.side === 'MORE' ? 'OVER' : 'UNDER'} {formatLine(pick.line)}
          <Text style={styles.price}>  {odds(pick.american)}</Text></Text>
      </View>
      <ScoreRing score={pick.gkr.score} size={60} band={pick.gkr.score >= 92 ? 'CROWN_ELITE' : pick.gkr.score >= 86
        ? 'CROWN_STRONG' : pick.gkr.score >= 80 ? 'PLAYABLE' : 'LEAN'} />
    </View>
    <View style={styles.facts}>
      <View style={styles.fact}><Text style={[styles.factValue, pick.pricey && { color: colors.gold }]}>
        {pct(pick.impliedChance)}</Text><Text style={styles.factLabel}>Price needs</Text></View>
      <View style={[styles.fact, styles.divider]}><Text style={styles.factValue}>{pct(pick.fairChance)}</Text>
        <Text style={styles.factLabel}>Book’s chance</Text></View>
      <View style={[styles.fact, styles.divider]}><Text style={[styles.factValue, better && { color: colors.mint }]}>
        {other ? odds(other.american) : '—'}</Text>
        <Text style={styles.factLabel}>{other ? sourceNames[other.book] : 'Other book'}</Text></View>
    </View>
    <Text style={styles.note}>{prizePicksNote(pick)}{better ? ' · Best price' : ''}</Text>
    {pick.pricey && <Text style={styles.pricyNote}>This price needs {pct(pick.impliedChance)} to break even. GKR’s score is a
      strength rating, not a win chance, so weigh the price before betting.</Text>}
  </View>;
}

function MarketCard({ platform, pick }: { platform: MarketPlatform; pick: MarketPick }) {
  return <View style={styles.card}>
    <View style={styles.top}>
      <View style={styles.leagueBadge}><Text style={styles.leagueText}>{pick.league}</Text></View>
      <View style={styles.grow}>
        <Text style={styles.name} numberOfLines={2}>{pick.game}</Text>
        <Text style={styles.meta}>{gameTime(pick.startTime)}</Text>
      </View>
    </View>
    <View style={styles.middle}>
      <View style={styles.grow}>
        <Text style={styles.stat}>{pick.kind === 'WINNER' ? 'Game winner' : 'Spread'}</Text>
        <Text style={styles.pick} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>{pick.side.toUpperCase()}
          <Text style={styles.price}>  {cents(pick.price)}</Text></Text>
      </View>
      <View style={styles.edge}><Text style={styles.edgeValue}>+{(pick.edge * 100).toFixed(1)}</Text>
        <Text style={styles.factLabel}>EDGE</Text></View>
    </View>
    <View style={styles.facts}>
      <View style={styles.fact}><Text style={styles.factValue}>{cents(pick.cost)}</Text>
        <Text style={styles.factLabel}>{platform === 'kalshi' ? 'Cost with fee' : 'Cost'}</Text></View>
      <View style={[styles.fact, styles.divider]}><Text style={styles.factValue}>{pct(pick.fair)}</Text>
        <Text style={styles.factLabel}>Pinnacle’s chance</Text></View>
      <View style={[styles.fact, styles.divider]}><Text style={[styles.factValue, { color: colors.mint }]}>+{cents(pick.edge)}</Text>
        <Text style={styles.factLabel}>Per $1</Text></View>
    </View>
    <Text style={styles.note}>Not a GKR score · market price against Pinnacle’s fair odds</Text>
    {!!pick.url && <GhostButton label={`Open in ${sourceNames[platform]}`} icon="open-in-new"
      onPress={() => void Linking.openURL(pick.url!)} />}
  </View>;
}

function useLeagueFilter<T extends { league: string }>(picks: T[]) {
  const [league, setLeague] = useState('ALL');
  const leagues = useMemo(() => [...new Set(picks.map((pick) => pick.league))].sort(), [picks]);
  const shown = league === 'ALL' ? picks : picks.filter((pick) => pick.league === league);
  const chips = leagues.length > 1 ? <ChipRow>
    <FilterChip label="All leagues" active={league === 'ALL'} chevron={false} onPress={() => setLeague('ALL')} />
    {leagues.map((item) => <FilterChip key={item} label={item} active={league === item} chevron={false} onPress={() => setLeague(item)} />)}
  </ChipRow> : null;
  return { shown, chips };
}

/** DraftKings or Hard Rock: GKR's side on each prop at the book's own number. No PASS lines. */
export function BookBoard({ book, onSource }: { book: Sportsbook; onSource: (source: BoardSource) => void }) {
  const { picks, fetchedAt, state } = usePicks<BookPick>(`/v1/books/${book}/picks`);
  const { shown, chips } = useLeagueFilter(picks);
  const header = <View style={styles.header}>
    <AppHeader subtitle={`${sourceNames[book]} picks`} />
    <BoardPicker value={book} onChange={onSource} />
    {chips}
    {state === 'ready' && <Text style={styles.status}>{shown.length} {shown.length === 1 ? 'pick' : 'picks'}{ago(fetchedAt)}
      {' '}· GKR picks only</Text>}
    <Text style={styles.explain}>GKR scores each {sourceNames[book]} prop at {sourceNames[book]}’s own number, using the same
      research as PrizePicks. Only lines GKR picks a side on show. “Price needs” is the win rate the odds require.</Text>
  </View>;
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={shown} keyExtractor={(pick) => pick.id} contentContainerStyle={styles.content} ListHeaderComponent={header}
      renderItem={({ item }) => <BookCard book={book} pick={item} />}
      ListFooterComponent={shown.length ? <GhostButton label={`Open ${sourceNames[book]}`} icon="open-in-new"
        onPress={() => void Linking.openURL(bookUrls[book])} /> : null}
      ListEmptyComponent={<Notice title={state === 'demo' ? 'Sign in to see sportsbook picks' : state === 'loading'
        ? 'Loading picks' : state === 'error' ? 'Picks unavailable' : `No ${sourceNames[book]} picks right now`}
        detail={state === 'demo' ? 'The demo shows PrizePicks only.' : state === 'error'
          ? 'Could not reach CrownIQ. Try again in a moment.'
          : 'Picks show once the day’s research loads (8 and 11 AM ET) and GKR backs a side at the book’s number.'} />} />
  </SafeAreaView>;
}

/** Kalshi or Polymarket: game markets priced below Pinnacle's fair odds. No PASS lines. */
export function MarketBoard({ platform, onSource }: { platform: MarketPlatform; onSource: (source: BoardSource) => void }) {
  const { picks, fetchedAt, state } = usePicks<MarketPick>(`/v1/markets/${platform}/picks`);
  const { shown, chips } = useLeagueFilter(picks);
  const header = <View style={styles.header}>
    <AppHeader subtitle={`${sourceNames[platform]} picks`} />
    <BoardPicker value={platform} onChange={onSource} />
    {chips}
    {state === 'ready' && <Text style={styles.status}>{shown.length} {shown.length === 1 ? 'pick' : 'picks'}{ago(fetchedAt)}</Text>}
    <Text style={styles.explain}>{sourceNames[platform]} sells game outcomes, not player stats, so GKR doesn’t score these. A
      pick shows when {sourceNames[platform]}’s price{platform === 'kalshi' ? ', with its fee,' : ''} is at least 2 cents per $1
      below Pinnacle’s fair odds for the same game.</Text>
  </View>;
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={shown} keyExtractor={(pick) => pick.id} contentContainerStyle={styles.content} ListHeaderComponent={header}
      renderItem={({ item }) => <MarketCard platform={platform} pick={item} />}
      ListFooterComponent={!shown.length && state === 'ready' ? <GhostButton label={`Open ${sourceNames[platform]}`}
        icon="open-in-new" onPress={() => void Linking.openURL(marketUrls[platform])} /> : null}
      ListEmptyComponent={<Notice title={state === 'demo' ? 'Sign in to see market picks' : state === 'loading'
        ? 'Loading picks' : state === 'error' ? 'Picks unavailable' : `No ${sourceNames[platform]} picks right now`}
        detail={state === 'demo' ? 'The demo shows PrizePicks only.' : state === 'error'
          ? 'Could not reach CrownIQ. Try again in a moment.'
          : `Every ${sourceNames[platform]} game that matches Pinnacle is priced at or above Pinnacle’s fair odds right now. ` +
            'These markets usually sit within 1–2 points of Pinnacle.'} />} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 120, gap: 12 },
  header: { gap: 12, marginBottom: 2 },
  status: { color: colors.textMuted, fontSize: 13 },
  explain: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  card: { borderWidth: 1.5, borderColor: colors.borderStrong, borderRadius: radius.lg, backgroundColor: colors.surface,
    padding: 14, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: colors.text, fontSize: 17, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: 12.5 },
  pricey: { color: colors.gold, borderColor: colors.gold, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 7,
    paddingVertical: 3, fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  middle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stat: { color: colors.textMuted, fontSize: 12.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  pick: { color: colors.text, fontSize: 30, fontWeight: '900' },
  price: { color: colors.gold, fontSize: 19, fontWeight: '800' },
  facts: { flexDirection: 'row', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  fact: { flex: 1, alignItems: 'center', paddingVertical: 8, gap: 2 },
  divider: { borderLeftWidth: 1, borderLeftColor: colors.border },
  factValue: { color: colors.text, fontSize: 17, fontWeight: '800' },
  factLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  note: { color: colors.textMuted, fontSize: 12.5 },
  pricyNote: { color: colors.gold, fontSize: 12, lineHeight: 17 },
  leagueBadge: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: colors.mint, alignItems: 'center',
    justifyContent: 'center' },
  leagueText: { color: colors.mint, fontSize: 12, fontWeight: '800' },
  edge: { minWidth: 62, alignItems: 'center', borderWidth: 2, borderColor: colors.mint, borderRadius: radius.md, paddingVertical: 6 },
  edgeValue: { color: colors.mint, fontSize: 21, fontWeight: '900' },
});
