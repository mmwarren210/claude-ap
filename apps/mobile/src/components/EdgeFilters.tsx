import { StyleSheet, View } from 'react-native';
import { marketLabel } from '../edge-format';
import { MultiPick } from './ui/MultiPick';
import type { PickOption } from './ui/MultiPick';

/** The sport and stat pickers: tap several to combine them (e.g. NFL + CFB, Pass Yds + Rush TDs). */
export function EdgeFilters({ sports, markets, onSports, onMarkets, sportOptions, marketOptions }: { sports: string[]; markets: string[];
  onSports: (next: string[]) => void; onMarkets: (next: string[]) => void; sportOptions: PickOption[]; marketOptions: PickOption[] }) {
  return <View style={styles.filters}>
    {(sportOptions.length > 1 || !!sports.length) && <MultiPick label="SPORT" allLabel="All sports" options={sportOptions} selected={sports}
      onChange={onSports} />}
    {(marketOptions.length > 1 || !!markets.length) && <MultiPick label="STAT" allLabel="All stats" labelFor={marketLabel} options={marketOptions} selected={markets} onChange={onMarkets} />}
  </View>;
}

const styles = StyleSheet.create({ filters: { gap: 10 } });
