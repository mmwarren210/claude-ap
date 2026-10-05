import { dayLabel } from '../../game-days';
import { ChipRow, FilterChip } from './Controls';

/** Pick the game day a generator builds from: each day with games, or all of them. */
export function DayPicker({ days, day, nowMs, onChange }: { days: readonly string[]; day: string | null; nowMs: number;
  onChange: (next: string) => void }) {
  if (!days.length) return null;
  return <ChipRow>
    {days.map((key) => <FilterChip key={key} label={dayLabel(key, nowMs)} active={day === key} chevron={false} onPress={() => onChange(key)} />)}
    {days.length > 1 && <FilterChip label="All days" active={day === null} chevron={false} onPress={() => onChange('ALL')} />}
  </ChipRow>;
}
