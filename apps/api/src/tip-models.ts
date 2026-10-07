import type { EdgePick } from '@crowniq/contracts';
import { normalizedName } from './context/match.js';
import type { TipDraft, TipVerdict } from './tips.js';

// Edge's and GKR+'s reads on an uploaded tip (owner, 2026-10-07: the AI read passed or faded almost every pick-'em leg, because
// it priced them against sportsbook odds). A player prop tip is matched to the same player, stat and number on the boards
// (PrizePicks first), and each model's chance on the tipster's side is held against that platform's break-even.

/** One model's read on a tip: its chance on the tipster's side, the break-even it must beat, and a verdict. */
export interface TipModelRead {
  readonly platform: string; readonly market: string; readonly line: number;
  /** The model's own side on this line. */
  readonly modelSide: 'MORE' | 'LESS';
  /** The model's chance on the tipster's side (its own side's chance when the tip names no side). */
  readonly chance: number; readonly breakEven: number; readonly verdict: TipVerdict;
}

const ABBREVIATIONS: Record<string, string> = { yds: 'yards', yd: 'yards', rec: 'receptions', recs: 'receptions', pts: 'points',
  reb: 'rebounds', rebs: 'rebounds', ast: 'assists', asts: 'assists', sog: 'shots on goal', td: 'touchdowns', tds: 'touchdowns',
  ks: 'strikeouts', so: 'strikeouts', hrr: 'hits runs rbis', pra: 'points rebounds assists', '3pm': 'threes', fs: 'fantasy score',
  att: 'attempts', comp: 'completions', int: 'interceptions', ints: 'interceptions', sacks: 'sacks', blk: 'blocks', stl: 'steals' };

/** Stat words, abbreviations spelled out and cut to a 4-letter stem ("Receiving Yards" and "player_reception_yds" share two). */
function statWords(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[+&/_-]/g, ' ').split(/\s+/).filter(Boolean)
    .flatMap((word) => (ABBREVIATIONS[word] ?? word).split(' '))
    .filter((word) => !['player', 'batter', 'pitcher', 'total', 'the', 'of', 'over', 'under', 'more', 'less'].includes(word));
  return new Set(words.map((word) => word.slice(0, 4)));
}

/** The board pick for a player prop tip: same player and number, the closest stat; prefers regular lines. */
export function matchTip(tip: Pick<TipDraft, 'market' | 'selection' | 'line' | 'stat'>, picks: Iterable<EdgePick>): EdgePick | null {
  if (tip.market !== 'PLAYER_PROP' || tip.line === null) return null;
  const name = normalizedName(tip.selection), wanted = statWords(tip.stat ?? '');
  let best: { pick: EdgePick; score: number } | null = null;
  for (const pick of picks) {
    if (pick.threshold !== tip.line || normalizedName(pick.playerName) !== name) continue;
    const have = statWords(pick.market);
    const shared = [...wanted].filter((word) => have.has(word)).length;
    // Every stat word has to be accounted for, so "Rush + Rec Yards" doesn't match plain receiving yards.
    const score = wanted.size ? shared / Math.max(wanted.size, have.size) : 0;
    if (wanted.size && shared < wanted.size) continue;
    const ranked = score + (pick.lineType === 'REGULAR' ? .01 : 0);
    if (!best || ranked > best.score) best = { pick, score: ranked };
  }
  return best?.pick ?? null;
}

/** A model's read from its pick on the matched line. */
export function modelRead(tip: Pick<TipDraft, 'side'>, pick: EdgePick, platform: string): TipModelRead {
  const tipSide = tip.side === 'OVER' ? 'MORE' : tip.side === 'UNDER' ? 'LESS' : null;
  const chance = !tipSide || tipSide === pick.side ? pick.probability : pick.oppositeProbability;
  const margin = chance - pick.breakEven;
  const verdict: TipVerdict = !tipSide ? (margin >= .03 ? 'PLAY' : margin >= 0 ? 'LEAN' : 'PASS')
    : margin >= .03 ? 'PLAY' : margin >= 0 ? 'LEAN' : margin > -.05 ? 'PASS' : 'FADE';
  return { platform, market: pick.market, line: pick.threshold, modelSide: pick.side,
    chance: Math.round(chance * 1000) / 1000, breakEven: pick.breakEven, verdict };
}
