import type { Analysis, PlayableDirection } from '@crowniq/contracts';
import { realNews } from './ai-picks.js';
import type { AiRead } from './ai-picks.js';

// GKR Beta (owner approved 2026-10-05): GKR's score with Scout's research folded in, as its own model version that
// lifetime members can choose; everyone else keeps GKR. It is graded in its own record before it could replace GKR.
//
// - Late news: when Scout finds the player out, scratched, benched or out of the lineup, Beta passes the line. Safety
//   only: news never makes Beta play a line GKR passes.
// - Agreement: when both ChatGPT and Claude land on a side and their reasons include matchup, role or injury news, Beta
//   moves GKR's score toward them by up to 8 points (up when they back GKR's side, down when they oppose it). Recent form
//   and history alone move nothing: GKR already measures those from game logs.
// - Hard gates stay GKR's: Beta never turns a GKR pass into a play.

export const BETA_VERSION_SUFFIX = '+SCOUT-BETA-0.1';
export const BETA_MAX_SHIFT = 8;

const OUT = /\b(ruled out|out for (the )?(game|season|tonight)|will not play|won'?t play|not expected to play|inactive|scratched|benched|healthy scratch|did not travel|placed on (ir|injured reserve)|left out of the (starting|lineup)|leaves? \w+ out of the start|not in the starting (lineup|xi|five)|out of the starting (lineup|xi)|(isn'?t|is not) starting|won'?t start|will not start|dnp)\b/i;

export interface BetaRead {
  readonly direction: PlayableDirection | 'PASS';
  /** Beta's score, or null when it passes. */
  readonly score: number | null;
  /** GKR's own score and side, for the card. */
  readonly gkr: { readonly direction: PlayableDirection; readonly score: number };
  readonly change: 'SAME' | 'UP' | 'DOWN' | 'LATE_NEWS_PASS';
  /** Scout has read this line (otherwise Beta is GKR, waiting on Scout). */
  readonly scouted: boolean;
  readonly shift: number;
  /** In plain words, what moved the score. */
  readonly why: string;
  readonly modelVersion: string;
}

/** The late news that took the player out, if Scout found any. */
export function outNews(read: AiRead): string | null {
  for (const provider of read.providers) {
    const news = realNews(provider.lateNews ?? '');
    if (news && OUT.test(news)) return news;
    for (const reason of provider.reasons) if ((reason.kind === 'injury_news' || reason.kind === 'role') && OUT.test(reason.text))
      return reason.text;
  }
  return null;
}

/** GKR Beta for one line GKR scored, from Scout's read on the same line (null read: Beta equals GKR). */
export function betaFor(analysis: Analysis, read: AiRead | null): BetaRead | null {
  if (analysis.direction === 'PASS' || analysis.score === null || !analysis.modelVersion) return null;
  const gkr = { direction: analysis.direction, score: analysis.score };
  const modelVersion = `${analysis.modelVersion}${BETA_VERSION_SUFFIX}`;
  const same: BetaRead = { direction: gkr.direction, score: Math.round(gkr.score * 100) / 100, gkr, change: 'SAME', shift: 0,
    scouted: !!read,
    why: read ? 'Scout’s research didn’t move this one.' : 'No Scout read yet: same as GKR.', modelVersion };
  if (!read) return same;
  const news = outNews(read);
  if (news) return { direction: 'PASS', score: null, gkr, change: 'LATE_NEWS_PASS', shift: 0, scouted: true,
    why: `Late news: ${news}`, modelVersion };
  if (read.agreement !== 'BOTH' || read.pick === 'PASS' || read.score === null) return same;
  const strong = read.providers.some((provider) => provider.reasons.some((reason) =>
    reason.kind === 'matchup' || reason.kind === 'role' || reason.kind === 'injury_news'));
  if (!strong) return { ...same, why: 'Scout agrees on form and history only, which GKR already counts.' };
  // 55 (barely a side) moves 1 point; 75 or more moves the full 8.
  const size = Math.min(BETA_MAX_SHIFT, Math.max(1, Math.round((read.score - 55) * BETA_MAX_SHIFT / 20)));
  const shift = read.pick === gkr.direction ? size : -size;
  const score = Math.max(0, Math.min(100, Math.round((gkr.score + shift) * 100) / 100));
  return { direction: gkr.direction, score, gkr, change: shift > 0 ? 'UP' : 'DOWN', shift, scouted: true, modelVersion,
    why: shift > 0 ? `ChatGPT and Claude both back ${gkr.direction} (${read.score}) on matchup or role.`
      : `ChatGPT and Claude both lean ${read.pick} (${read.score}) on matchup or role, against GKR’s ${gkr.direction}.` };
}
