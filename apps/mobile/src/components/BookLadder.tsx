import type { PropLine } from '@crowniq/contracts';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { formatLine } from '../insights';
import { colors, radius } from '../theme';
import { sourceNames } from './BoardPicker';

type Row = { book: 'draftkings' | 'hardrock'; line: number; american: number | null; needs: number | null; fairChance: number;
  gkr: number | null; pricey: boolean; main: boolean };

const odds = (american: number | null) => american === null ? '—' : american > 0 ? `+${american}` : `−${-american}`;
const pct = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`;

/**
 * The sportsbooks' other numbers for this player and stat on GKR's side (Hard Rock posts alternate lines), each with its
 * price and GKR's score at that number. Suggests the easiest number GKR still backs at a fair price. Display only.
 */
export function BookLadder({ line }: { line: PropLine }) {
  const { request, demo } = useAuth();
  const [value, setValue] = useState<{ lineId: string; side: 'MORE' | 'LESS' | null; rows: Row[] } | null>(null);
  useEffect(() => {
    if (demo) return;
    let active = true;
    void request(`/v1/books/ladder/${encodeURIComponent(line.id)}`)
      .then((response) => response.ok ? response.json() as Promise<{ side: 'MORE' | 'LESS' | null; rows: Row[] }> : null)
      .then((body) => { if (active && body) setValue({ lineId: line.id, side: body.side, rows: body.rows ?? [] }); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [line.id, demo, request]);
  if (!value || value.lineId !== line.id || !value.side || !value.rows.length) return null;
  const { side, rows } = value;
  const word = side === 'MORE' ? 'Over' : 'Under';
  const easier = (row: Row) => side === 'MORE' ? row.line < line.threshold : row.line > line.threshold;
  // The suggestion: the easiest number GKR still backs whose price needs under 60%.
  const suggestion = rows.filter((row) => easier(row) && row.gkr !== null && !row.pricey)
    .sort((a, b) => side === 'MORE' ? a.line - b.line : b.line - a.line)[0];
  return <View style={styles.section}>
    <Text style={styles.title}>Sportsbook lines · {word}</Text>
    {suggestion ? <View style={styles.tip}>
      <Text style={styles.tipTitle}>Want it safer? Check a {side === 'MORE' ? 'lower' : 'higher'} line</Text>
      <Text style={styles.tipText}>{sourceNames[suggestion.book]} {word} {formatLine(suggestion.line)} at {odds(suggestion.american)}:
        {' '}{Math.round(Math.abs(suggestion.line - line.threshold) * 10) / 10} {side === 'MORE' ? 'below' : 'above'} PrizePicks’
        {' '}{formatLine(line.threshold)}, GKR still backs it
        ({suggestion.gkr}), and the price needs {pct(suggestion.needs)}.</Text>
    </View> : <Text style={styles.note}>No easier number with a fair price right now. Easier numbers cost more: a
      {side === 'MORE' ? ' lower' : ' higher'} line wins more often but pays less.</Text>}
    <View style={styles.table}>
      <View style={[styles.row, styles.head]}>
        <Text style={[styles.cell, styles.wide]}>Line</Text><Text style={styles.cell}>Price</Text>
        <Text style={styles.cell}>Needs</Text><Text style={styles.cell}>Book</Text><Text style={styles.cell}>GKR</Text>
      </View>
      {rows.map((row) => <View key={`${row.book}${row.line}`} style={[styles.row, row === suggestion && styles.picked]}>
        <Text style={[styles.cell, styles.wide, styles.strong]} numberOfLines={1}>
          {row.book === 'hardrock' ? 'HR' : 'DK'} {word[0]} {formatLine(row.line)}{row.line === line.threshold ? ' ·PP' : ''}
          {row.main ? ' ·main' : ''}</Text>
        <Text style={[styles.cell, row.pricey && { color: colors.gold }]}>{odds(row.american)}</Text>
        <Text style={[styles.cell, row.pricey && { color: colors.gold }]}>{pct(row.needs)}</Text>
        <Text style={styles.cell}>{pct(row.fairChance)}</Text>
        <Text style={[styles.cell, row.gkr !== null && styles.backed]}>{row.gkr ?? '—'}</Text>
      </View>)}
    </View>
    <Text style={styles.note}>“Needs” is the win rate the price requires; gold means pricey (60% or more). “Book” is the
      book’s own chance with its cut removed. GKR is scored at each number on the same research. PP marks PrizePicks’ number.</Text>
  </View>;
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  tip: { borderWidth: 1, borderColor: colors.mint, borderRadius: radius.md, backgroundColor: colors.mintWash, padding: 12, gap: 4 },
  tipTitle: { color: colors.mint, fontSize: 14, fontWeight: '800' },
  tipText: { color: colors.text, fontSize: 13, lineHeight: 19 },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  head: { borderTopWidth: 0, backgroundColor: colors.surfaceSunken },
  picked: { backgroundColor: colors.mintWash },
  cell: { flex: 1, color: colors.textMuted, fontSize: 12.5, textAlign: 'right', fontVariant: ['tabular-nums'] },
  wide: { flex: 2.2, textAlign: 'left' },
  strong: { color: colors.text, fontWeight: '700' },
  backed: { color: colors.mint, fontWeight: '800' },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
});
