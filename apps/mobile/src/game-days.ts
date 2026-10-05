// Game days for the generators' date picker (owner, 2026-10-05: picks were coming from games four days out). Days are
// the phone's local calendar days. Pure, so tests can load it.

const pad = (value: number) => String(value).padStart(2, '0');

/** The local calendar day of a time, as YYYY-MM-DD. */
export function dayKey(time: string | number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The days with games still to start, soonest first. */
export function gameDays(starts: readonly string[], nowMs: number): string[] {
  return [...new Set(starts.filter((start) => Date.parse(start) > nowMs).map(dayKey))].sort();
}

/** "Today", "Tomorrow", or the weekday and date ("Thu Oct 9"). */
export function dayLabel(key: string, nowMs: number): string {
  const today = dayKey(nowMs), tomorrow = dayKey(new Date(nowMs).setDate(new Date(nowMs).getDate() + 1));
  if (key === today) return 'Today';
  if (key === tomorrow) return 'Tomorrow';
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * The day a generator builds from: the one the user picked ('ALL' for every day), else today when it has games, else
 * the soonest day that does. Null means every day.
 */
export function chosenDay(picked: string | null, days: readonly string[], nowMs: number): string | null {
  if (picked === 'ALL') return null;
  if (picked && days.includes(picked)) return picked;
  const today = dayKey(nowMs);
  return days.includes(today) ? today : days[0] ?? null;
}

/** Whether a game start falls on the chosen day (null passes every day). */
export const onDay = (day: string | null, start: string) => day === null || dayKey(start) === day;
