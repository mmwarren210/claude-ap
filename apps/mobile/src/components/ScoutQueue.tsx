import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { SCOUT } from '../scout';
import { colors, radius } from '../theme';
import { PrimaryButton } from './ui/Controls';

// Owner only: how many lines wait on Scout, by board and sport, and Ask all or one board and sport at a time.

type Status = { queued: number; done: number; failed: number; running: boolean; waiting: number; usedToday: number;
  dailyOwner: number };
type Queue = { total: number; boards: Record<string, { total: number; sports: Record<string, number> }>; status: Status };
const boardNames: Readonly<Record<string, string>> = { prizepicks: 'PrizePicks', underdog: 'Underdog', pick6: 'DK Pick’em' };

export function ScoutQueue() {
  const { request } = useAuth();
  const [queue, setQueue] = useState<Queue | null>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const fetchQueue = useCallback(() => request('/v1/owner/scout-queue').then(async (response) => response.ok
    ? await response.json() as Queue : null).catch(() => null), [request]);
  useEffect(() => {
    let active = true;
    const load = () => void fetchQueue().then((value) => { if (active && value) setQueue(value); });
    load();
    const timer = setInterval(load, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [fetchQueue]);
  const ask = async (board: string, sport?: string) => {
    setBusy(true); setMessage('');
    const response = await request('/v1/owner/scout-queue', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sport ? { board, sport } : { board }) }).catch(() => null);
    setBusy(false);
    if (!response?.ok) { setMessage('Couldn’t queue those. Try again.'); return; }
    const body = await response.json() as { matched: number; queued: number };
    setMessage(body.queued ? `${SCOUT} is on ${body.queued} ${body.queued === 1 ? 'line' : 'lines'}, soonest games first. ` +
      'Each answer shows on the boards as it lands.' + (body.queued < body.matched ? ' The rest wait for tomorrow’s allowance.' : '')
      : 'Nothing new to queue (already read, already queued, or today’s allowance is used).');
    const value = await fetchQueue(); if (value) setQueue(value);
  };
  if (!queue) return <Text style={styles.note}>Loading…</Text>;
  const { status } = queue;
  return <View style={styles.box}>
    <Text style={styles.big}>{queue.total} {queue.total === 1 ? 'line waits' : 'lines wait'} on {SCOUT}</Text>
    <Text style={styles.note}>Lines GKR can’t score and {SCOUT} hasn’t read yet, for games that haven’t started. Answers go
      live on everyone’s board as they land.</Text>
    <Text style={styles.status}>Today: {status.usedToday} of {status.dailyOwner} asked · {status.running
      ? `working (${status.waiting} in line, ${status.done} done${status.failed ? `, ${status.failed} failed` : ''})` : 'idle'}</Text>
    <PrimaryButton label={`Ask ${SCOUT} on all (${queue.total})`} icon="binoculars" disabled={busy || !queue.total}
      onPress={() => void ask('all')} />
    {!!message && <Text style={styles.note}>{message}</Text>}
    {Object.entries(queue.boards).map(([board, entry]) => <View key={board} style={styles.board}>
      <View style={styles.rowHead}>
        <Text style={styles.boardName}>{boardNames[board] ?? board} · {entry.total}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void ask(board)} style={styles.ask}>
          <Text style={styles.askText}>Ask all</Text></Pressable>
      </View>
      {Object.entries(entry.sports).sort((a, b) => b[1] - a[1]).map(([sport, count]) => <View key={sport} style={styles.row}>
        <Text style={styles.sport}>{sport}</Text><Text style={styles.count}>{count}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void ask(board, sport)} style={styles.ask}>
          <Text style={styles.askText}>Ask</Text></Pressable>
      </View>)}
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  box: { gap: 10 },
  big: { color: colors.text, fontSize: 20, fontWeight: '900' },
  note: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  status: { color: colors.electric, fontSize: 13, fontWeight: '800' },
  board: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, padding: 12, gap: 6, backgroundColor: colors.surface },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  boardName: { color: colors.mint, fontSize: 16, fontWeight: '900' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sport: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '700' },
  count: { color: colors.textMuted, fontSize: 14, fontWeight: '800', minWidth: 40, textAlign: 'right' },
  ask: { borderWidth: 1, borderColor: colors.electric, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 5 },
  askText: { color: colors.electric, fontSize: 13, fontWeight: '800' },
});
