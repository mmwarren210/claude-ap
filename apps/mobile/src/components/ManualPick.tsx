import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';
import { useAuth } from '../auth';
import { formatLine, marketLabel } from '../edge-format';
import { colors, radius } from '../theme';

// Add a pick by hand (owner, 2026-10-12): no screenshot and no AI. Search a player, choose one of their real board lines and
// tap More or Less; GKR and Edge check that exact line right away, and a PLAY joins Vetted with your name on it.

type BoardLine = { platform: string; lineId: string; playerName: string; sport: string; league: string | null; team: string | null;
  market: string; line: number; lineType: string; start: string; eventName: string };

const APPS: Record<string, string> = { prizepicks: 'PrizePicks', underdog: 'Underdog', pick6: 'Pick6', dabble: 'Dabble',
  draftkings: 'DraftKings', hardrock: 'Hard Rock', pinnacle: 'Pinnacle', kalshi: 'Kalshi' };
const TYPES: Record<string, string> = { GOBLIN: 'Goblin', DEMON: 'Demon' };
const time = (start: string) => new Date(start).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function ManualPick({ onAdded }: { onAdded: () => void }) {
  const { request } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Results with the search they answer, so a cleared or changed name never shows old lines.
  const [found, setFound] = useState<{ query: string; lines: BoardLine[] } | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const wanted = query.trim();
    if (wanted.length < 2) return;
    let active = true;
    const timer = setTimeout(() => {
      void request(`/v1/tips/lines?q=${encodeURIComponent(wanted)}`).then(async (response) => {
        if (!active) return;
        setFound({ query: wanted, lines: response.ok ? (await response.json() as { lines: BoardLine[] }).lines : [] });
        if (!response.ok) setMessage(response.status === 503 ? 'The boards are still loading. Try again in a minute.' : 'Could not search right now.');
      }).catch(() => { if (active) { setFound({ query: wanted, lines: [] }); setMessage('Could not search. Check your connection.'); } });
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [query, request]);
  const wanted = query.trim();
  const lines = wanted.length >= 2 && found?.query === wanted ? found.lines : null;
  const searching = wanted.length >= 2 && found?.query !== wanted;
  const add = async (line: BoardLine, side: 'MORE' | 'LESS') => {
    setSending(`${line.lineId}:${side}`); setMessage('');
    try {
      const response = await request('/v1/tips/manual', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: line.platform, lineId: line.lineId, side }) });
      const body = await response.json().catch(() => ({})) as { approved?: boolean; approvedBy?: string[]; limit?: number };
      const pick = `${line.playerName} ${side === 'MORE' ? 'More' : 'Less'} ${formatLine(line.line)} ${marketLabel(line.market)}`;
      if (response.ok) {
        setMessage(body.approved ? `✓ ${pick}: approved by ${(body.approvedBy ?? []).join(' + ')}. It’s on Vetted with your name.`
          : `${pick}: GKR and Edge didn’t back this one, so it’s not listed.`);
        onAdded();
      } else setMessage(response.status === 429 ? `You’ve added ${body.limit ?? 20} picks today. More tomorrow.`
        : response.status === 409 ? 'That game already started.' : response.status === 404 ? 'That line is gone. Search again for the current one.'
        : 'Could not add that pick. Try again.');
    } catch { setMessage('Could not add. Check your connection.'); }
    finally { setSending(null); }
  };
  if (!open) return <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={styles.toggle}>
    <Text style={styles.toggleText}>Or add a pick by hand →</Text></Pressable>;
  return <View style={styles.box}>
    <Text style={styles.title}>ADD A PICK BY HAND</Text>
    <Text style={styles.muted}>Type a player, then tap More or Less on the line. GKR and Edge check it right away.</Text>
    <TextInput value={query} onChangeText={(text) => { setQuery(text); setMessage(''); }} placeholder="Player name" autoCorrect={false}
      autoCapitalize="words" placeholderTextColor={colors.textFaint} style={styles.input} />
    {searching && <ActivityIndicator color={colors.mint} />}
    {!!message && <Text style={styles.message}>{message}</Text>}
    {lines && !searching && !lines.length && <Text style={styles.muted}>No upcoming lines for that name.</Text>}
    {lines?.map((line) => <View key={`${line.platform}:${line.lineId}`} style={styles.row}>
      <View style={styles.grow}>
        <Text style={styles.name}>{line.playerName}</Text>
        <Text style={styles.detail}>{formatLine(line.line)} {marketLabel(line.market)}{TYPES[line.lineType] ? ` · ${TYPES[line.lineType]}` : ''}</Text>
        <Text style={styles.faint}>{APPS[line.platform] ?? line.platform} · {line.league ?? line.sport} · {time(line.start)}</Text>
      </View>
      {(['MORE', 'LESS'] as const).filter((side) => side === 'MORE' || !TYPES[line.lineType]).map((side) => {
        const key = `${line.lineId}:${side}`;
        return <Pressable key={side} accessibilityRole="button" disabled={!!sending} onPress={() => void add(line, side)}
          style={[styles.side, !!sending && sending !== key && styles.off]}>
          {sending === key ? <ActivityIndicator color={colors.mint} /> : <Text style={styles.sideText}>{side === 'MORE' ? 'More' : 'Less'}</Text>}
        </Pressable>; })}
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  toggle: { alignSelf: 'flex-start', paddingVertical: 6 },
  toggleText: { color: colors.mint, fontSize: 14, fontWeight: '800' },
  box: { gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  title: { color: colors.mint, fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  muted: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  message: { color: colors.text, fontSize: 13, lineHeight: 18 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, color: colors.text, fontSize: 15, paddingHorizontal: 12, paddingVertical: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  grow: { flex: 1, gap: 1 },
  name: { color: colors.text, fontSize: 14, fontWeight: '800' },
  detail: { color: colors.text, fontSize: 13 },
  faint: { color: colors.textFaint, fontSize: 11.5 },
  side: { minWidth: 58, alignItems: 'center', borderWidth: 1, borderColor: colors.mint, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8 },
  sideText: { color: colors.mint, fontSize: 13, fontWeight: '800' },
  off: { opacity: .4 },
});
