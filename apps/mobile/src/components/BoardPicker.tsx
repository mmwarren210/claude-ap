import { View } from 'react-native';
import type { PickApp } from '../port';
import { ChipRow, FilterChip, Segmented } from './ui/Controls';

export type Sportsbook = 'draftkings' | 'hardrock';
export type MarketPlatform = 'kalshi' | 'polymarket';
/** Every board the Board tab can show: a pick'em app, a sportsbook or a prediction market. */
export type BoardSource = PickApp | Sportsbook | MarketPlatform;

export const pickApps: readonly { value: PickApp; label: string }[] = [
  { value: 'prizepicks', label: 'PrizePicks' }, { value: 'underdog', label: 'Underdog' }, { value: 'pick6', label: 'Pick6' }];
export const sourceNames: Readonly<Record<Sportsbook | MarketPlatform, string>> = { draftkings: 'DraftKings',
  hardrock: 'Hard Rock', kalshi: 'Kalshi', polymarket: 'Polymarket' };
const others: readonly (Sportsbook | MarketPlatform)[] = ['draftkings', 'hardrock', 'kalshi', 'polymarket'];

/** The pick'em apps on top, then the sportsbooks and prediction markets as chips. */
export function BoardPicker({ value, onChange }: { value: BoardSource; onChange: (source: BoardSource) => void }) {
  return <View style={{ gap: 8 }}>
    <Segmented label="Pick'em app" options={pickApps} value={value as PickApp} onChange={onChange} />
    <ChipRow>{others.map((source) => <FilterChip key={source} label={sourceNames[source]} active={value === source}
      icon={source === 'kalshi' || source === 'polymarket' ? 'chart-line' : 'bank-outline'}
      onPress={() => onChange(source)} />)}</ChipRow>
  </View>;
}
