import { StyleSheet, View } from 'react-native';
import { Text } from './Text';

/**
 * A faint repeated watermark over every screen for trial accounts (owner, 2026-10-11): any screenshot or recording that gets
 * passed around shows which trial account it came from. It never takes touches.
 */
export function Watermark({ label }: { label: string }) {
  const rows = Array.from({ length: 14 }, (_, index) => index);
  return <View pointerEvents="none" style={styles.layer} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <View style={styles.tilt}>
      {rows.map((row) => <Text key={row} numberOfLines={1} style={[styles.text, { marginLeft: row % 2 ? -80 : 0 }]}>
        {`${label}     ${label}     ${label}     ${label}`}</Text>)}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden', zIndex: 9999 },
  tilt: { position: 'absolute', top: -200, left: -300, right: -300, bottom: -200, justifyContent: 'space-around',
    transform: [{ rotate: '-28deg' }] },
  text: { color: 'rgba(255,255,255,0.07)', fontSize: 18, fontWeight: '800', letterSpacing: 2 },
});
