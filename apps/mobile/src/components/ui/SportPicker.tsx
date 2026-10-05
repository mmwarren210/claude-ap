import { ChipRow, FilterChip } from './Controls';

/** Pick one or more sports for a generator; none picked means every sport. */
export function SportPicker({ options, selected, onChange }: { options: readonly string[]; selected: readonly string[];
  onChange: (next: string[]) => void }) {
  if (options.length < 2) return null;
  const toggle = (sport: string) => onChange(selected.includes(sport) ? selected.filter((item) => item !== sport) : [...selected, sport]);
  return <ChipRow>
    <FilterChip label="All sports" active={!selected.length} chevron={false} onPress={() => onChange([])} />
    {options.map((sport) => <FilterChip key={sport} label={sport} active={selected.includes(sport)} chevron={false}
      onPress={() => toggle(sport)} />)}
  </ChipRow>;
}

/** Whether a sport passes the picker (none picked passes everything). */
export const inSports = (selected: readonly string[], sport: string) => !selected.length || selected.includes(sport);
