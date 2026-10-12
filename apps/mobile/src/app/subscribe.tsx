import { router } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';
import { Text } from '../components/Text';
import { Screen } from '../components/Screen';
import { SubscribePanel } from '../components/Subscribe';
import { colors } from '../theme';

export default function SubscribeScreen() {
  return <Screen eyebrow="CROWNIQ  /  PLANS" title="Subscribe">
    <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>← Back</Text></Pressable>
    <SubscribePanel />
  </Screen>;
}

const styles = StyleSheet.create({ back: { color: colors.mint, fontWeight: '700', marginBottom: 6 } });
