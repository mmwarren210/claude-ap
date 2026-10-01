import type { Analysis } from '@crowniq/contracts';

type Component = NonNullable<Analysis['contextBreakdown']>[number];

/** Plain names for the factors CrownIQ measures today, plus the exact-line adjustments. */
const labels: Readonly<Record<string, string>> = {
  // NFL
  expected_attempts: 'Pass attempts', efficiency_environment: 'Yards per attempt',
  historical_current_form: 'Recent passing yards', expected_offensive_plays: 'Offensive plays',
  pass_rate: 'Pass rate', qb_role_security: 'QB snap share', historical_volume: 'Recent volume',
  attempts: 'Pass attempts', completion_rate: 'Completion rate', passing_style: 'Yards per attempt',
  expected_carries: 'Carries', rush_attempt_rate: 'Carries per snap', rb_efficiency_skill: 'Yards per carry',
  historical_rush_volume: 'Recent rushing yards', offensive_snap_volume: 'Offensive snaps',
  target_opportunity_rate: 'Targets per snap', receiving_efficiency: 'Yards per target',
  historical_receiving_volume: 'Recent receiving yards', target_floor: 'Targets', catch_rate: 'Catch rate',
  historical_reception_volume: 'Recent receptions', historical_target_volume: 'Recent targets',
  coverage_matchup: 'Coverage matchup', matchup_coverage: 'Coverage matchup', qb_environment: 'QB quality',
  qb_completion_environment: 'QB completion rate', protection_pressure: 'Pass protection', game_script: 'Game script',
  personnel: 'Personnel', opponent_rush_defense: 'Opponent run defense',
  // NBA
  expected_minutes: 'Minutes', minutes: 'Minutes', shot_volume: 'Shot attempts', usage_proxy: 'Usage rate',
  scoring_rate: 'Points per minute', rebound_rate: 'Rebounds per minute', historical_rebound_volume: 'Recent rebounds',
  potential_assists: 'Potential assists', ball_handling_rate: 'Ball handling per minute',
  historical_assist_volume: 'Recent assists', scoring_opportunity: 'Recent points', rebounding_opportunity: 'Recent rebounds',
  assist_opportunity: 'Recent assists', points_opportunity: 'Recent points', matchup: 'Matchup', pace: 'Pace',
  opponent_defense: 'Opponent defense', opponent_shot_profile: 'Opponent shot profile',
  team_rebounding_environment: 'Team rebounding',
  // MLB
  expected_pa: 'Plate appearances', contact_obp_skill: 'On-base rate', home_run_rate: 'Home run rate',
  historical_hrrbi_volume: 'Recent hits + runs + RBIs', run_creation_rate: 'Run production per PA',
  contact_ability: 'Batting average', historical_hit_volume: 'Recent hits', hit_rate: 'Hits per PA',
  hitter_walk_rate: 'Walk rate', historical_walk_volume: 'Recent walks', extra_base_power_rate: 'Extra-base hit rate',
  historical_hr_volume: 'Recent home runs', hr_frequency: 'Home runs per PA', expected_batters_faced: 'Batters faced',
  pitch_count_innings: 'Innings pitched', pitcher_k_rate: 'Strikeout rate', opponent_k_rate: 'Opponent strikeout rate',
  pitcher_matchup: 'Pitcher matchup',
  // Shared
  stability: 'Consistency', evidence_quality: 'Evidence quality',
  // Adjustments applied to the exact line
  partial_coverage_adjustment: 'Scaled for unmeasured factors', context_score_clamp: 'Context limit',
  threshold_cushion: 'Room between projection and line', variance: 'Outcome spread', evidence: 'Evidence quality',
  demon_tax: 'Demon difficulty', high_variance_market: 'High-variance market', blowout: 'Blowout risk',
  adversarial_risk: 'Open risks', score_clamp: 'Score limit',
};

const acronyms: Readonly<Record<string, string>> = { qb: 'QB', rb: 'RB', ft: 'FT', hr: 'HR', pa: 'PA', hs: 'HS',
  ol: 'OL', df: 'DF', adot: 'aDOT', h2h: 'H2H', obp: 'OBP', k: 'K', hrrbi: 'H+R+RBI' };

/** Readable label for any score component key. */
export function factorLabel(key: string): string {
  if (labels[key]) return labels[key];
  const words = key.split('_').filter(Boolean).map((word) => acronyms[word] ?? word);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const lineAdjustmentNames = new Set(['threshold_cushion', 'variance', 'evidence', 'demon_tax',
  'high_variance_market', 'blowout', 'adversarial_risk', 'score_clamp']);

export type BreakdownRow = { key: string; label: string; value: string; measured: boolean; contribution: number;
  weight: number | null; detail: string | null };

const round1 = (value: number) => Math.round(value * 10) / 10;
const pretty = (value: number) => Math.abs(value) >= 10 ? round1(value).toFixed(1)
  : Math.abs(value) >= 1 ? round1(value).toFixed(1) : value.toFixed(2);

/** Turns one score component into a readable row without changing its numbers. */
export function describeComponent(component: Component): BreakdownRow {
  const weight = /weight (\d+(?:\.\d+)?)/.exec(component.explanation);
  const observed = /Observed (-?[\d.]+) versus reference (-?[\d.]+)/.exec(component.explanation);
  const missing = /No current attributed metric/.test(component.explanation);
  let detail: string | null = null;
  if (observed) {
    const [value, reference] = [Number(observed[1]), Number(observed[2])];
    const change = reference ? (value - reference) / Math.abs(reference) : null;
    detail = `Last 5 avg ${pretty(value)} vs last 10 avg ${pretty(reference)}` +
      (change === null ? '' : ` (${change >= 0 ? '+' : ''}${Math.round(change * 100)}%)`);
  } else if (component.name === 'partial_coverage_adjustment') {
    detail = 'Measured factors scaled up to cover the ones without data';
  } else if (!missing && !weight) {
    detail = component.explanation.replace(/(\d+\.\d{3,})/g, (match) => pretty(Number(match)));
  }
  const contribution = round1(component.contribution);
  const signedValue = `${contribution > 0 ? '+' : ''}${contribution.toFixed(1)}`;
  return { key: component.name, label: factorLabel(component.name), measured: !missing,
    value: missing ? 'Not measured' : weight ? `${signedValue} of ${weight[1]}` : signedValue,
    contribution, weight: weight ? Number(weight[1]) : null, detail };
}

/** Context rows and exact-line adjustment rows that add up to the GKR score. */
export function scoreBreakdown(analysis: Analysis): { context: BreakdownRow[]; adjustments: BreakdownRow[];
  contextTotal: number; adjustmentTotal: number } {
  const parts = analysis.scoreBreakdown.length ? analysis.scoreBreakdown
    : [...(analysis.contextBreakdown ?? []), ...(analysis.lineAdjustments ?? [])];
  const rows = parts.map(describeComponent);
  const context = rows.filter((row) => !lineAdjustmentNames.has(row.key));
  const adjustments = rows.filter((row) => lineAdjustmentNames.has(row.key) && row.contribution !== 0);
  const sum = (items: BreakdownRow[]) => round1(items.reduce((total, row) => total + row.contribution, 0));
  return { context, adjustments, contextTotal: sum(context), adjustmentTotal: sum(adjustments) };
}
