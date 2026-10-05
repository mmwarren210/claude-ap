import { StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';
import { lateNews, scoutVerdict, verdictText } from '../use-ai-picks';
import type { AiRead } from '../use-ai-picks';
import { Icon } from './ui/Icon';

const tones = { AGREES: colors.mint, DISAGREES: colors.red, NO_EDGE: colors.textMuted } as const;
const icons = { AGREES: 'check-circle-outline', DISAGREES: 'alert-circle-outline', NO_EDGE: 'minus-circle-outline' } as const;

/**
 * Scout's second opinion on a GKR pick, and any late news Scout found. Display only: the GKR score is unchanged.
 * Renders nothing when there is no second opinion and no news.
 */
export function ScoutVerdict({ read, gkrDirection }: { read: AiRead | undefined; gkrDirection: string | undefined }) {
  const verdict = scoutVerdict(read, gkrDirection), news = lateNews(read);
  if (!verdict && !news) return null;
  return <View style={styles.wrap}>
    {verdict && <View style={[styles.chip, { borderColor: tones[verdict] }]}
      accessibilityLabel={`${verdictText[verdict]}${read?.score ? `, ${read.score}` : ''}`}>
      <Icon name={icons[verdict]} size={15} color={tones[verdict]} />
      <Text style={[styles.chipText, { color: tones[verdict] }]}>{verdictText[verdict]}
        {verdict !== 'NO_EDGE' && read?.score ? ` · ${read.score}` : ''}</Text>
    </View>}
    {news && <View style={styles.news}><Icon name="alert-outline" size={15} color={colors.amber} />
      <Text style={styles.newsText} numberOfLines={3}>Late news: {news}</Text></View>}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 6, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', borderWidth: 1, borderRadius: radius.sm,
    paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontSize: 12, fontWeight: '800' },
  news: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  newsText: { flex: 1, color: colors.amber, fontSize: 12, lineHeight: 16, fontWeight: '600' },
});
