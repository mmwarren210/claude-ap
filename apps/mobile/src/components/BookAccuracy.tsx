import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '../auth';
import { colors, radius } from '../theme';

type Row = { props: number; mse: number; bias: number };
type Report = { gamesScored: number; lastRunAt: string | null; books: Record<string, Row> };

const names: Readonly<Record<string, string>> = { pinnacle: 'Pinnacle', kalshi: 'Kalshi', draftkings: 'DraftKings', fanduel: 'FanDuel',
  hardrock: 'Hard Rock', betmgm: 'BetMGM', betrivers: 'BetRivers', fanatics: 'Fanatics', novig: 'Novig', prophetx: 'ProphetX', bovada: 'Bovada' };

/**
 * Owner only: how close each book's closing line came to players' real stats, per sport (PropLine's finished games, last 30
 * days). Lower miss is better; a lean below zero means the book set lines too low. Edge weighs books by this.
 */
export function BookAccuracy() {
  const { request } = useAuth();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sport, setSport] = useState<string | null>(null);
  const load = useCallback(() => {
    void request('/v1/owner/board/book-accuracy').then(async (response) => {
      if (!response.ok) { setError('Not available right now.'); return; }
      setReport(await response.json() as Report); setError(null);
    }).catch(() => setError('Could not load the report.'));
  }, [request]);
  useFocusEffect(load);
  const rows = Object.entries(report?.books ?? {}).map(([key, row]) => { const [book, sportName] = key.split('|');
    return { book: book!, sport: sportName!, ...row }; });
  const sports = [...new Set(rows.map((row) => row.sport))].sort();
  const shown = sport ?? sports[0] ?? null;
  const list = rows.filter((row) => row.sport === shown && row.props >= 20).sort((a, b) => a.mse - b.mse);
  const best = list[0]?.mse ?? null;
  return <View style={styles.card}>
    <Text style={styles.title}>Book accuracy</Text>
    <Text style={styles.note}>How close each book’s last line before the game came to the player’s real stat (finished games,
      last 30 days). Lower miss is better. Edge trusts the most accurate books more.</Text>
    {error && <Text style={styles.note}>{error}</Text>}
    {report && <Text style={styles.small}>{report.gamesScored} games scored{report.lastRunAt ? ` · updated ${new Date(report.lastRunAt).toLocaleString()}` : ''}</Text>}
    {sports.length > 1 && <View style={styles.chips}>{sports.map((name) => <Pressable key={name} accessibilityRole="button"
      onPress={() => setSport(name)} style={[styles.chip, name === shown && styles.chipOn]}>
      <Text style={[styles.chipText, name === shown && styles.chipTextOn]}>{name}</Text></Pressable>)}</View>}
    {report && !list.length && <Text style={styles.note}>Not enough finished games yet. Each book needs 20 scored props in a sport to show here.</Text>}
    {list.length > 0 && <View style={styles.head}><Text style={[styles.cell, styles.bookCol]}>Book</Text>
      <Text style={styles.cell}>Miss</Text><Text style={styles.cell}>Lean</Text><Text style={styles.cell}>Props</Text></View>}
    {list.map((row) => <View key={row.book} style={styles.row}>
      <Text style={[styles.value, styles.bookCol]}>{row.mse === best ? '★ ' : ''}{names[row.book] ?? row.book}</Text>
      <Text style={styles.value}>{row.mse.toFixed(2)}</Text>
      <Text style={styles.value}>{row.bias > 0.05 ? `${row.bias.toFixed(2)} high` : row.bias < -0.05 ? `${(-row.bias).toFixed(2)} low` : 'even'}</Text>
      <Text style={styles.value}>{row.props}</Text>
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 14, gap: 8 },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },
  note: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  small: { color: colors.textFaint, fontSize: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5 },
  chipOn: { borderColor: colors.mint, backgroundColor: colors.mintWash },
  chipText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  chipTextOn: { color: colors.mint },
  head: { flexDirection: 'row', borderBottomWidth: 1, borderColor: colors.border, paddingBottom: 4 },
  row: { flexDirection: 'row', paddingVertical: 4 },
  cell: { flex: 1, color: colors.textMuted, fontSize: 12, fontWeight: '800' },
  value: { flex: 1, color: colors.text, fontSize: 13 },
  bookCol: { flex: 1.6 },
});
