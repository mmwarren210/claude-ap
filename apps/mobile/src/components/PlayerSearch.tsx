import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { palette } from '../theme';

/** Player search box for the Edge and GKR+ tabs; hands the text on after a short pause in typing. */
export function PlayerSearch({ onSearch }: { onSearch: (text: string) => void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => onSearch(text), 400);
    return () => clearTimeout(timer);
  }, [text, onSearch]);
  return <View style={styles.row}>
    <TextInput value={text} onChangeText={setText} placeholder="Search a player" placeholderTextColor={palette.muted}
      autoCorrect={false} autoCapitalize="words" returnKeyType="search" style={styles.input} accessibilityLabel="Search a player" />
    {!!text && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setText('')}>
      <Text style={styles.clear}>Clear</Text></Pressable>}
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { flex: 1, borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9,
    color: palette.text, fontSize: 14, backgroundColor: palette.card },
  clear: { color: palette.green, fontSize: 13, fontWeight: '800' },
});
