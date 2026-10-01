import type { FantasyRuleSet } from './registry.js';

export interface JointFantasyScenario {
  readonly probability: number;
  readonly stats: Readonly<Record<string, number>>;
}

/** One joint outcome is scored once; HR and TD consequences belong in that same stat line. */
export function scoreFantasyStats(ruleSet: FantasyRuleSet,
  stats: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [stat, count] of Object.entries(stats)) {
    if (!Object.hasOwn(ruleSet.points, stat) || !Number.isFinite(count) || count < 0) {
      throw new Error('INVALID_FANTASY_STAT:' + stat);
    }
    total += ruleSet.points[stat] * count;
  }
  return Math.round(total * 1000) / 1000;
}

export function fantasyDistribution(ruleSet: FantasyRuleSet,
  scenarios: readonly JointFantasyScenario[]) {
  if (!scenarios.length || scenarios.some((s) => !Number.isFinite(s.probability) ||
    s.probability < 0) || Math.abs(scenarios.reduce((sum, s) => sum + s.probability, 0) - 1) > 1e-6) {
    throw new Error('INVALID_FANTASY_SCENARIOS');
  }
  const outcomes = scenarios.map((scenario) => ({
    probability: scenario.probability, points: scoreFantasyStats(ruleSet, scenario.stats),
  }));
  const midpoint = outcomes.reduce((sum, outcome) => sum + outcome.probability * outcome.points, 0);
  const variance = outcomes.reduce((sum, outcome) =>
    sum + outcome.probability * (outcome.points - midpoint) ** 2, 0);
  return { midpoint, standardDeviation: Math.sqrt(variance), outcomes };
}
