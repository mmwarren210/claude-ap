import type { PropLine, ScoreBand } from '@crowniq/contracts';

type LineType = PropLine['lineType'];

/** CrownIQ design tokens: near-black green surfaces, mint actions, line-style accents. */
export const colors = {
  background: '#050908',
  surface: '#0A110F',
  surfaceRaised: '#0E1714',
  surfaceSunken: '#070D0B',
  border: '#1A2823',
  borderStrong: '#26392F',
  text: '#F2F6F4',
  textMuted: '#8E9D96',
  textFaint: '#5F6E67',
  mint: '#3DF29C',
  mintDeep: '#22C97A',
  mintInk: '#03140B',
  mintWash: '#0E2A1D',
  neon: '#45E27F',
  gold: '#F3C54E',
  goldWash: '#2A220C',
  magenta: '#E24DF2',
  magentaWash: '#2A0E2E',
  goblin: '#6BE26F',
  goblinWash: '#12280F',
  blue: '#3C8DFF',
  orange: '#FF7B31',
  red: '#FF5B61',
  redWash: '#2E1012',
  amber: '#F2B84B',
} as const;

/** Kept for screens not yet moved to the new components. */
export const palette = {
  background: colors.background, card: colors.surface, border: colors.border, green: colors.mint,
  greenDim: colors.mintWash, text: colors.text, muted: colors.textMuted, danger: colors.red,
};

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;

export const type = {
  display: { fontSize: 30, fontWeight: '900' as const, letterSpacing: -0.6 },
  title: { fontSize: 20, fontWeight: '800' as const, letterSpacing: -0.2 },
  heading: { fontSize: 17, fontWeight: '800' as const },
  body: { fontSize: 14, fontWeight: '500' as const },
  small: { fontSize: 12, fontWeight: '500' as const },
  label: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 0.6 },
  stat: { fontSize: 17, fontWeight: '800' as const },
  hero: { fontSize: 30, fontWeight: '900' as const, letterSpacing: -0.4 },
};

export type LineStyle = 'KINGS' | 'GOBLIN' | 'DEMON' | 'UNKNOWN';

/** PrizePicks line types under CrownIQ's names: Regular lines are King's Lines. */
export function lineStyleOf(lineType: LineType): LineStyle {
  return lineType === 'REGULAR' ? 'KINGS' : lineType === 'GOBLIN' ? 'GOBLIN' :
    lineType === 'DEMON' ? 'DEMON' : 'UNKNOWN';
}

export const lineStyles: Readonly<Record<LineStyle, { label: string; short: string; color: string;
  wash: string; icon: 'crown' | 'emoticon-cool' | 'emoticon-devil' | 'help-circle-outline';
  hint: string }>> = {
  KINGS: { label: "King's Line", short: "King's", color: colors.gold, wash: colors.goldWash, icon: 'crown',
    hint: 'Best balance' },
  GOBLIN: { label: 'Goblin Line', short: 'Goblin', color: colors.goblin, wash: colors.goblinWash,
    icon: 'emoticon-cool', hint: 'Higher hit rate' },
  DEMON: { label: 'Demon Line', short: 'Demon', color: colors.magenta, wash: colors.magentaWash,
    icon: 'emoticon-devil', hint: 'Higher payouts' },
  UNKNOWN: { label: 'Unclassified', short: 'Unclassified', color: colors.textMuted, wash: colors.surfaceRaised,
    icon: 'help-circle-outline', hint: 'Line type unknown' },
};

/** Card accent per rank, echoing the mockups' colored card edges. */
export const rankAccents = [colors.mint, colors.magenta, colors.blue, colors.orange, colors.mint,
  colors.gold] as const;

export function bandLabel(band: ScoreBand | null | undefined): string {
  switch (band) {
    case 'CROWN_ELITE': return 'ELITE';
    case 'CROWN_STRONG': return 'STRONG';
    case 'PLAYABLE': return 'PLAYABLE';
    case 'LEAN': return 'LEAN';
    case 'WEAK': return 'WEAK';
    default: return 'PASS';
  }
}

export function bandColor(band: ScoreBand | null | undefined): string {
  switch (band) {
    case 'CROWN_ELITE': return colors.mint;
    case 'CROWN_STRONG': return colors.neon;
    case 'PLAYABLE': return colors.goblin;
    case 'LEAN': return colors.amber;
    case 'WEAK': return colors.orange;
    default: return colors.textFaint;
  }
}
