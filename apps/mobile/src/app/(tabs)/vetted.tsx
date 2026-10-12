import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../auth';
import { pickImage } from '../../pick-image';
import { AppHeader } from '../../components/ui/AppHeader';
import { ModelBanner } from '../../components/ui/ModelBanner';
import { ManualPick } from '../../components/ManualPick';
import type { ReadLine } from '../../components/ManualPick';
import { colors, radius } from '../../theme';

// Vetted (owner, 2026-10-11): outside tips CrownIQ checked and rated PLAY, for everyone. Who posted a tip is never shown.
type VettedPick = { id: string; sport: string | null; league: string | null; selection: string; opponent: string | null; market: string;
  line: number | null; side: 'OVER' | 'UNDER' | null; stat: string | null; eventDate: string | null;
  status: 'PENDING' | 'WON' | 'LOST' | 'PUSH' | 'VOID'; createdAt: string; chance: number; price: number | null; ev: number | null;
  event: string | null; start: string | null; reasons?: string[]; live?: boolean; submittedBy?: string | null;
  checks?: { edge: string | null; gkr: string | null; edgeChance?: number | null; gkrChance?: number | null; breakEven?: number | null } | null;
  /** Who rated it PLAY: the AI (market check), GKR, Edge. */
  approvedBy?: string[] };
type VettedRecord = { won: number; lost: number; push: number; units: number; roi: number | null };
type Scoreboard = { allTime: VettedRecord; last7: VettedRecord; bySport: Record<string, VettedRecord>;
  streak: { kind: 'W' | 'L'; length: number } | null; pending: number; live: number; updatedAt: string };
type HiddenPick = { id: string; league: string | null; sport: string | null; selection: string; market: string; line: number | null;
  side: string | null; stat: string | null; status: VettedPick['status']; chance: number; price: number | null; ev: number | null;
  submittedBy: string | null; checks: { edge: string | null; gkr: string | null } };
/** `hidden` comes only for the owner: PLAYs that Edge called FADE at the tip's price, kept off the list. */
type Vetted = { picks: VettedPick[]; record: VettedRecord; scoreboard: Scoreboard | null; hidden?: HiddenPick[] };
type MyTip = { id: string; createdAt: string; selection: string; market: string; line: number | null; side: string | null; stat?: string | null;
  status: VettedPick['status']; analyzing?: boolean; reused?: boolean;
  analysis?: { verdict: 'PLAY' | 'LEAN' | 'PASS' | 'FADE'; chance: number; price: number | null; ev: number | null; reasons: string[] } | null;
  approval?: { approved: boolean; approvedBy: string[] };
  /** A better play on the same player and stat (another line, side or app) when nobody approved the pick as posted. */
  suggestion?: { platform: string; line: number; side: 'MORE' | 'LESS'; lineType: string; chance: number; breakEven: number; edge: number } | null };
type Mine = { tips: MyTip[]; uploadsLeft: number | null; dailyLimit: number | null; reading: boolean };

const odds = (price: number) => price > 0 ? `+${price}` : `${price}`;
const marketText = (pick: VettedPick) => {
  if (pick.market === 'PLAYER_PROP') return `${pick.side === 'UNDER' ? 'Under' : 'Over'} ${pick.line ?? ''} ${pick.stat ?? ''}`.trim();
  if (pick.market === 'TOTAL') return `${pick.side === 'UNDER' ? 'Under' : 'Over'} ${pick.line ?? ''}`.trim();
  if (pick.market === 'SPREAD') return `Spread ${pick.line !== null && pick.line > 0 ? '+' : ''}${pick.line ?? ''}`;
  if (pick.market === 'MONEYLINE') return 'To win';
  return pick.market.replace(/_/g, ' ').toLowerCase();
};
const when = (pick: VettedPick) => {
  const time = pick.start ?? pick.eventDate;
  if (!time) return null;
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric',
    ...(pick.start ? { hour: 'numeric', minute: '2-digit' } : {}) });
};
const statusColor = (status: VettedPick['status']) => status === 'WON' ? colors.mint : status === 'LOST' ? colors.red : colors.textMuted;

export default function VettedTab() {
  const { request } = useAuth();
  const [data, setData] = useState<Vetted | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { const response = await request('/v1/vetted'); if (!response.ok) throw new Error();
      setData(await response.json() as Vetted); setError(''); }
    catch { setError('Could not load Vetted picks. Pull down to try again.'); }
    finally { setLoading(false); }
  }, [request]);
  // Your own submissions: verdicts show the moment they land (checked every few seconds while one is being read).
  const [mine, setMine] = useState<Mine | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  // The free reader's matches when the AI couldn't read a screenshot (confirmed one by one below).
  const [freeRead, setFreeRead] = useState<{ id: number; lines: ReadLine[] } | null>(null);
  const loadMine = useCallback(async () => {
    const response = await request('/v1/tips').catch(() => null);
    if (response?.ok) setMine(await response.json() as Mine);
  }, [request]);
  // The shared board (scoreboard and every vetted pick) reloads every 5 minutes while the tab is open, to keep the server light.
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => { void load(); void loadMine(); setFocused(true); return () => setFocused(false); }, [load, loadMine]));
  useEffect(() => { if (!focused) return; const timer = setInterval(() => { void load(); }, 5 * 60_000); return () => clearInterval(timer); }, [focused, load]);
  const reading = !!mine?.tips.some((tip) => tip.analyzing);
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => { void loadMine(); }, 4000);
    return () => { clearInterval(timer); void load(); };
  }, [reading, loadMine, load]);
  const submit = async () => {
    setMessage('');
    let image: { data: string; mediaType: string } | null = null;
    try { image = await pickImage(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not open that picture.'); return; }
    if (!image) return;
    setBusy(true);
    try {
      const response = await request('/v1/tips/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image }) });
      if (response.ok) { const added = await response.json() as { tips?: unknown[]; free?: boolean; lines?: ReadLine[] };
        if (added.free && added.lines) { setFreeRead({ id: Date.now(), lines: added.lines });
          setMessage(`Found ${added.lines.length} ${added.lines.length === 1 ? 'pick' : 'picks'} on the board. Tap the side on each one below to add it.`); }
        else { const count = added.tips?.length ?? 0;
          setMessage(`Read ${count} ${count === 1 ? 'pick' : 'picks'}. CrownIQ is checking ${count === 1 ? 'it' : 'them'} now…`); } }
      else setMessage(response.status === 429 ? `You’ve used today’s ${mine?.dailyLimit ?? 2} screenshots. More tomorrow.`
        : response.status === 422 ? 'No board picks found in that picture. Try a clearer screenshot, or add them by hand below.'
        : response.status === 503 ? 'Screenshot checking is down right now. Try again later.' : 'Could not read that picture. Try again.');
    } catch { setMessage('Could not upload. Check your connection.'); }
    finally { setBusy(false); void loadMine(); }
  };
  // Only picks worth acting on: approved PLAYs, suggested better plays, and ones still being read. True passes stay off.
  const worthShowing = (tip: MyTip) => tip.analyzing || tip.approval?.approved || !!tip.suggestion;
  // Graded picks leave the list (owner, 2026-10-12): their results live in the scoreboard above.
  const recentMine = mine?.tips.filter((tip) => worthShowing(tip) && tip.status === 'PENDING').slice(0, 12) ?? [];
  const passed = mine ? mine.tips.slice(0, 40).filter((tip) => !worthShowing(tip) && tip.status === 'PENDING').length : 0;
  const upcoming = data?.picks.filter((pick) => pick.status === 'PENDING') ?? [];
  const settled = data?.picks.filter((pick) => pick.status !== 'PENDING') ?? [];
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={colors.mint} />}>
      <AppHeader subtitle="Vetted" />
      <ModelBanner title="Crown Approved" text="Outside tips checked by the market, GKR and Edge. A pick makes this list when one of them rates it PLAY and none calls it a FADE." />
      {data?.scoreboard && <ScoreboardCard board={data.scoreboard} />}
      <View style={styles.submit}>
        <Text style={styles.boardTitle}>SUBMIT A PICK</Text>
        <Text style={styles.muted}>Got a screenshot of picks? CrownIQ checks every pick with the market, GKR and Edge. You’ll see the PLAYs, plus a better line on another app when the posted one isn’t worth it. PLAYs join this list with your name on them.</Text>
        <Pressable accessibilityRole="button" disabled={busy || mine?.uploadsLeft === 0} onPress={() => void submit()}
          style={[styles.button, (busy || mine?.uploadsLeft === 0) && styles.buttonOff]}>
          {busy ? <ActivityIndicator color={colors.mintInk} /> : <Text style={styles.buttonText}>Upload screenshot</Text>}
        </Pressable>
        {mine?.uploadsLeft !== null && mine?.uploadsLeft !== undefined && <Text style={styles.faint}>{mine.uploadsLeft} of {mine.dailyLimit} left today</Text>}
        {!!message && <Text style={styles.muted}>{message}</Text>}
        <ManualPick read={freeRead} onAdded={() => { void loadMine(); void load(); }} />
        {recentMine.length > 0 && <Text style={[styles.section, { marginTop: 4 }]}>YOUR SUBMISSIONS</Text>}
        {recentMine.map((tip) => <MineRow key={tip.id} tip={tip} />)}
        {passed > 0 && <Text style={styles.faint}>{passed} more {passed === 1 ? 'pick was' : 'picks were'} checked with no play on any line or app, so {passed === 1 ? 'it’s' : 'they’re'} not listed.</Text>}
      </View>
      {!!error && <Text style={styles.muted}>{error}</Text>}
      {data && !upcoming.length && <Text style={styles.muted}>No vetted plays right now. New ones show up here as CrownIQ approves them.</Text>}
      {upcoming.map((pick) => <PickCard key={pick.id} pick={pick} />)}
      {settled.length > 0 && <Text style={styles.section}>RECENT RESULTS</Text>}
      {settled.map((pick) => <PickCard key={pick.id} pick={pick} />)}
      {!!data?.hidden && <Text style={styles.section}>HIDDEN BY GKR & EDGE · ONLY YOU SEE THIS</Text>}
      {!!data?.hidden && !data.hidden.length && <Text style={styles.muted}>Nothing hidden right now.</Text>}
      {data?.hidden?.map((pick) => <View key={pick.id} style={[styles.card, styles.hiddenCard]}>
        <View style={styles.row}><Text style={styles.league}>{pick.league ?? pick.sport ?? ''}</Text>
          <Text style={[styles.badge, { color: pick.status === 'PENDING' ? colors.textMuted : statusColor(pick.status) }]}>
            {pick.status === 'PENDING' ? 'HIDDEN' : pick.status}</Text></View>
        <Text style={styles.selection}>{pick.selection}</Text>
        <Text style={styles.market}>{pick.side === 'UNDER' ? 'Under' : 'Over'} {pick.line ?? ''} {pick.stat ?? ''}</Text>
        <Text style={styles.muted}>AI: {Math.round(pick.chance * 100)}%{pick.price !== null ? ` at ${odds(pick.price)}` : ''}  ·  Edge {pick.checks.edge ?? '—'}  ·  GKR {pick.checks.gkr ?? '—'}</Text>
        {pick.submittedBy && <Text style={styles.faint}>Submitted by {pick.submittedBy}</Text>}
      </View>)}
    </ScrollView>
  </SafeAreaView>;
}

const app = (platform: string) => ({ prizepicks: 'PrizePicks', underdog: 'Underdog', pick6: 'Pick6', dabble: 'Dabble', draftkings: 'DraftKings',
  hardrock: 'Hard Rock', pinnacle: 'Pinnacle', kalshi: 'Kalshi' } as Record<string, string>)[platform] ?? platform;
const propText = (tip: MyTip) => tip.market === 'PLAYER_PROP' ? `${tip.side === 'UNDER' ? 'Under' : 'Over'} ${tip.line ?? ''} ${tip.stat ?? ''}`.trim()
  : tip.market.replace(/_/g, ' ').toLowerCase();

function MineRow({ tip }: { tip: MyTip }) {
  const suggestion = tip.approval?.approved ? null : tip.suggestion;
  const badge = tip.status !== 'PENDING' ? tip.status : tip.approval?.approved ? 'PLAY' : suggestion ? 'BETTER LINE' : '';
  const color = tip.status !== 'PENDING' ? statusColor(tip.status) : tip.approval?.approved ? colors.mint : colors.gold;
  return <View style={styles.mineRow}>
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={styles.mineName}>{tip.selection}</Text>
      <Text style={styles.faint}>{propText(tip)}</Text>
      {tip.approval?.approved && <Text style={styles.approved}>Approved by {tip.approval.approvedBy.join(' + ')}</Text>}
      {suggestion && <Text style={styles.suggest}>Try instead: {suggestion.side === 'MORE' ? 'Over' : 'Under'} {suggestion.line}
        {suggestion.lineType !== 'REGULAR' ? ` (${suggestion.lineType.toLowerCase()})` : ''} on {app(suggestion.platform)} · {Math.round(suggestion.chance * 100)}% (needs {Math.round(suggestion.breakEven * 100)}%)</Text>}
    </View>
    {tip.analyzing ? <ActivityIndicator color={colors.mint} /> : <Text style={[styles.badge, { color }]}>{badge}</Text>}
  </View>;
}

const hit = (record: VettedRecord) => record.won + record.lost ? `${Math.round(record.won / (record.won + record.lost) * 100)}%` : '–';
const units = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}u`;

function ScoreboardCard({ board }: { board: Scoreboard }) {
  const sports = Object.entries(board.bySport).sort((a, b) => (b[1].won + b[1].lost) - (a[1].won + a[1].lost)).slice(0, 6);
  return <View style={styles.board}>
    <View style={styles.row}><Text style={styles.boardTitle}>LIVE SCOREBOARD</Text>
      {board.live > 0 && <Text style={styles.liveBadge}>● {board.live} LIVE</Text>}</View>
    <View style={styles.statsRow}>
      <Stat label="Record" value={`${board.allTime.won}–${board.allTime.lost}${board.allTime.push ? `–${board.allTime.push}` : ''}`} />
      <Stat label="Hit rate" value={hit(board.allTime)} />
      <Stat label="Units" value={units(board.allTime.units)} good={board.allTime.units >= 0} />
      <Stat label="Streak" value={board.streak ? `${board.streak.kind}${board.streak.length}` : '–'} good={board.streak?.kind !== 'L'} />
    </View>
    <Text style={styles.muted}>Last 7 days: {board.last7.won}–{board.last7.lost} · {hit(board.last7)} · {units(board.last7.units)}
      {board.pending ? `  ·  ${board.pending} upcoming` : ''}</Text>
    {sports.length > 1 && <Text style={styles.muted}>{sports.map(([sport, record]) => `${sport} ${record.won}–${record.lost}`).join('  ·  ')}</Text>}
    <Text style={styles.faint}>One unit per play at the listed price. Updated {new Date(board.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.</Text>
  </View>;
}

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <View style={styles.stat}><Text style={[styles.statValue, good === false && { color: colors.red }]}>{value}</Text>
    <Text style={styles.statLabel}>{label}</Text></View>;
}

// The chance from whoever approved it: the AI's when it said PLAY, else GKR's or Edge's (with the break-even they used).
const chanceText = (pick: VettedPick) => {
  const model = pick.approvedBy?.includes('AI') ? null : pick.checks?.gkrChance ?? pick.checks?.edgeChance ?? null;
  const chance = model ?? pick.chance;
  return `${Math.round(chance * 100)}% to hit${model !== null && pick.checks?.breakEven ? ` (needs ${Math.round(pick.checks.breakEven * 100)}%)` : ''}`;
};

// GKR's and Edge's own read on the pick (player props on a CrownIQ board).
const agrees = (verdict: string | null) => verdict === 'PLAY' || verdict === 'LEAN';
const checkLine = (checks: { edge: string | null; gkr: string | null }) =>
  [checks.gkr ? `GKR ${agrees(checks.gkr) ? '✓' : '✗'}` : null, checks.edge ? `Edge ${agrees(checks.edge) ? '✓' : '✗'}` : null]
    .filter(Boolean).join('  ·  ') + (agrees(checks.gkr) && agrees(checks.edge) ? '  ·  Confirmed by both' : '');

function PickCard({ pick }: { pick: VettedPick }) {
  const time = when(pick);
  return <View style={styles.card}>
    <View style={styles.row}>
      <Text style={styles.league}>{pick.league ?? pick.sport ?? ''}</Text>
      <Text style={[styles.badge, { color: pick.live ? colors.gold : statusColor(pick.status) }]}>
        {pick.live ? '● LIVE' : pick.status === 'PENDING' ? 'PLAY' : pick.status}</Text>
    </View>
    <Text style={styles.selection}>{pick.selection}</Text>
    <Text style={styles.market}>{marketText(pick)}{pick.opponent ? ` · vs ${pick.opponent}` : ''}</Text>
    {(pick.event || time) && <Text style={styles.muted}>{[pick.event, time].filter(Boolean).join(' · ')}</Text>}
    {pick.approvedBy?.length ? <Text style={styles.approved}>Approved by {pick.approvedBy.join(' + ')}</Text> : null}
    <Text style={styles.numbers}>{chanceText(pick)}{pick.price !== null ? ` · ${odds(pick.price)}` : ''}
      {pick.ev !== null && pick.approvedBy?.includes('AI') ? ` · EV ${pick.ev >= 0 ? '+' : ''}${(pick.ev * 100).toFixed(1)}%` : ''}</Text>
    {pick.checks && <Text style={styles.checks}>{checkLine(pick.checks)}</Text>}
    {pick.submittedBy && <Text style={styles.faint}>Submitted by {pick.submittedBy}</Text>}
    {pick.reasons?.slice(0, 2).map((reason) => <Text key={reason} style={styles.reason}>• {reason}</Text>)}
  </View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  board: { gap: 8, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.mint, backgroundColor: colors.surface },
  boardTitle: { color: colors.mint, fontSize: 12, fontWeight: '900', letterSpacing: 1.5 },
  liveBadge: { color: colors.gold, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { color: colors.text, fontSize: 20, fontWeight: '900' },
  statLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  faint: { color: colors.textFaint, fontSize: 11 },
  checks: { color: colors.mint, fontSize: 12, fontWeight: '800' },
  approved: { color: colors.gold, fontSize: 12, fontWeight: '900', letterSpacing: .5 },
  suggest: { color: colors.mint, fontSize: 12, fontWeight: '700', lineHeight: 17 },
  hiddenCard: { opacity: .7, borderStyle: 'dashed' },
  submit: { gap: 8, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  button: { minHeight: 46, borderRadius: 999, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  buttonOff: { opacity: .45 },
  buttonText: { color: colors.mintInk, fontSize: 15, fontWeight: '900' },
  mineRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border },
  mineName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  section: { color: colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 1.5, marginTop: 8 },
  muted: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  card: { gap: 4, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  league: { color: colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  badge: { fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  selection: { color: colors.text, fontSize: 17, fontWeight: '800' },
  market: { color: colors.text, fontSize: 14 },
  numbers: { color: colors.mint, fontSize: 13, fontWeight: '700', marginTop: 2 },
  reason: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
});
