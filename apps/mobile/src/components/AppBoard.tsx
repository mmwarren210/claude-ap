import { useRecordText } from '../use-hit-rates';
import { openCrownOn, useCrownLegs } from '../crown-legs';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth';
import { bestBreakEven } from '@crowniq/contracts';
import { entryName, entryOutlook, formatLine, gameTime, percent1 } from '../insights';
import { usePayouts } from '../use-payouts';
import { colors, radius } from '../theme';
import { SCOUT } from '../scout';
import { useBoard } from '../use-board';
import { appNames } from '../port';
import type { PickApp } from '../port';
import { BoardPicker, pickApps } from './BoardPicker';
import type { BoardSource } from './BoardPicker';
import { Notice } from './Screen';
import { AppHeader } from './ui/AppHeader';
import { ChipRow, FilterChip, PrimaryButton, Segmented } from './ui/Controls';
import { useLeagueStatFilter } from './LeagueStatFilter';
import { PlayerAvatar } from './ui/PlayerAvatar';
import { backedSide, historySide, scoutSide, sideLabel } from '../app-lines';
import type { AppLine, Side } from '../app-lines';


/** The stat key for the stat picker, and its name as the app shows it. */
const appStat = (line: AppLine) => line.market ?? line.stat;
const statName = (lines: readonly AppLine[]) => { const names = new Map(lines.map((line) => [appStat(line), line.stat]));
  return (key: string) => names.get(key) ?? key; };

export type { PickApp };
export { pickApps };

/** The side's boosted payout (Pick6 pays some picks above 1x), or null. */
export const boostOf = (line: { multipliers: Partial<Record<Side, number>> | null }, side: Side) =>
  (line.multipliers?.[side] ?? 0) >= 1.1 ? line.multipliers![side]! : null;
const boosted = (line: AppLine) => line.availableDirections.some((side) => boostOf(line, side)) || !!line.promo;


function Reference({ line }: { line: AppLine }) {
  const reference = line.prizePicks;
  if (!reference) return <Text style={styles.reference}>{line.scout ? scoutSide(line) ? `Not on PrizePicks · ${SCOUT} researched it`
    : `Not on PrizePicks · ${SCOUT} sees no edge` : `Not on PrizePicks · ${SCOUT} hasn’t read it yet`}</Text>;
  const same = reference.threshold === line.threshold;
  return <Text style={[styles.reference, reference.gkr && styles.referenceStrong]}>
    PrizePicks {formatLine(reference.threshold)}{same ? ' (same line)' : ''} · {reference.gkr
      ? `GKR ${Math.round(reference.gkr.score)} ${reference.gkr.direction === 'MORE' ? 'More' : 'Less'}` : 'GKR passes'}
    {!line.gkr ? ` · ${line.scout ? scoutSide(line) ? `${SCOUT} researched it` : `${SCOUT} sees no edge` : `${SCOUT} hasn’t read it yet`}` : ''}
  </Text>;
}

function LineCard({ app, line, picked, onPick, asking, onAsk }: { app: PickApp; line: AppLine; picked: Side | null;
  onPick: (side: Side) => void; asking: boolean; onAsk?: () => void }) {
  const source = line.gkr ? null : scoutSide(line) ? 'scout' : historySide(line) ? line.history?.trend ? 'trend' : 'history' : null;
  const record = useRecordText(source, line.sport, line.market ?? line.stat);
  return <View style={[styles.card, picked && styles.cardPicked]}>
    <View style={styles.cardHead}>
      <PlayerAvatar name={line.playerName} photoUrl={line.playerImageUrl} size={48} ring={picked ? colors.mint : colors.borderStrong} />
      <View style={styles.grow}>
        <Text style={styles.name} numberOfLines={1}>{line.playerName}</Text>
        <Text style={styles.meta} numberOfLines={1}>{line.league} · {line.team ?? line.eventName}
          {line.opponent ? ` vs ${line.opponent}` : ''}</Text>
        <Text style={styles.meta}>{gameTime(line.eventStartTime)}</Text>
      </View>
      <View style={styles.number}><Text style={styles.threshold}>{formatLine(line.threshold)}</Text>
        <Text style={styles.stat} numberOfLines={2}>{line.stat}</Text></View>
    </View>
    {(boosted(line)) && <View style={styles.promoRow}>
      {line.promo?.gimme && <Text style={styles.promoTag}>GIMME</Text>}
      {line.promo?.originalLine != null && <Text style={styles.promoTag}>PROMO · was {formatLine(line.promo.originalLine)}</Text>}
      {line.availableDirections.filter((side) => boostOf(line, side)).map((side) => <Text key={side} style={styles.promoTag}>
        BOOST · {sideLabel(app, side)} pays {boostOf(line, side)}x</Text>)}
      {line.gkr && boostOf(line, line.gkr.direction) && <Text style={[styles.promoTag, styles.promoBacked]}>GKR’s side is boosted</Text>}
    </View>}
    {line.gkr && <View style={styles.gkr}>
      <Text style={styles.gkrScore}>GKR {Math.round(line.gkr.score)}</Text>
      <Text style={styles.gkrSide}>{sideLabel(app, line.gkr.direction)} {formatLine(line.threshold)}</Text>
    </View>}
    {historySide(line) && <View style={styles.gkr}>
      <Text style={[styles.gkrScore, { color: line.history!.lean || line.history!.trend ? colors.amber : colors.royal }]}>
        {line.history!.trend ? 'Trend' : 'History'} {line.history!.lean ? 'lean ' : ''}{Math.round(line.history!.score!)}</Text>
      <Text style={styles.gkrSide}>{sideLabel(app, historySide(line)!)} {formatLine(line.threshold)}</Text>
    </View>}
    {historySide(line) && <Text style={styles.reference}>{line.history!.text} · {line.history!.source}</Text>}
    {!!record && <Text style={[styles.reference, { color: colors.gold }]}>Our record · {record}</Text>}
    {!line.gkr && scoutSide(line) && <View style={styles.gkr}>
      <Text style={[styles.gkrScore, styles.scoutScore]}>{SCOUT} {Math.round(line.scout!.score!)}</Text>
      <Text style={styles.gkrSide}>{sideLabel(app, scoutSide(line)!)} {formatLine(line.threshold)}</Text>
    </View>}
    <Reference line={line} />
    {onAsk && !line.gkr && !line.scout && <Pressable accessibilityRole="button" disabled={asking} onPress={onAsk}
      style={[styles.ask, asking && styles.askBusy]}>
      <Text style={styles.askText}>{asking ? `${SCOUT} is researching… (up to a minute)` : `Ask ${SCOUT} for a More/Less`}</Text>
    </Pressable>}
    <View style={styles.sides}>
      {line.availableDirections.map((side) => <Pressable key={side} accessibilityRole="button"
        accessibilityState={{ selected: picked === side }} onPress={() => onPick(side)}
        style={[styles.side, backedSide(line) === side && styles.sideBacked, picked === side && styles.sideActive]}>
        <Text style={[styles.sideText, picked === side && styles.sideTextActive]}>{sideLabel(app, side)}
          {line.multipliers?.[side] ? ` · ${line.multipliers[side]}x` : ''}{line.gkr?.direction === side ? ' · GKR'
            : scoutSide(line) === side ? ` · ${SCOUT}` : historySide(line) === side ? line.history?.trend ? ' · Trend' : ' · History' : ''}</Text></Pressable>)}
    </View>
  </View>;
}

/**
 * An Underdog or Pick6 board: the app's own lines, picked and saved as the user's own slip. GKR scores each line it can
 * read at the app's own number; the same PrizePicks line and its GKR score show beside it.
 */
export function AppBoard({ app, onApp }: { app: Exclude<PickApp, 'prizepicks'>; onApp: (app: BoardSource) => void }) {
  const { request, demo } = useAuth();
  const { nowMs } = useBoard();
  const [lines, setLines] = useState<AppLine[]>([]), [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [gkrOnly, setGkrOnly] = useState(false);
  const [boostOnly, setBoostOnly] = useState(false);
  const [scored, setScored] = useState(false);
  // Picks go to this app's Crown (built, saved and copied in the Crown tab).
  const [slip, setSlip] = useCrownLegs<{ line: AppLine; side: Side }>(app);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    if (demo) { setState('ready'); return; }
    try {
      const response = await request(`/v1/apps/${app}/board`);
      if (!response.ok) throw new Error('unavailable');
      const body = await response.json() as { lines: AppLine[]; fetchedAt: string | null; gkrScored?: boolean };
      setScored(!!body.gkrScored);
      setLines(body.lines); setFetchedAt(body.fetchedAt); setState('ready');
    } catch { setState('error'); }
  }, [app, request, demo]);
  useFocusEffect(useCallback(() => { setState('loading'); void load(); }, [load]));

  // League and stat pickers (several of each at once).
  const { shown: filtered, pickers } = useLeagueStatFilter(lines, appStat, statName(lines));
  // Picks: lines GKR backs (strongest first), then Scout's plays where GKR can't read the line.
  const shown = useMemo(() => {
    const inLeague = filtered.filter((line) => !boostOnly || boosted(line));
    // Playable lines first (GKR's, then Scout's, strongest first), then lines not read yet, then Scout's no-edge reads;
    // each group keeps game-time order.
    const strength = (line: AppLine) => line.gkr ? 1000 + line.gkr.score : scoutSide(line) ? 500 + (line.scout!.score ?? 0)
      : historySide(line) ? line.history!.score ?? 0 : 0;
    const group = (line: AppLine) => backedSide(line) ? 0 : line.scout ? 2 : 1;
    const ordered = [...inLeague].sort((a, b) => group(a) - group(b) || strength(b) - strength(a));
    return gkrOnly ? ordered.filter(backedSide) : ordered;
  }, [filtered, gkrOnly, boostOnly]);
  const boostCount = useMemo(() => lines.filter(boosted).length, [lines]);
  const backed = useMemo(() => lines.filter(backedSide).length, [lines]);
  const picks = new Map(slip.map((item) => [item.line.id, item.side]));
  const pick = (line: AppLine, side: Side) => {
    setMessage('');
    if (picks.get(line.id) === side) { setSlip(slip.filter((item) => item.line.id !== line.id)); return; }
    if (Date.parse(line.eventStartTime) <= nowMs) { setMessage('That game has started.'); return; }
    if (slip.some((item) => item.line.playerId === line.playerId && item.line.id !== line.id)) {
      setMessage(`${line.playerName} is already on this slip.`); return;
    }
    if (!picks.has(line.id) && slip.length >= 8) { setMessage(`A ${appNames[app]} Crown holds up to 8 picks.`); return; }
    setSlip([...slip.filter((item) => item.line.id !== line.id), { line, side }]);
    setMessage(`Added ${line.playerName} to your ${appNames[app]} Crown.`);
  };
  // Ask Scout on one line now (same daily allowance as Ask Scout on the PrizePicks board).
  const [asking, setAsking] = useState<Set<string>>(new Set());
  const askScout = async (line: AppLine) => {
    setMessage(''); setAsking((current) => new Set(current).add(line.id));
    const response = await request(`/v1/apps/${app}/ask/${encodeURIComponent(line.id)}`, { method: 'POST' }).catch(() => null);
    setAsking((current) => { const next = new Set(current); next.delete(line.id); return next; });
    const body = response ? await response.json().catch(() => ({})) as { scout?: AppLine['scout']; code?: string } : {};
    if (response?.ok && body.scout) {
      setLines((current) => current.map((item) => item.id === line.id ? { ...item, scout: body.scout } : item));
      if (body.scout.pick === 'PASS') setMessage(`${SCOUT} sees no edge on ${line.playerName}.`);
      return;
    }
    setMessage(body.code === 'DAILY_LIMIT_REACHED' ? `You’ve used today’s Ask ${SCOUT} picks. More tomorrow.`
      : body.code === 'EVENT_STARTED' ? 'That game has started.' : `${SCOUT} couldn’t answer right now. Try again soon.`);
  };
  const appPayouts = usePayouts()[app];
  const easiest = bestBreakEven(appPayouts);
  // This slip's size at the app's payouts: the entry (Power or Flex) that needs the lowest hit rate per pick.
  const slipEntry = slip.length >= 2 ? (['FLEX', 'POWER'] as const).flatMap((mode) => {
    const outlook = entryOutlook(appPayouts, slip.length, mode);
    return outlook ? [{ mode, ...outlook }] : [];
  }).sort((a, b) => a.breakEven - b.breakEven)[0] ?? null : null;
  // Underdog and Pick6 multiply the entry's payout by each pick's own multiplier (a boost above 1x, a cut below).
  const slipBoost = Math.round(slip.reduce((product, item) => product * (item.line.multipliers?.[item.side] ?? 1), 1) * 100) / 100;
  const age = fetchedAt ? Math.max(0, Math.round((nowMs - Date.parse(fetchedAt)) / 60_000)) : null;
  const header = <View style={styles.header}>
    <AppHeader subtitle={`${appNames[app]} board`} />
    <BoardPicker value={app} onChange={onApp} />
    {pickers}
    {boostCount > 0 && <ChipRow>
      {boostCount > 0 && <FilterChip label={`Boosted (${boostCount})`} icon="rocket-launch-outline" active={boostOnly}
        chevron={false} onPress={() => setBoostOnly(!boostOnly)} />}
    </ChipRow>}
    {scored && <Segmented label="Which lines" value={gkrOnly ? 'GKR' : 'ALL'} onChange={(value) => setGkrOnly(value === 'GKR')}
      options={[{ value: 'ALL', label: 'All lines' }, { value: 'GKR', label: `Picks (${backed})` }]} />}
    <Text style={styles.status}>{shown.length} lines{age === null ? '' : ` · captured ${age < 90 ? `${age} min` : `${Math.round(age / 60)} h`} ago`}</Text>
    <Text style={styles.note}>{scored ? `GKR scores ${appNames[app]} lines at ${appNames[app]}’s own number, using the same
      research as PrizePicks. These scores are new on ${appNames[app]} and are being tracked.` : `GKR doesn’t score
      ${appNames[app]} lines yet.`} PrizePicks’ line for the same player and stat shows for comparison. Confirm the line in
      {' '}{appNames[app]} before you play it.</Text>
    {easiest && <Text style={styles.breakEven}>{slipEntry ? `Your ${slip.length} picks: play ${entryName(slip.length,
      slipEntry.mode)} (${slipEntry.fullHit}x${slipBoost !== 1 ? `, and its picks' payouts multiply that by ${slipBoost}` : ''}). Each pick needs to hit ${percent1(slipEntry.breakEven)} to break even. `
      : slip.length >= 2 ? `CrownIQ doesn’t have ${appNames[app]}’s ${slip.length}-pick payout yet; check it in the app. ` : ''}Easiest ${appNames[app]} entry: {entryName(easiest.legs, easiest.mode)}, {percent1(easiest.breakEven)} per pick.</Text>}
    {!!message && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
  </View>;

  return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={shown} keyExtractor={(line) => line.id} initialNumToRender={8} maxToRenderPerBatch={10} windowSize={7}
      contentContainerStyle={styles.content} ListHeaderComponent={header}
      renderItem={({ item }) => <LineCard app={app} line={item} picked={picks.get(item.id) ?? null}
        onPick={(side) => pick(item, side)} asking={asking.has(item.id)} onAsk={demo ? undefined : () => void askScout(item)} />}
      ListEmptyComponent={<Notice title={demo ? 'Sign in to see this board' : state === 'loading' ? 'Loading board'
        : state === 'error' ? 'Board unavailable' : 'No lines right now'}
        detail={demo ? `The demo shows PrizePicks only. Sign in to see ${appNames[app]} lines.`
          : state === 'error' ? 'Could not reach CrownIQ. Try again in a moment.'
            : `${appNames[app]} lines are pulled four times a day (9am, noon, 3pm and 6pm ET).`} />} />
    {slip.length > 0 && <View style={styles.tray}>
      <Text style={styles.trayText}>{slip.length} {slip.length === 1 ? 'pick' : 'picks'} in your {appNames[app]} Crown</Text>
      <PrimaryButton label="Open Crown" icon="crown" onPress={() => { openCrownOn(app); router.push('/(tabs)/crown'); }} />
    </View>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 140, gap: 12 },
  header: { gap: 12, marginBottom: 2 },
  status: { color: colors.textMuted, fontSize: 13 },
  breakEven: { color: colors.text, fontSize: 13, lineHeight: 19, fontWeight: '600' },
  promoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  promoTag: { color: colors.gold, borderColor: colors.gold, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 7,
    paddingVertical: 3, fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  promoBacked: { color: colors.mint, borderColor: colors.mint },
  builder: { gap: 8, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, padding: 12 },
  builderTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  message: { color: colors.gold, fontSize: 13, fontWeight: '600' },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surface, padding: 12, gap: 10 },
  cardPicked: { borderColor: colors.mint },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 16, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: 12 },
  number: { alignItems: 'flex-end', maxWidth: 120 },
  threshold: { color: colors.text, fontSize: 22, fontWeight: '900' },
  stat: { color: colors.textMuted, fontSize: 11.5, textAlign: 'right' },
  reference: { color: colors.textFaint, fontSize: 12 },
  referenceStrong: { color: colors.mint, fontWeight: '700' },
  sides: { flexDirection: 'row', gap: 8 },
  side: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.borderStrong },
  sideActive: { backgroundColor: colors.mint, borderColor: colors.mint },
  sideText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  sideTextActive: { color: colors.mintInk },
  sideBacked: { borderColor: colors.mint },
  gkr: { flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start', paddingVertical: 4,
    paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: colors.mintWash,
    borderWidth: 1, borderColor: colors.mint },
  gkrScore: { color: colors.mint, fontSize: 14, fontWeight: '900' },
  scoutScore: { color: colors.electric },
  ask: { borderWidth: 1, borderColor: colors.electric, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' },
  askBusy: { opacity: 0.6 },
  askText: { color: colors.electric, fontSize: 14, fontWeight: '800' },
  gkrSide: { color: colors.text, fontSize: 13, fontWeight: '700' },
  tray: { position: 'absolute', left: 16, right: 16, bottom: 12, gap: 8, padding: 12, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.mint, backgroundColor: colors.surface },
  trayText: { color: colors.text, fontSize: 14, fontWeight: '700' },
});
