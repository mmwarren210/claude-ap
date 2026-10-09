import { View } from 'react-native';
import type { PickApp } from '../port';
import { ChipRow, FilterChip, Segmented } from './ui/Controls';

export type Sportsbook = 'draftkings' | 'hardrock';
/** Every board the Board tab can show: a pick'em app, a sportsbook or a prediction market. */
export type BoardSource = PickApp | Sportsbook | 'shop';

export const pickApps: readonly { value: PickApp; label: string }[] = [
  { value: 'prizepicks', label: 'PrizePicks' }, { value: 'underdog', label: 'Underdog' }, { value: 'pick6', label: 'Pick6' }];
export const sourceNames: Readonly<Record<Sportsbook, string>> = { draftkings: 'DraftKings',
  hardrock: 'Hard Rock' };
const others: readonly Sportsbook[] = ['draftkings', 'hardrock'];

/** The pick'em apps on top, then the sportsbooks and prediction markets as chips. */
export function BoardPicker({ value, onChange }: { value: BoardSource; onChange: (source: BoardSource) => void }) {
  return <View style={{ gap: 8 }}>
    <Segmented label="Pick'em app" options={pickApps} value={value as PickApp} onChange={onChange} />
    <ChipRow><FilterChip label="Line shop" active={value === 'shop'} chevron={false} icon="tag-multiple-outline"
      onPress={() => onChange('shop')} />{others.map((source) => <FilterChip key={source} label={sourceNames[source]} active={value === source} chevron={false}
      icon="bank-outline"
      onPress={() => onChange(source)} />)}</ChipRow>
  </View>;
}
