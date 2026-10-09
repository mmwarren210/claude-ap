import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';
import { Sheet } from './Sheet';
import { PrimaryButton } from './ui/Controls';
import { Icon } from './ui/Icon';
import { MultiPick, toggleChoice } from './ui/MultiPick';
import type { PickOption } from './ui/MultiPick';

/** What the member picked: several of each; an empty list means all. */
export type FilterValue = { platforms: string[]; sports: string[]; games: string[]; stats: string[] };
export const emptyFilter: FilterValue = { platforms: [], sports: [], games: [], stats: [] };
export type GameOption = { key: string; name: string; sport: string; startTime: string; count?: number };

const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** One line saying what the filter shows ("NFL · 2 games · Pass Yds"). */
export function filterSummary(value: FilterValue, names: { platform?: (key: string) => string; stat?: (key: string) => string;
  game?: (key: string) => string } = {}): string {
  const list = (keys: string[], noun: string, name?: (key: string) => string) => !keys.length ? null
    : keys.length <= 2 ? keys.map((key) => name ? name(key) : key).join(' + ') : `${keys.length} ${noun}`;
  return [list(value.platforms, 'platforms', names.platform), list(value.sports, 'sports'),
    value.games.length === 1 && names.game ? names.game(value.games[0]!) : value.games.length ? `${value.games.length} game${value.games.length === 1 ? '' : 's'}` : null,
    list(value.stats, 'stats', names.stat)].filter(Boolean).join(' · ');
}

/**
 * One filter for everything, opened from a single bar so the page stays clean. Steps narrow as you go: platform, then
 * sport, then that sport's games (teams and start time), then stats. Each step takes several picks.
 */
export function FilterBar({ value, onChange, platforms, sports, games, stats, statName = (key) => key, platformName,
  placeholder = 'Filter: all sports, games and stats' }: { placeholder?: string;
  value: FilterValue; onChange: (next: FilterValue) => void; platforms?: readonly PickOption[]; sports: readonly PickOption[];
  games: readonly GameOption[]; stats: readonly PickOption[]; statName?: (key: string) => string; platformName?: (key: string) => string }) {
  const [open, setOpen] = useState(false);
  const gameName = (key: string) => games.find((game) => game.key === key)?.name ?? 'game';
  const summary = filterSummary(value, { stat: statName, game: gameName, ...(platformName ? { platform: platformName } : {}) });
  const active = !!summary;
  // Changing sports drops picked games from sports no longer picked.
  const setSports = (next: string[]) => onChange({ ...value, sports: next, games: value.games.filter((key) => {
    const game = games.find((item) => item.key === key); return !game || !next.length || next.includes(game.sport); }) });
  const shownGames = games.filter((game) => !value.sports.length || value.sports.includes(game.sport));
  const byDay = new Map<string, GameOption[]>();
  for (const game of shownGames) byDay.set(dayOf(game.startTime), [...(byDay.get(dayOf(game.startTime)) ?? []), game]);
  return <View>
    <View style={styles.bar}>
      <Pressable accessibilityRole="button" accessibilityLabel="Filter" onPress={() => setOpen(true)} style={[styles.button, active && styles.buttonOn]}>
        <Icon name="tune-variant" size={18} color={active ? colors.mint : colors.textMuted} />
        <Text style={[styles.buttonText, active && styles.buttonTextOn]} numberOfLines={1}>{summary || placeholder}</Text>
        <Icon name="chevron-down" size={16} color={active ? colors.mint : colors.textMuted} />
      </Pressable>
      {active && <Pressable accessibilityRole="button" onPress={() => onChange(emptyFilter)} style={styles.clear}>
        <Text style={styles.clearText}>Clear</Text></Pressable>}
    </View>
    <Sheet visible={open} title="Filter" onClose={() => setOpen(false)}>
      {!!platforms && platforms.length > 1 && <MultiPick label="1 · PLATFORM" allLabel="All platforms" options={platforms}
        selected={value.platforms} onChange={(next) => onChange({ ...value, platforms: next })} />}
      {(sports.length > 1 || !!value.sports.length) && <MultiPick label={`${platforms && platforms.length > 1 ? 2 : 1} · SPORT`} allLabel="All sports"
        options={sports} selected={value.sports} onChange={setSports} />}
      {shownGames.length > 0 && <View style={styles.games}>
        <Text style={styles.label}>GAMES{value.games.length ? ` · ${value.games.length} picked` : ''}</Text>
        {!value.sports.length && shownGames.length > 12 && <Text style={styles.hint}>Pick a sport above to shorten this list.</Text>}
        <Pressable accessibilityRole="button" onPress={() => onChange({ ...value, games: [] })} style={[styles.game, !value.games.length && styles.gameOn]}>
          <Text style={[styles.gameName, !value.games.length && styles.on]}>All games</Text></Pressable>
        {[...byDay].map(([day, list]) => <View key={day} style={styles.day}>
          <Text style={styles.dayText}>{day}</Text>
          {list.map((game) => { const on = value.games.includes(game.key);
            return <Pressable key={game.key} accessibilityRole="button" accessibilityState={{ selected: on }}
              onPress={() => onChange({ ...value, games: toggleChoice(value.games, game.key) })} style={[styles.game, on && styles.gameOn]}>
              <Text style={[styles.gameName, on && styles.on]} numberOfLines={1}>{on ? '✓ ' : ''}{game.name}</Text>
              <Text style={styles.gameMeta}>{timeOf(game.startTime)}{value.sports.length === 1 ? '' : ` · ${game.sport}`}{game.count ? ` · ${game.count}` : ''}</Text>
            </Pressable>; })}
        </View>)}
      </View>}
      {(stats.length > 1 || !!value.stats.length) && <MultiPick label="STAT" allLabel="All stats" options={stats} selected={value.stats}
        labelFor={statName} onChange={(next) => onChange({ ...value, stats: next })} />}
      <PrimaryButton label="Show picks" onPress={() => setOpen(false)} />
      {active && <Pressable accessibilityRole="button" onPress={() => onChange(emptyFilter)}><Text style={styles.reset}>Reset everything</Text></Pressable>}
    </Sheet>
  </View>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  button: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    paddingHorizontal: 12, minHeight: 44, backgroundColor: colors.surfaceSunken },
  buttonOn: { borderColor: colors.mint, backgroundColor: colors.mintWash },
  buttonText: { flex: 1, color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  buttonTextOn: { color: colors.mint, fontWeight: '900' },
  clear: { padding: 10 },
  clearText: { color: colors.mint, fontSize: 13, fontWeight: '800' },
  label: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  hint: { color: colors.textFaint, fontSize: 12 },
  games: { gap: 6 },
  day: { gap: 4 },
  dayText: { color: colors.text, fontSize: 12, fontWeight: '800', marginTop: 4 },
  game: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 9, backgroundColor: colors.surfaceSunken },
  gameOn: { borderColor: colors.mint, backgroundColor: colors.mintWash },
  gameName: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '700' },
  on: { color: colors.mint, fontWeight: '900' },
  gameMeta: { color: colors.textMuted, fontSize: 12 },
  reset: { color: colors.textMuted, fontSize: 13, textAlign: 'center', padding: 8 },
});
