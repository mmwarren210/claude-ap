import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../../theme';

/** A slim label under a tab's header naming the model behind the screen (owner, 2026-10-11), with a link to the guide. */
export function ModelBanner({ title, text }: { title: string; text: string }) {
  return <View style={styles.banner} accessibilityRole="header">
    <Text style={styles.title}>{title}</Text>
    <Text style={styles.text}>{text}{' '}
      <Text style={styles.link} accessibilityRole="link" onPress={() => router.push('/guide')}>How it works</Text></Text>
  </View>;
}


const styles = StyleSheet.create({
  banner: { gap: 3, paddingVertical: 10, paddingHorizontal: 12, borderLeftWidth: 3, borderLeftColor: colors.mint,
    borderRadius: radius.md, backgroundColor: colors.surface },
  title: { color: colors.mint, fontSize: 13, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' },
  text: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  link: { color: colors.text, fontWeight: '700', textDecorationLine: 'underline' },
});
