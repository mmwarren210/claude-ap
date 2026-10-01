import { useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, Line, LinearGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';
import type { GameResult } from '../../insights';
import { formatLine } from '../../insights';
import { colors } from '../../theme';

const niceStep = (max: number) => {
  const raw = max / 4, power = 10 ** Math.floor(Math.log10(raw)), unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
};

/** Recent games as bars (oldest left) against a dashed line at the threshold. */
export function GameBars({ games, threshold }: { games: readonly GameResult[]; threshold: number }) {
  const [width, setWidth] = useState(320);
  const onLayout = (event: LayoutChangeEvent) => setWidth(Math.max(240, event.nativeEvent.layout.width));
  const ordered = [...games].reverse();
  const height = 210, left = 30, right = 48, top = 22, bottom = 48;
  const plotW = width - left - right, plotH = height - top - bottom;
  const peak = Math.max(threshold, ...ordered.map((game) => game.value), 1);
  const step = niceStep(peak * 1.1);
  const max = Math.ceil((peak * 1.1) / step) * step;
  const y = (value: number) => top + plotH - (value / max) * plotH;
  const slot = ordered.length ? plotW / ordered.length : plotW;
  const barW = Math.min(46, slot * 0.66);
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step);
  if (!ordered.length) return <View style={styles.empty}><Text style={styles.emptyText}>
    No logged games for this market yet.</Text></View>;
  return <View onLayout={onLayout} accessibilityLabel={`Last ${ordered.length} games against the ${threshold} line`}>
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id="hit" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors.mint} stopOpacity="1" /><Stop offset="1" stopColor={colors.mintDeep} stopOpacity="0.55" />
        </LinearGradient>
        <LinearGradient id="miss" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors.red} stopOpacity="0.9" /><Stop offset="1" stopColor={colors.red} stopOpacity="0.35" />
        </LinearGradient>
      </Defs>
      {ticks.map((tick) => <SvgText key={tick} x={left - 8} y={y(tick) + 4} fontSize="11" fill={colors.textMuted}
        textAnchor="end">{Number.isInteger(tick) ? tick : tick.toFixed(1)}</SvgText>)}
      {ordered.map((game, index) => {
        const x = left + index * slot + (slot - barW) / 2;
        const barTop = y(game.value);
        const date = new Date(game.date + 'T12:00:00');
        return [
          <Rect key={`b${index}`} x={x} y={barTop} width={barW} height={Math.max(2, top + plotH - barTop)} rx={4}
            fill={game.hit ? 'url(#hit)' : 'url(#miss)'} />,
          <SvgText key={`v${index}`} x={x + barW / 2} y={barTop - 6} fontSize="12" fontWeight="700"
            fill={game.hit ? colors.mint : colors.red} textAnchor="middle">{game.value}</SvgText>,
          <SvgText key={`d${index}`} x={x + barW / 2} y={top + plotH + 16} fontSize="10.5" fill={colors.text}
            textAnchor="middle">{`${date.getMonth() + 1}/${date.getDate()}`}</SvgText>,
          <SvgText key={`o${index}`} x={x + barW / 2} y={top + plotH + 31} fontSize="10" fill={colors.textMuted}
            textAnchor="middle">{game.opponent ? `vs ${game.opponent}` : ''}</SvgText>,
        ];
      })}
      <Line x1={left} x2={left + plotW} y1={y(threshold)} y2={y(threshold)} stroke={colors.text} strokeWidth={1.2}
        strokeDasharray="6 5" opacity={0.85} />
      <SvgText x={left + plotW + 6} y={y(threshold) - 1} fontSize="12" fontWeight="700" fill={colors.text}>
        {formatLine(threshold)}</SvgText>
      <SvgText x={left + plotW + 6} y={y(threshold) + 12} fontSize="9.5" fill={colors.textMuted}>LINE</SvgText>
    </Svg>
  </View>;
}

const styles = StyleSheet.create({
  empty: { height: 96, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.textMuted, fontSize: 13 },
});
