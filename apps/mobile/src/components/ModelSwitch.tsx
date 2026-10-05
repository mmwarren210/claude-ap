import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { useModel } from '../use-model';
import { Segmented } from './ui/Controls';

/** GKR or GKR Beta, for lifetime members only; renders nothing for everyone else. */
export function ModelSwitch() {
  const { model, canUseBeta, setModel } = useModel();
  if (!canUseBeta) return null;
  return <View style={styles.wrap}>
    <Segmented label="Model" value={model} onChange={setModel}
      options={[{ value: 'GKR' as const, label: 'GKR' }, { value: 'BETA' as const, label: 'GKR Beta' }]} />
    {model === 'BETA' && <Text style={styles.note}>Beta: GKR plus Scout’s research (late news passes a line; matchup and role
      move the score up to 8). Being tested in its own record before it could replace GKR.</Text>}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  note: { color: colors.gold, fontSize: 12, lineHeight: 17 },
});
