import type { ScoreBand } from '@crowniq/contracts';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { bandColor, bandLabel, colors } from '../../theme';

/** GKR score dial: the arc fills to the score out of 100, colored by score band. */
export function ScoreRing({ score, band, size = 72 }: { score: number | null; band: ScoreBand | null | undefined;
  size?: number }) {
  const stroke = Math.max(4, Math.round(size / 13));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const filled = score === null ? 0 : Math.max(0, Math.min(1, score / 100)) * circumference;
  const color = bandColor(band);
  return <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    accessibilityLabel={score === null ? 'No score, PASS' : `GKR score ${Math.round(score)}, ${bandLabel(band)}`}>
    <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.border} strokeWidth={stroke} fill="none" />
      {filled > 0 && <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
        strokeDasharray={`${filled} ${circumference}`} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
    </Svg>
    <Text style={[styles.score, { fontSize: size * 0.34 }]}>{score === null ? '—' : Math.round(score)}</Text>
    <Text style={[styles.band, { color, fontSize: Math.max(8, size * 0.13) }]}>
      {size < 64 && bandLabel(band) === 'PLAYABLE' ? 'PLAY' : bandLabel(band)}</Text>
  </View>;
}

const styles = StyleSheet.create({
  score: { color: colors.text, fontWeight: '900', marginTop: -2, fontVariant: ['tabular-nums'] },
  band: { fontWeight: '800', letterSpacing: 0.4, marginTop: -2 },
});
