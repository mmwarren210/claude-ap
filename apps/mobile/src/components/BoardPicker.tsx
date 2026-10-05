import { View } from 'react-native';
import type { PickApp } from '../port';
import { ChipRow, FilterChip, Segmented } from './ui/Controls';

export type Sportsbook = 'draftkings' | 'hardrock';
export type MarketPlatform = 'kalshi';
/** Every board the Board tab can show: a pick'em app, a sportsbook or a prediction market. */
export type BoardSource = PickApp | Sportsbook | MarketPlatform | 'shop';

export const pickApps: readonly { value: PickApp; label: string }[] = [
  { value: 'prizepicks', label: 'PrizePicks' }, { value: 'underdog', label: 'Underdog' }, { value: 'pick6', label: 'DK Pick’em' }];
export const sourceNames: Readonly<Record<Sportsbook | MarketPlatform, string>> = { draftkings: 'DraftKings',
  hardrock: 'Hard Rock', kalshi: 'Kalshi' };
const others: readonly (Sportsbook | MarketPlatform)[] = ['draftkings', 'hardrock', 'kalshi'];

/** The pick'em apps on top, then the sportsbooks and prediction markets as chips. */
export function BoardPicker({ value, onChange }: { value: BoardSource; onChange: (source: BoardSource) => void }) {
  return <View style={{ gap: 8 }}>
    <Segmented label="Pick'em app" options={pickApps} value={value as PickApp} onChange={onChange} />
    <ChipRow><FilterChip label="Line shop" active={value === 'shop'} chevron={false} icon="tag-multiple-outline"
      onPress={() => onChange('shop')} />{others.map((source) => <FilterChip key={source} label={sourceNames[source]} active={value === source} chevron={false}
      icon={source === 'kalshi' ? 'chart-line' : 'bank-outline'}
      onPress={() => onChange(source)} />)}</ChipRow>
  </View>;
}
