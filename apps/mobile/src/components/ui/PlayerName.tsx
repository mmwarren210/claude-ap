import type { StyleProp, TextStyle } from 'react-native';
import { Text } from '../Text';
import { colors } from '../../theme';
import { usePosition } from '../../use-positions';

/** A player's name with his position after it when known ("Josh Allen · QB"). The position is display only. */
export function PlayerName({ name, sport, style, numberOfLines }: { name: string; sport: string | null | undefined;
  style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const position = usePosition(sport, name);
  return <Text style={style} numberOfLines={numberOfLines}>{name}
    {position ? <Text style={{ color: colors.textMuted, fontWeight: '600' }}>{`  ${position}`}</Text> : null}</Text>;
}
