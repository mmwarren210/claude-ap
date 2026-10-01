import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color: string }) {
  return <MaterialCommunityIcons name={name} size={size} color={color} />;
}
