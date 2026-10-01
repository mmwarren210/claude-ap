import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { palette } from '../theme';

export function Screen({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.title}>{title}</Text>
      {children}
    </ScrollView>
  </SafeAreaView>;
}

export function Notice({ title, detail }: { title: string; detail: string }) {
  return <View style={styles.notice}>
    <Text style={styles.noticeTitle}>{title}</Text>
    <Text style={styles.detail}>{detail}</Text>
  </View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  content: { padding: 22, paddingBottom: 36, gap: 16 },
  eyebrow: { color: palette.green, fontSize: 11, fontWeight: '800', letterSpacing: 2.2, marginTop: 8 },
  title: { color: palette.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.8, marginBottom: 7 },
  notice: { backgroundColor: palette.card, borderColor: palette.border, borderWidth: 1,
    borderRadius: 20, padding: 20, gap: 9 },
  noticeTitle: { color: palette.text, fontSize: 18, fontWeight: '700' },
  detail: { color: palette.muted, fontSize: 14, lineHeight: 21 },
});
