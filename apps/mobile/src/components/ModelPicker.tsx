import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { Segmented } from './ui/Controls';
import { GKR2_WARNING, MODEL_OPTIONS } from '../gkr2';
import type { ModelChoice } from '../gkr2';
import { colors } from '../theme';

/** Which model's picks to show (GKR, GKR 2, both), with GKR 2's Beta warning whenever it's in view. */
export function ModelPicker({ value, onChange }: { value: ModelChoice; onChange: (value: ModelChoice) => void }) {
  return <View style={styles.box}>
    <Segmented label="Model" options={MODEL_OPTIONS} value={value} onChange={onChange} />
    {value !== 'GKR' && <Text accessibilityRole="alert" style={styles.warning}>⚠ {GKR2_WARNING}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  box: { gap: 6 },
  warning: { color: colors.amber, fontSize: 12, lineHeight: 17, fontWeight: '700' },
});
