import type { Analysis } from '@crowniq/contracts';

// GKR 2 beside GKR on a pick (owner, 2026-10-13: "show both scores and why they are different, 2 with a beta tag"). GKR 2 is
// still calibrating, so the app labels it Beta and says, in plain words, why the two reads differ when they do.

/** One model's read on a line, as the app shows it. */
export interface ModelRead { readonly direction: 'MORE' | 'LESS' | 'PASS'; readonly score: number | null }
/** GKR 2's read on a line, with the plain-words reason it differs from GKR (null when they agree). */
export interface Gkr2Read extends ModelRead { readonly why: string | null }

const words = (name: string) => name.replace(/_/g, ' ');
const sideWord = (side: 'MORE' | 'LESS') => side === 'MORE' ? 'More' : 'Less';
const measured = (analysis: Analysis | undefined) =>
  new Set((analysis?.contextBreakdown ?? []).filter((item) => item.measured).map((item) => item.name));
const played = (analysis: Analysis | undefined): analysis is Analysis & { direction: 'MORE' | 'LESS'; score: number } =>
  !!analysis && analysis.direction !== 'PASS' && analysis.score !== null;

/** Scores this close are the same read. */
export const SAME_READ = 5;

/** The factors GKR 2 measured that GKR didn't, as words ("opponent, game script"), or null. */
function extra(gkr: Analysis | undefined, gkr2: Analysis): string | null {
  const had = measured(gkr), added = [...measured(gkr2)].filter((name) => !had.has(name)).slice(0, 3).map(words);
  return added.length ? added.join(', ') : null;
}

/** Why GKR 2's read on a line differs from GKR's, in plain words; null when they agree. */
export function whyDifferent(gkr: Analysis | undefined, gkr2: Analysis): string | null {
  const more = extra(gkr, gkr2);
  const source = `GKR 2 reads the player's PropLine box scores${more ? ` and also weighs ${more}` : ''}`;
  if (!played(gkr2)) return played(gkr) ? `GKR 2 passes: ${source}, and it doesn't find enough there to play this line.` : null;
  if (!played(gkr)) return `GKR passes on this line; ${source}, and that is enough for it to play ${sideWord(gkr2.direction)}.`;
  if (gkr.direction !== gkr2.direction) return `They take opposite sides: ${source}, and that points ${sideWord(gkr2.direction)}.`;
  const gap = Math.round(gkr2.score - gkr.score);
  if (Math.abs(gap) < SAME_READ) return null;
  return `Same side, GKR 2 is ${Math.abs(gap)} points ${gap > 0 ? 'higher' : 'lower'}: ${source}.`;
}

/** GKR 2's reads on a board's lines: every line it plays, plus lines GKR plays that GKR 2 passes on (to say so). */
export function gkr2Reads(gkr: ReadonlyMap<string, Analysis>, gkr2: readonly Analysis[]): Record<string, Gkr2Read> {
  const out: Record<string, Gkr2Read> = {};
  for (const analysis of gkr2) {
    const base = gkr.get(analysis.lineId);
    if (!played(analysis) && !played(base)) continue;
    out[analysis.lineId] = { direction: played(analysis) ? analysis.direction : 'PASS', score: played(analysis) ? analysis.score : null,
      why: whyDifferent(base, analysis) };
  }
  return out;
}
