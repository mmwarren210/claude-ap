import { useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import { colors } from '../../theme';

export type UnitsPoint = { label: string; value: number };

/** Cumulative units by day, with a zero line and the final total marked. */
export function UnitsChart({ points }: { points: readonly UnitsPoint[] }) {
  const [width, setWidth] = useState(320);
  const onLayout = (event: LayoutChangeEvent) => setWidth(Math.max(240, event.nativeEvent.layout.width));
  const height = 170, left = 34, right = 14, top = 14, bottom = 26;
  const values = points.map((point) => point.value);
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const pad = span * 0.12;
  const min = lo - pad, max = hi + pad;
  const plotW = width - left - right, plotH = height - top - bottom;
  const x = (index: number) => left + (points.length > 1 ? index * plotW / (points.length - 1) : plotW / 2);
  const y = (value: number) => top + (max - value) / (max - min) * plotH;
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(index)},${y(point.value)}`).join(' ');
  const area = points.length ? `${path} L${x(points.length - 1)},${y(min)} L${x(0)},${y(min)} Z` : '';
  const ticks = [max - pad, (max + min) / 2, min + pad].map((tick) => Math.round(tick * 10) / 10);
  const every = Math.ceil(points.length / 7);
  return <View onLayout={onLayout} accessibilityLabel={`Cumulative units ending at ${values.at(-1) ?? 0}`}>
    <Svg width={width} height={height}>
      <Defs><LinearGradient id="units" x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor={colors.mint} stopOpacity="0.35" /><Stop offset="1" stopColor={colors.mint} stopOpacity="0" />
      </LinearGradient></Defs>
      {ticks.map((tick) => [
        <Line key={`g${tick}`} x1={left} x2={left + plotW} y1={y(tick)} y2={y(tick)} stroke={colors.border} strokeWidth={1} />,
        <SvgText key={`t${tick}`} x={left - 6} y={y(tick) + 4} fontSize="10.5" fill={colors.textMuted} textAnchor="end">
          {tick > 0 ? `+${tick}` : tick}</SvgText>])}
      <Line x1={left} x2={left + plotW} y1={y(0)} y2={y(0)} stroke={colors.borderStrong} strokeWidth={1} strokeDasharray="4 4" />
      {points.length > 1 && <Path d={area} fill="url(#units)" />}
      {points.length > 1 && <Path d={path} stroke={colors.mint} strokeWidth={2.5} fill="none" />}
      {points.map((point, index) => <Circle key={index} cx={x(index)} cy={y(point.value)} r={index === points.length - 1 ? 5 : 3.5}
        fill={point.value < 0 ? colors.red : colors.mint} />)}
      {points.map((point, index) => index % every === 0 || index === points.length - 1
        ? <SvgText key={`l${index}`} x={x(index)} y={height - 6} fontSize="10.5" fill={colors.textMuted} textAnchor="middle">
          {point.label}</SvgText> : null)}
    </Svg>
  </View>;
}
