import type { Analysis, EdgePick } from '@crowniq/contracts';

// GKR 4 (owner, 2026-10-15: "add all and make a shadow GKR 4 and track results"). GKR 3's blend plus five more reads: where
// the sportsbooks lean at the same number, recent form against the line, the opponent, the player's role (usage, teammates
// out, his own injury tag) and the other apps' numbers. Its weights are learned per sport from its own graded picks, and its
// chance is checked against how often each chance band actually hit. Shadow only: recorded and graded, never shown or scored.

export const GKR4_VERSION = 'gkr4-shadow-v1';
/** GKR 4 plays a line when its raw blended chance on GKR 2's side is at least this. */
export const GKR4_MIN_CHANCE = 0.55;
/** Graded picks a sport needs before its own weights are learned (the pooled weights are used below that). */
export const LEARN_MIN = 60;
/** Graded picks needed before the chance bands are corrected. */
export const CALIBRATE_MIN = 40;

export const GKR4_PARTS = ['gkr2', 'edge', 'history', 'script', 'books', 'form', 'opponent', 'role', 'apps'] as const;
export type Gkr4Part = typeof GKR4_PARTS[number];
export type Gkr4Parts = Partial<Record<Gkr4Part, number>>;
export type Gkr4Weights = Record<Gkr4Part, number>;
export interface Gkr4Band { readonly low: number; readonly high: number; readonly graded: number; readonly hitRate: number }
export interface Gkr4Learned {
  /** Weights per sport, and ALL for the pooled weights. */
  readonly weights: Readonly<Record<string, Gkr4Weights>>;
  readonly bands: readonly Gkr4Band[];
  readonly graded: number;
}
export interface Gkr4Read { readonly side: 'MORE' | 'LESS'; readonly raw: number; readonly chance: number; readonly strength: number;
  readonly parts: Gkr4Parts; readonly reasons: string[] }

export const DEFAULT_WEIGHTS: Gkr4Weights = { gkr2: 1, edge: 1, history: .4, script: .5, books: .8, form: .4, opponent: .4, role: .4, apps: .3 };

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (p: number, low: number, high: number) => Math.min(high, Math.max(low, p));
const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Average support (−1 to 1) of GKR 2's measured context factors whose names match, or null when none was measured. */
function support(gkr2: Analysis, names: RegExp): number | null {
  const found = (gkr2.contextBreakdown ?? []).filter((item) => item.measured && names.test(item.name) && item.weight);
  if (!found.length) return null;
  return clamp(found.reduce((sum, item) => sum + item.contribution / Math.abs(item.weight!), 0) / found.length, -1, 1);
}

/**
 * Each read GKR 4 blends, as a chance on GKR 2's side. `edge` may be another app's read of the same player and stat (its
 * own number); then `history` and the PrizePicks-only reads drop out.
 */
export function gkr4Parts(gkr2: Analysis | undefined, edge: EdgePick | undefined, script: 'MORE' | 'LESS' | null = null,
  elsewhere: { threshold: number; probability: number; side: 'MORE' | 'LESS' } | null = null):
  { side: 'MORE' | 'LESS'; parts: Gkr4Parts; reasons: string[] } | null {
  if (!gkr2 || gkr2.direction === 'PASS' || gkr2.score === null) return null;
  const side = gkr2.direction as 'MORE' | 'LESS', sign = side === 'MORE' ? 1 : -1;
  const parts: Gkr4Parts = { gkr2: clamp(gkr2.score / 100, .5, .95) };
  const reasons = [`GKR 2: ${side} ${Math.round(gkr2.score)}.`];
  if (elsewhere) {
    parts.edge = clamp(elsewhere.side === side ? elsewhere.probability : 1 - elsewhere.probability, .02, .98);
    reasons.push(`Edge at this app's ${elsewhere.threshold}: ${pct(parts.edge)} on ${side}.`);
  } else if (edge) {
    parts.edge = clamp(edge.side === side ? edge.probability : edge.oppositeProbability, .02, .98);
    reasons.push(`Edge: ${pct(parts.edge)} on ${side}.`);
  }
  if (script) { parts.script = script === side ? .75 : .45; reasons.push(`Game script ${script === side ? 'backs' : 'opposes'} ${side}.`); }
  const threshold = elsewhere?.threshold ?? edge?.threshold;
  if (edge && threshold !== undefined) {
    const stats = edge.sources.stats, sd = edge.projection.sd;
    if (!elsewhere && stats?.hitRateAtLine != null && stats.samples >= 5) {
      const onSide = edge.side === side ? stats.hitRateAtLine : 1 - stats.hitRateAtLine, hits = Math.round(onSide * stats.samples);
      parts.history = (hits + 1) / (stats.samples + 2);
      reasons.push(`History: ${hits} of ${stats.samples} at ${edge.threshold} on ${side}.`);
    }
    // 3. Sportsbooks at the same number: their average no-vig chance on this side.
    const books = (edge.sources.market?.books ?? []).filter((book) => book.point === threshold);
    if (books.length) {
      const over = books.reduce((sum, book) => sum + book.fairOver, 0) / books.length;
      parts.books = clamp(side === 'MORE' ? over : 1 - over, .05, .95);
      reasons.push(`${books.length} sportsbook${books.length > 1 ? 's' : ''} at ${threshold}: ${pct(parts.books)} on ${side}.`);
    }
    // 6. Recent form against the line, in standard deviations.
    if (stats && sd > 0 && stats.samples >= 3) {
      const z = sign * (stats.recentMean - threshold) / sd;
      parts.form = clamp(sigmoid(.8 * z), .3, .7);
      reasons.push(`Recent form: averaging ${Math.round(stats.recentMean * 10) / 10} against ${threshold}.`);
    }
    // 7. The other apps' numbers: a higher number elsewhere favors MORE here, a lower one LESS.
    const anchors = elsewhere ? null : edge.sources.anchors;
    if (anchors && anchors.thresholds.length && sd > 0) {
      parts.apps = clamp(.5 + .25 * Math.tanh(sign * (anchors.mean - threshold) / sd), .35, .65);
      reasons.push(`Other apps: average number ${Math.round(anchors.mean * 10) / 10}.`);
    }
  }
  // 5. Opponent, and 4. role: usage, teammates in or out, and the player's own injury tag.
  const opponent = support(gkr2, /opponent|matchup|defen|pace|environment|pitcher/);
  if (opponent !== null) { parts.opponent = .5 + .15 * opponent; reasons.push(`Opponent ${opponent >= 0 ? 'helps' : 'hurts'} ${side}.`); }
  const role = support(gkr2, /usage|role|teammate|lineup|minutes|snap|opportunit|injur/);
  let roleChance = role === null ? null : .5 + .15 * role;
  if (edge?.injury) { roleChance = (roleChance ?? .5) + (side === 'MORE' ? -.08 : .04); reasons.push(`Injury tag: ${edge.injury}.`); }
  if (roleChance !== null) { parts.role = clamp(roleChance, .3, .7); if (role !== null) reasons.push(`Role ${role >= 0 ? 'helps' : 'hurts'} ${side}.`); }
  return { side, parts, reasons };
}

/** The blend: a weighted average of the reads as log-odds. History counts more with more games. */
export function blend(parts: Gkr4Parts, weights: Gkr4Weights): number {
  let sum = 0, total = 0;
  for (const part of GKR4_PARTS) {
    const p = parts[part];
    if (p === undefined) continue;
    const weight = Math.max(0, weights[part]);
    sum += logit(clamp(p, .02, .98)) * weight; total += weight;
  }
  return total ? sigmoid(sum / total) : .5;
}

/** A chance corrected by the bands' graded hit rates (only once enough picks are graded). */
export function calibrate(raw: number, learned: Gkr4Learned | null): number {
  if (!learned || learned.graded < CALIBRATE_MIN) return raw;
  const band = learned.bands.find((item) => raw >= item.low && raw < item.high);
  return band ? band.hitRate : raw;
}

/** GKR 4 on one line, or null when GKR 2 passes or the raw blend falls under GKR4_MIN_CHANCE. */
export function gkr4Read(input: ReturnType<typeof gkr4Parts>, sport: string, learned: Gkr4Learned | null): Gkr4Read | null {
  if (!input) return null;
  const weights = learned?.weights[sport] ?? learned?.weights.ALL ?? DEFAULT_WEIGHTS;
  const raw = Math.round(blend(input.parts, weights) * 1e4) / 1e4;
  if (raw < GKR4_MIN_CHANCE) return null;
  const chance = Math.round(calibrate(raw, learned) * 1e4) / 1e4;
  return { side: input.side, raw, chance, strength: Math.round(chance * 100), parts: input.parts, reasons: input.reasons };
}

/** Weights that best fit graded picks (log loss, pulled toward the defaults so a small sample can't run away). */
function fit(rows: readonly { parts: Gkr4Parts; hit: boolean }[]): Gkr4Weights {
  const weights = { ...DEFAULT_WEIGHTS };
  const loss = (w: Gkr4Weights) => rows.reduce((sum, row) => {
    const p = clamp(blend(row.parts, w), 1e-4, 1 - 1e-4);
    return sum - (row.hit ? Math.log(p) : Math.log(1 - p));
  }, 0) / rows.length + .02 * GKR4_PARTS.reduce((sum, part) => sum + (w[part] - DEFAULT_WEIGHTS[part]) ** 2, 0);
  const step = .2, h = 1e-3;
  for (let round = 0; round < 150; round++) for (const part of GKR4_PARTS) {
    if (!rows.some((row) => row.parts[part] !== undefined)) continue;
    const up = { ...weights, [part]: weights[part] + h }, down = { ...weights, [part]: Math.max(0, weights[part] - h) };
    const slope = (loss(up) - loss(down)) / (up[part] - down[part] || h);
    weights[part] = clamp(weights[part] - step * slope, 0, 4);
  }
  for (const part of GKR4_PARTS) weights[part] = Math.round(weights[part] * 1000) / 1000;
  return weights;
}

/** Hit rate per chance band, shrunk toward the band's middle and kept in order (a higher band never reads lower). */
function bands(rows: readonly { raw: number; hit: boolean }[]): Gkr4Band[] {
  const edges = [0, .6, .65, .7, .75, .8, .85, .9, 1.01];
  const out = edges.slice(0, -1).map((low, index) => {
    const high = edges[index + 1]!, inside = rows.filter((row) => row.raw >= low && row.raw < high);
    const middle = low === 0 ? .57 : Math.min(.97, (low + high) / 2), wins = inside.filter((row) => row.hit).length;
    return { low, high, graded: inside.length, hitRate: (wins + 10 * middle) / (inside.length + 10) };
  });
  // Pool adjacent bands that run backwards.
  for (let index = 1; index < out.length; index++) if (out[index]!.hitRate < out[index - 1]!.hitRate) {
    const a = out[index - 1]!, b = out[index]!, pooled = (a.hitRate * (a.graded + 10) + b.hitRate * (b.graded + 10)) / (a.graded + b.graded + 20);
    out[index - 1] = { ...a, hitRate: pooled }; out[index] = { ...b, hitRate: pooled };
    index = Math.max(0, index - 2);
  }
  return out.map((band) => ({ ...band, hitRate: Math.round(band.hitRate * 1000) / 1000 }));
}

/** 1 and 2: learns weights per sport (and pooled) and the chance bands from GKR 4's own graded picks. */
export function learnGkr4(rows: readonly { sport: string; parts: Gkr4Parts; raw: number; hit: boolean }[]): Gkr4Learned {
  const weights: Record<string, Gkr4Weights> = { ALL: rows.length >= LEARN_MIN ? fit(rows) : { ...DEFAULT_WEIGHTS } };
  for (const sport of new Set(rows.map((row) => row.sport))) {
    const mine = rows.filter((row) => row.sport === sport);
    if (mine.length >= LEARN_MIN) weights[sport] = fit(mine);
  }
  return { weights, bands: bands(rows), graded: rows.length };
}
