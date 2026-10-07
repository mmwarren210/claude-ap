import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth';
import { formatLine, gameTime, marketLabel } from '../insights';
import { colors, radius } from '../theme';
import { BoardPicker, sourceNames } from './BoardPicker';
import type { BoardSource, Sportsbook } from './BoardPicker';
import { Notice } from './Screen';
import { ScoutVerdict } from './ScoutVerdict';
import type { AiRead } from '../scout';
import { AppHeader } from './ui/AppHeader';
import { ChipRow, FilterChip, GhostButton, PrimaryButton } from './ui/Controls';
import { copyAndOpenUrl, openExternal } from '../port';
import { openCrownOn, toggleCrownLeg, useCrownLegs } from '../crown-legs';
import type { CrownProvider } from '../crown-legs';
import { PlayerAvatar } from './ui/PlayerAvatar';
import { ScoreRing } from './ui/ScoreRing';

type Side = 'MORE' | 'LESS';
/** One DraftKings or Hard Rock pick, as /v1/books/:book/picks serves it: GKR's side at the book's number. */
export type BookPick = { id: string; league: string; eventName?: string; playerName: string; team: string | null; opponent: string | null;
  eventStartTime: string; market: string; line: number; side: Side; by?: 'GKR' | 'HISTORY' | 'VALUE'; score?: number;
  note?: string | null; gkr: { score: number } | null; american: number | null;
  impliedChance: number | null; pricey: boolean; fairChance: number | null;
  otherBook: { book: Sportsbook; american: number | null } | null;
  altLine: { book: Sportsbook; line: number; american: number | null } | null;
  fairerLine?: { book: Sportsbook; line: number; american: number | null } | null;
  scout?: AiRead | null;
  prizePicks: { line: number; lineType: string; sides: Side[];
    gkr: { direction: string; score: number | null; reasonCode: string | null } | null } | null };
export const bookUrls: Readonly<Record<Sportsbook, string>> = { draftkings: 'https://sportsbook.draftkings.com/',
  hardrock: 'https://app.hardrock.bet/' };
export const odds = (american: number | null) => american === null ? '—' : american > 0 ? `+${american}` : `−${-american}`;
const pct = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`;
const impliedOf = (american: number | null) => american === null ? null
  : american < 0 ? -american / (-american + 100) : 100 / (american + 100);

/** Loads one picks route when the screen is focused; demo mode shows a sign-in notice instead. */
export function usePicks<T>(path: string): { picks: T[]; fetchedAt: string | null; state: 'loading' | 'ready' | 'error' | 'demo'; feedNote?: string } {
  const { request, demo } = useAuth();
  const [value, setValue] = useState<{ picks: T[]; fetchedAt: string | null; state: 'loading' | 'ready' | 'error' | 'demo'; feedNote?: string }>(
    { picks: [], fetchedAt: null, state: 'loading' });
  useFocusEffect(useCallback(() => {
    if (demo) { setValue({ picks: [], fetchedAt: null, state: 'demo' }); return; }
    let active = true;
    setValue((current) => ({ ...current, state: 'loading' }));
    void request(path).then(async (response) => {
      const body = response.ok ? await response.json() as { picks?: T[]; fetchedAt?: string | null; feedNote?: string } : null;
      if (active) setValue(body ? { picks: body.picks ?? [], fetchedAt: body.fetchedAt ?? null, state: 'ready', ...(body.feedNote ? { feedNote: body.feedNote } : {}) }
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

export function BookCard({ book, pick, action }: { book: Sportsbook; pick: BookPick; action?: React.ReactNode }) {
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
      <View style={styles.tags}>
        {pick.pricey && (pick.fairerLine ? <Text style={styles.altTag}>{pick.side === 'MORE' ? 'CHECK HIGHER LINE' : 'CHECK LOWER LINE'}</Text>
          : <Text style={styles.pricey}>PRICEY</Text>)}
        {pick.altLine && <Text style={styles.altTag}>{pick.side === 'MORE' ? 'CHECK LOWER LINE' : 'CHECK HIGHER LINE'}</Text>}
      </View>
    </View>
    <View style={styles.middle}>
      <View style={styles.grow}>
        <Text style={styles.stat} numberOfLines={1}>{marketLabel(pick.market)}</Text>
        <Text style={styles.pick} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {pick.side === 'MORE' ? 'OVER' : 'UNDER'} {formatLine(pick.line)}
          <Text style={styles.price}>  {odds(pick.american)}</Text></Text>
      </View>
      {pick.gkr ? <ScoreRing score={pick.gkr.score} size={60} band={pick.gkr.score >= 92 ? 'CROWN_ELITE' : pick.gkr.score >= 86
        ? 'CROWN_STRONG' : pick.gkr.score >= 80 ? 'PLAYABLE' : 'LEAN'} />
        : <ScoreRing score={pick.score ?? null} band={undefined} size={60} label="PLAY" tint={pick.by === 'VALUE' ? colors.gold : colors.royal}
          who={pick.by === 'VALUE' ? 'Value' : 'History'} />}
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
    {!pick.gkr && !!pick.note && <Text style={[styles.note, { color: pick.by === 'VALUE' ? colors.gold : colors.royal }]}>
      {pick.by === 'VALUE' ? 'Value' : 'History'} pick, not a GKR score · {pick.note}</Text>}
    <Text style={styles.note}>{prizePicksNote(pick)}{better ? ' · Best price' : ''}</Text>
    {pick.altLine && <Text style={styles.altNote}>{sourceNames[pick.altLine.book]} has {pick.side === 'MORE' ? 'Over' : 'Under'}
      {' '}{formatLine(pick.altLine.line)} at {odds(pick.altLine.american)}, an easier number at a fair price.
      {book === 'draftkings' ? ' DraftKings usually offers alternate lines too: check its app for a ' +
        `${pick.side === 'MORE' ? 'lower' : 'higher'} number.` : ''}</Text>}
    <ScoutVerdict read={pick.scout ?? undefined} gkrDirection={pick.side} />
    {pick.pricey && pick.fairerLine && <Text style={styles.altNote}>{sourceNames[pick.fairerLine.book]} has
      {' '}{pick.side === 'MORE' ? 'Over' : 'Under'} {formatLine(pick.fairerLine.line)} at {odds(pick.fairerLine.american)}: a
      {' '}{pick.side === 'MORE' ? 'higher' : 'lower'} number at a fairer price.</Text>}
    {pick.pricey && <Text style={styles.pricyNote}>This price needs {pct(pick.impliedChance)} to break even.{pick.gkr ? ' GKR’s score is a strength rating, not a win chance, so weigh the price before betting.' : ''}</Text>}
    {action}
  </View>;
}

/** The built slip: its picks in plain words, a summary line, and Copy & open. */
export function SlipTray({ lines, summary, url, appName, onClear }: { lines: string[]; summary: string; url: string; appName: string;
  onClear: () => void }) {
  const [message, setMessage] = useState('');
  if (!lines.length) return null;
  const text = [`My ${appName} picks (from CrownIQ):`, ...lines.map((line, index) => `${index + 1}. ${line}`),
    'Check each line in the app before you play. Play responsibly.'].join('\n');
  return <View style={styles.tray}>
    <Text style={styles.trayTitle}>Your {appName} slip</Text>
    {lines.map((line, index) => <Text key={index} style={styles.trayLine}>{index + 1}. {line}</Text>)}
    {!!summary && <Text style={styles.traySummary}>{summary}</Text>}
    <PrimaryButton label={`Copy picks & open ${appName}`} icon="open-in-new" onPress={() => void copyAndOpenUrl(url, text)
      .then((how) => setMessage(how === 'copied' ? `Picks copied. Find each one in ${appName}.` : 'Tap Copy in the share sheet.'))
      .catch(() => undefined)} />
    <GhostButton label="Clear slip" icon="close" onPress={onClear} />
    {!!message && <Text style={styles.explain}>{message}</Text>}
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

/** "Add to Crown" on a board card, and the count of what's in that provider's Crown with a way there. */
function AddToCrown({ provider, added, onPress }: { provider: CrownProvider; added: boolean; onPress: () => void }) {
  return <GhostButton label={added ? 'In your Crown ✓' : 'Add to Crown'} icon={added ? 'check' : 'plus'} onPress={onPress}
    tone={added ? colors.mint : undefined} />;
}
function CrownCount({ provider, name, count, message }: { provider: CrownProvider; name: string; count: number; message: string }) {
  if (!count && !message) return null;
  return <View style={styles.tray}>
    {!!count && <Text style={styles.trayTitle}>{count} {count === 1 ? 'pick' : 'picks'} in your {name} Crown</Text>}
    {!!message && <Text style={styles.explain}>{message}</Text>}
    {!!count && <PrimaryButton label="Open Crown" icon="crown" onPress={() => { openCrownOn(provider); router.push('/(tabs)/crown'); }} />}
  </View>;
}

/** DraftKings or Hard Rock: every prop with a backed side (GKR, History or Value) at the book's own number. */
export function BookBoard({ book, onSource }: { book: Sportsbook; onSource: (source: BoardSource) => void }) {
  const { picks, fetchedAt, state, feedNote } = usePicks<BookPick>(`/v1/books/${book}/picks`);
  const { shown, chips } = useLeagueFilter(picks);
  const [legs] = useCrownLegs<BookPick>(book);
  const [message, setMessage] = useState('');
  const cap = book === 'draftkings' ? 8 : 20;
  const header = <View style={styles.header}>
    <AppHeader subtitle={`${sourceNames[book]} picks`} />
    <BoardPicker value={book} onChange={onSource} />
    {chips}
    {state === 'ready' && <Text style={styles.status}>{shown.length} {shown.length === 1 ? 'pick' : 'picks'}{ago(fetchedAt)}
      </Text>}
    <Text style={styles.explain}>Every {sourceNames[book]} prop at {sourceNames[book]}’s own number, with the same research as
      PrizePicks: GKR’s pick first; where GKR has none, the History Read (the player’s recent games against this number,
      blended with the book’s fair price); then Value, where this price beats the other book’s fair price. Add picks to your
      {' '}{sourceNames[book]} Crown, or build one in the Crown tab.</Text>
    <CrownCount provider={book} name={sourceNames[book]} count={legs.length} message={message} />
  </View>;
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={shown} keyExtractor={(pick) => pick.id} contentContainerStyle={styles.content} ListHeaderComponent={header}
      renderItem={({ item }) => <BookCard book={book} pick={item} action={<AddToCrown provider={book}
        added={legs.some((leg) => leg.id === item.id)} onPress={() => {
          const result = toggleCrownLeg<BookPick>(book, item, (leg) => leg.id, cap);
          setMessage(result === 'full' ? `A ${sourceNames[book]} Crown holds up to ${cap} picks.` : '');
        }} />} />}
      ListFooterComponent={shown.length ? <GhostButton label={`Open ${sourceNames[book]}`} icon="open-in-new"
        onPress={() => openExternal(bookUrls[book])} /> : null}
      ListEmptyComponent={<Notice title={state === 'demo' ? 'Sign in to see sportsbook picks' : state === 'loading'
        ? 'Loading picks' : state === 'error' ? 'Picks unavailable' : feedNote ? `${sourceNames[book]} feed down` : `No ${sourceNames[book]} picks right now`}
        detail={state === 'demo' ? 'The demo shows PrizePicks only.' : feedNote ? feedNote : state === 'error'
          ? 'Could not reach CrownIQ. Try again in a moment.'
          : 'Picks show once the book’s prices load (every hour) and GKR, History or Value backs a side.'} />} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 120, gap: 12 },
  header: { gap: 12, marginBottom: 2 },
  status: { color: colors.textMuted, fontSize: 13 },
  record: { color: colors.mint, fontSize: 13, fontWeight: '700' },
  builder: { gap: 8, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, padding: 12 },
  builderTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  tray: { gap: 8, borderWidth: 1.5, borderColor: colors.mint, borderRadius: radius.lg, padding: 14, backgroundColor: colors.surface },
  trayTitle: { color: colors.mint, fontSize: 15, fontWeight: '800' },
  trayLine: { color: colors.text, fontSize: 14 },
  traySummary: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
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
  tags: { alignItems: 'flex-end', gap: 4 },
  altTag: { color: colors.mint, borderColor: colors.mint, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 7,
    paddingVertical: 3, fontSize: 10.5, fontWeight: '800', letterSpacing: 0.6 },
  altNote: { color: colors.mint, fontSize: 12, lineHeight: 17 },
  pricyNote: { color: colors.gold, fontSize: 12, lineHeight: 17 },
  leagueBadge: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: colors.mint, alignItems: 'center',
    justifyContent: 'center' },
  leagueText: { color: colors.mint, fontSize: 12, fontWeight: '800' },
  edge: { minWidth: 62, alignItems: 'center', borderWidth: 2, borderColor: colors.mint, borderRadius: radius.md, paddingVertical: 6 },
  edgeValue: { color: colors.mint, fontSize: 21, fontWeight: '900' },
});
