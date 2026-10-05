import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Linking, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth';
import { formatLine, gameTime, marketLabel } from '../insights';
import { colors, radius } from '../theme';
import { BoardPicker, sourceNames } from './BoardPicker';
import type { BoardSource, MarketPlatform, Sportsbook } from './BoardPicker';
import { Notice } from './Screen';
import { ScoutVerdict } from './ScoutVerdict';
import type { AiRead } from '../scout';
import { AppHeader } from './ui/AppHeader';
import { ChipRow, FilterChip, GhostButton, PrimaryButton } from './ui/Controls';
import { copyAndOpenUrl } from '../port';
import { openCrownOn, toggleCrownLeg, useCrownLegs } from '../crown-legs';
import type { CrownProvider } from '../crown-legs';
import { PlayerAvatar } from './ui/PlayerAvatar';
import { ScoreRing } from './ui/ScoreRing';

type Side = 'MORE' | 'LESS';
/** One DraftKings or Hard Rock pick, as /v1/books/:book/picks serves it: GKR's side at the book's number. */
export type BookPick = { id: string; league: string; playerName: string; team: string | null; opponent: string | null;
  eventStartTime: string; market: string; line: number; side: Side; by?: 'GKR' | 'HISTORY' | 'VALUE'; score?: number;
  note?: string | null; gkr: { score: number } | null; american: number | null;
  impliedChance: number | null; pricey: boolean; fairChance: number | null;
  otherBook: { book: Sportsbook; american: number | null } | null;
  altLine: { book: Sportsbook; line: number; american: number | null } | null;
  fairerLine?: { book: Sportsbook; line: number; american: number | null } | null;
  scout?: AiRead | null;
  prizePicks: { line: number; lineType: string; sides: Side[];
    gkr: { direction: string; score: number | null; reasonCode: string | null } | null } | null };
/** One Kalshi or Polymarket pick: a game market priced below Pinnacle's no-vig chance. */
export type MarketPick = { id: string; league: string; game: string; startTime: string; kind: 'WINNER' | 'SPREAD' | 'TOTAL' | 'PROP';
  by?: 'MARKET' | 'HISTORY'; note?: string; side: string;
  price: number; cost: number; fair: number; edge: number; url: string | null; scout?: AiRead | null };

export const bookUrls: Readonly<Record<Sportsbook, string>> = { draftkings: 'https://sportsbook.draftkings.com/',
  hardrock: 'https://app.hardrock.bet/' };
export const marketUrls: Readonly<Record<MarketPlatform, string>> = { kalshi: 'https://kalshi.com/sports',
  polymarket: 'https://polymarket.com/sports' };
export const odds = (american: number | null) => american === null ? '—' : american > 0 ? `+${american}` : `−${-american}`;
const pct = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`;
export const cents = (value: number) => `${(value * 100).toFixed(1).replace(/\.0$/, '')}¢`;
const impliedOf = (american: number | null) => american === null ? null
  : american < 0 ? -american / (-american + 100) : 100 / (american + 100);

/** Loads one picks route when the screen is focused; demo mode shows a sign-in notice instead. */
export function usePicks<T>(path: string): { picks: T[]; fetchedAt: string | null; state: 'loading' | 'ready' | 'error' | 'demo' } {
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

export function MarketCard({ platform, pick, action }: { platform: MarketPlatform; pick: MarketPick; action?: React.ReactNode }) {
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
        <Text style={styles.stat}>{pick.kind === 'WINNER' ? 'Game winner' : pick.kind === 'SPREAD' ? 'Spread'
          : pick.kind === 'TOTAL' ? 'Game total' : 'Player prop · Yes'}</Text>
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
        <Text style={styles.factLabel}>{pick.by === 'HISTORY' ? 'History’s chance' : pick.note ? 'Books’ chance' : 'Pinnacle’s chance'}</Text></View>
      <View style={[styles.fact, styles.divider]}><Text style={[styles.factValue, { color: colors.mint }]}>+{cents(pick.edge)}</Text>
        <Text style={styles.factLabel}>Per $1</Text></View>
    </View>
    <Text style={styles.note}>Not a GKR score · {pick.note ?? 'market price against Pinnacle’s fair odds'}</Text>
    <ScoutVerdict read={pick.scout ?? undefined} gkrDirection="MORE" />
    {action ?? (!!pick.url && <GhostButton label={`Open in ${sourceNames[platform]}`} icon="open-in-new"
      onPress={() => void Linking.openURL(pick.url!)} />)}
  </View>;
}

type MarketRecordStatus = { graded: number; wins: number; losses: number; pushes: number; hitRate: number | null;
  perDollar: number | null };
/** A market tab's graded record. */
function useRecord(platform: MarketPlatform): MarketRecordStatus | null {
  const { request, demo } = useAuth();
  const [value, setValue] = useState<{ platform: MarketPlatform; record: MarketRecordStatus } | null>(null);
  useFocusEffect(useCallback(() => {
    if (demo) return;
    let active = true;
    void request(`/v1/markets/${platform}/record`).then(async (response) => response.ok ? response.json() : null)
      .then((body) => { if (active && body) setValue({ platform, record: body as MarketRecordStatus }); }).catch(() => undefined);
    return () => { active = false; };
  }, [request, demo, platform]));
  return value?.platform === platform ? value.record : null;
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
  const { picks, fetchedAt, state } = usePicks<BookPick>(`/v1/books/${book}/picks`);
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
        onPress={() => void Linking.openURL(bookUrls[book])} /> : null}
      ListEmptyComponent={<Notice title={state === 'demo' ? 'Sign in to see sportsbook picks' : state === 'loading'
        ? 'Loading picks' : state === 'error' ? 'Picks unavailable' : `No ${sourceNames[book]} picks right now`}
        detail={state === 'demo' ? 'The demo shows PrizePicks only.' : state === 'error'
          ? 'Could not reach CrownIQ. Try again in a moment.'
          : 'Picks show once the book’s prices load (every hour) and GKR, History or Value backs a side.'} />} />
  </SafeAreaView>;
}

/** Kalshi or Polymarket: markets priced below the fair chance (Pinnacle's or the sportsbooks'). */
export function MarketBoard({ platform, onSource }: { platform: MarketPlatform; onSource: (source: BoardSource) => void }) {
  const { picks, fetchedAt, state } = usePicks<MarketPick>(`/v1/markets/${platform}/picks`);
  const record = useRecord(platform);
  const { shown, chips } = useLeagueFilter(picks);
  const [legs] = useCrownLegs<MarketPick>(platform);
  const [message, setMessage] = useState('');
  const header = <View style={styles.header}>
    <AppHeader subtitle={`${sourceNames[platform]} picks`} />
    <BoardPicker value={platform} onChange={onSource} />
    {chips}
    {state === 'ready' && <Text style={styles.status}>{shown.length} {shown.length === 1 ? 'pick' : 'picks'}{ago(fetchedAt)}</Text>}
    {record && record.graded > 0 && <Text style={styles.record}>Record: {record.wins}-{record.losses}
      {record.pushes ? `-${record.pushes}` : ''} ({Math.round((record.hitRate ?? 0) * 100)}%) · {record.perDollar! >= 0 ? '+' : '−'}
      {Math.abs(Math.round(record.perDollar! * 100))}¢ per $1</Text>}
    <Text style={styles.explain}>Game winners, spreads and totals{platform === 'kalshi' ? ', and player props,' : ''} priced
      below their fair chance: Pinnacle’s odds, or the sportsbooks’ no-vig odds, at the same number
      {platform === 'kalshi' ? ' (Kalshi’s fee included). Player props also use the player’s history' : ''}. Not GKR scores.
      Add picks to your {sourceNames[platform]} Crown, or build one in the Crown tab.</Text>
    <CrownCount provider={platform} name={sourceNames[platform]} count={legs.length} message={message} />
  </View>;
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={shown} keyExtractor={(pick) => pick.id} contentContainerStyle={styles.content} ListHeaderComponent={header}
      renderItem={({ item }) => <MarketCard platform={platform} pick={item} action={<AddToCrown provider={platform}
        added={legs.some((leg) => leg.id === item.id)} onPress={() => {
          const result = toggleCrownLeg<MarketPick>(platform, item, (leg) => leg.id, 20);
          setMessage(result === 'full' ? `A ${sourceNames[platform]} Crown holds up to 20 picks here.` : '');
        }} />} />}
      ListFooterComponent={!shown.length && state === 'ready' ? <GhostButton label={`Open ${sourceNames[platform]}`}
        icon="open-in-new" onPress={() => void Linking.openURL(marketUrls[platform])} /> : null}
      ListEmptyComponent={<Notice title={state === 'demo' ? 'Sign in to see market picks' : state === 'loading'
        ? 'Loading picks' : state === 'error' ? 'Picks unavailable' : `No ${sourceNames[platform]} picks right now`}
        detail={state === 'demo' ? 'The demo shows PrizePicks only.' : state === 'error'
          ? 'Could not reach CrownIQ. Try again in a moment.'
          : `Every ${sourceNames[platform]} market that matches the books is priced at or above its fair chance right now. ` +
            'These markets usually sit within 1–2 points.'} />} />
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
