import { StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../../theme';
import type { BookView } from '../../use-books';
import { alpha } from './color';
import { Icon } from './Icon';

const names: Readonly<Record<string, string>> = { draftkings: 'DraftKings', hardrock: 'Hard Rock', pinnacle: 'Pinnacle', kalshi: 'Kalshi' };

/**
 * Whether the sportsbooks back the same side as GKR at this exact number: "Books agree" or "Books lean …", with their
 * no-vig chance. For information only; it does not change the GKR score.
 */
export function BooksBadge({ view, side }: { view: BookView | undefined; side: 'MORE' | 'LESS' | null }) {
  if (!view || !side) return null;
  const chance = side === 'MORE' ? view.fairMore : 1 - view.fairMore;
  const agree = chance >= 0.5;
  const shown = agree ? chance : 1 - chance;
  const label = agree ? 'Books agree' : `Books lean ${side === 'MORE' ? 'LESS' : 'MORE'}`;
  const tone = agree ? colors.gold : colors.textMuted;
  return <View style={[styles.badge, { borderColor: alpha(tone, 0.5) }]}
    accessibilityLabel={`${label}, ${Math.round(shown * 100)} percent fair chance`}>
    <Icon name={agree ? 'scale-balance' : 'scale-unbalanced'} size={15} color={tone} />
    <Text style={[styles.text, { color: tone }]}>{label} · {(shown * 100).toFixed(0)}%</Text>
    <Text style={styles.books} numberOfLines={1}>{view.books.map((book) => names[book.book] ?? book.book).join(' · ')}</Text>
  </View>;
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderWidth: 1,
    borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, marginTop: 8 },
  text: { fontSize: 12.5, fontWeight: '800' },
  books: { color: colors.textMuted, fontSize: 12, flexShrink: 1 },
});
