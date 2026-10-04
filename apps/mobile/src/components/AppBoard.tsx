import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth';
import { formatLine, gameTime } from '../insights';
import { colors, radius } from '../theme';
import { useBoard } from '../use-board';
import { Notice } from './Screen';
import { AppHeader } from './ui/AppHeader';
import { ChipRow, FilterChip, PrimaryButton, Segmented } from './ui/Controls';
import { PlayerAvatar } from './ui/PlayerAvatar';

export type PickApp = 'prizepicks' | 'underdog' | 'pick6';
export const pickApps: readonly { value: PickApp; label: string }[] = [
  { value: 'prizepicks', label: 'PrizePicks' }, { value: 'underdog', label: 'Underdog' }, { value: 'pick6', label: 'Pick6' }];
const appNames: Readonly<Record<PickApp, string>> = { prizepicks: 'PrizePicks', underdog: 'Underdog', pick6: 'DraftKings Pick6' };

type Side = 'MORE' | 'LESS';
/** One Underdog or Pick6 line, as /v1/apps/:app/board serves it. */
type AppLine = { id: string; sport: string; league: string; eventName: string; eventStartTime: string; playerId: string;
  playerName: string; team: string | null; opponent: string | null; stat: string; threshold: number; lineType: string;
  availableDirections: Side[]; multipliers: Partial<Record<Side, number>> | null; playerImageUrl: string | null;
  prizePicks: { threshold: number; lineType: string; gkr: { direction: Side; score: number } | null } | null };

const sideLabel = (app: PickApp, side: Side) => app === 'underdog' ? side === 'MORE' ? 'Higher' : 'Lower'
  : side === 'MORE' ? 'More' : 'Less';

function Reference({ line }: { line: AppLine }) {
  const reference = line.prizePicks;
  if (!reference) return <Text style={styles.reference}>Not on PrizePicks · no GKR read</Text>;
  const same = reference.threshold === line.threshold;
  return <Text style={[styles.reference, reference.gkr && styles.referenceStrong]}>
    PrizePicks {formatLine(reference.threshold)}{same ? ' (same line)' : ''} · {reference.gkr
      ? `GKR ${Math.round(reference.gkr.score)} ${reference.gkr.direction === 'MORE' ? 'More' : 'Less'}` : 'GKR passes'}
  </Text>;
}

function LineCard({ app, line, picked, onPick }: { app: PickApp; line: AppLine; picked: Side | null;
  onPick: (side: Side) => void }) {
  return <View style={[styles.card, picked && styles.cardPicked]}>
    <View style={styles.cardHead}>
      <PlayerAvatar name={line.playerName} photoUrl={line.playerImageUrl} size={48} ring={picked ? colors.mint : colors.borderStrong} />
      <View style={styles.grow}>
        <Text style={styles.name} numberOfLines={1}>{line.playerName}</Text>
        <Text style={styles.meta} numberOfLines={1}>{line.league} · {line.team ?? line.eventName}
          {line.opponent ? ` vs ${line.opponent}` : ''} · {gameTime(line.eventStartTime)}</Text>
      </View>
      <View style={styles.number}><Text style={styles.threshold}>{formatLine(line.threshold)}</Text>
        <Text style={styles.stat} numberOfLines={2}>{line.stat}</Text></View>
    </View>
    <Reference line={line} />
    <View style={styles.sides}>
      {line.availableDirections.map((side) => <Pressable key={side} accessibilityRole="button"
        accessibilityState={{ selected: picked === side }} onPress={() => onPick(side)}
        style={[styles.side, picked === side && styles.sideActive]}>
        <Text style={[styles.sideText, picked === side && styles.sideTextActive]}>{sideLabel(app, side)}
          {line.multipliers?.[side] ? ` · ${line.multipliers[side]}x` : ''}</Text></Pressable>)}
    </View>
  </View>;
}

/**
 * An Underdog or Pick6 board: the app's own lines, picked and saved as the user's own slip. GKR does not score these
 * lines; the same PrizePicks line and its GKR score show beside them for reference.
 */
export function AppBoard({ app, onApp }: { app: Exclude<PickApp, 'prizepicks'>; onApp: (app: PickApp) => void }) {
  const { request, demo } = useAuth();
  const { nowMs } = useBoard();
  const [lines, setLines] = useState<AppLine[]>([]), [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [sport, setSport] = useState('ALL');
  const [slip, setSlip] = useState<{ line: AppLine; side: Side }[]>([]);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    if (demo) { setState('ready'); return; }
    try {
      const response = await request(`/v1/apps/${app}/board`);
      if (!response.ok) throw new Error('unavailable');
      const body = await response.json() as { lines: AppLine[]; fetchedAt: string | null };
      setLines(body.lines); setFetchedAt(body.fetchedAt); setState('ready');
    } catch { setState('error'); }
  }, [app, request, demo]);
  useFocusEffect(useCallback(() => { setState('loading'); void load(); }, [load]));

  const sports = useMemo(() => [...new Set(lines.map((line) => line.league))].sort(), [lines]);
  const shown = useMemo(() => lines.filter((line) => sport === 'ALL' || line.league === sport), [lines, sport]);
  const picks = new Map(slip.map((item) => [item.line.id, item.side]));
  const pick = (line: AppLine, side: Side) => {
    setMessage('');
    if (picks.get(line.id) === side) { setSlip(slip.filter((item) => item.line.id !== line.id)); return; }
    if (Date.parse(line.eventStartTime) <= nowMs) { setMessage('That game has started.'); return; }
    if (slip.some((item) => item.line.playerId === line.playerId && item.line.id !== line.id)) {
      setMessage(`${line.playerName} is already on this slip.`); return;
    }
    if (!picks.has(line.id) && slip.length >= 6) { setMessage('A slip holds up to 6 picks.'); return; }
    setSlip([...slip.filter((item) => item.line.id !== line.id), { line, side }]);
  };
  const save = async () => {
    try {
      const response = await request('/v1/me/crowns', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app, personal: true, lineIds: slip.map((item) => item.line.id),
          directions: Object.fromEntries(slip.map((item) => [item.line.id, item.side])) }) });
      if (response.ok) { setSlip([]); setMessage(`Saved to Your Picks in Results. It’s graded once the games finish.`); return; }
      setMessage(response.status === 403 ? 'Demo mode is read-only. Sign in to save slips.'
        : 'Could not save this slip. A line may have moved or started; refresh and try again.');
    } catch { setMessage('Could not reach CrownIQ. Try again.'); }
  };

  const age = fetchedAt ? Math.max(0, Math.round((nowMs - Date.parse(fetchedAt)) / 60_000)) : null;
  const header = <View style={styles.header}>
    <AppHeader subtitle={`${appNames[app]} board`} />
    <Segmented label="Pick'em app" options={pickApps} value={app} onChange={onApp} />
    {lines.length > 0 && <ChipRow>
      <FilterChip label="All leagues" active={sport === 'ALL'} onPress={() => setSport('ALL')} />
      {sports.map((league) => <FilterChip key={league} label={league} active={sport === league} onPress={() => setSport(league)} />)}
    </ChipRow>}
    <Text style={styles.status}>{shown.length} lines{age === null ? '' : ` · captured ${age < 90 ? `${age} min` : `${Math.round(age / 60)} h`} ago`}</Text>
    <Text style={styles.note}>GKR doesn’t score {appNames[app]} lines yet. When PrizePicks has the same player and stat, its
      line and GKR score show for reference. Confirm the line in {appNames[app]} before you play it.</Text>
    {!!message && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
  </View>;

  return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={shown} keyExtractor={(line) => line.id} initialNumToRender={8} maxToRenderPerBatch={10} windowSize={7}
      contentContainerStyle={styles.content} ListHeaderComponent={header}
      renderItem={({ item }) => <LineCard app={app} line={item} picked={picks.get(item.id) ?? null}
        onPick={(side) => pick(item, side)} />}
      ListEmptyComponent={<Notice title={demo ? 'Sign in to see this board' : state === 'loading' ? 'Loading board'
        : state === 'error' ? 'Board unavailable' : 'No lines right now'}
        detail={demo ? `The demo shows PrizePicks only. Sign in to see ${appNames[app]} lines.`
          : state === 'error' ? 'Could not reach CrownIQ. Try again in a moment.'
            : `${appNames[app]} lines are pulled four times a day (9am, noon, 3pm and 6pm ET).`} />} />
    {slip.length > 0 && <View style={styles.tray}>
      <Text style={styles.trayText}>{slip.length} {slip.length === 1 ? 'pick' : 'picks'} on your {appNames[app]} slip</Text>
      <PrimaryButton label={slip.length < 2 ? 'Add 1 more to save' : 'Save slip'} icon="content-save-outline"
        disabled={slip.length < 2} onPress={() => void save()} />
    </View>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 140, gap: 12 },
  header: { gap: 12, marginBottom: 2 },
  status: { color: colors.textMuted, fontSize: 13 },
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
  tray: { position: 'absolute', left: 16, right: 16, bottom: 12, gap: 8, padding: 12, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.mint, backgroundColor: colors.surface },
  trayText: { color: colors.text, fontSize: 14, fontWeight: '700' },
});
