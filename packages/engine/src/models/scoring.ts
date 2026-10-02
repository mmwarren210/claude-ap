import type { Assessment, Evidence, PlayableDirection, PropLine } from '@crowniq/contracts';
import type { ModelContext, ModelModule } from '../interfaces.js';
import { fantasyDistribution } from '../fantasy/scoring.js';
import { fantasyRules } from '../fantasy/registry.js';
import type { MarketDefinition } from './definitions.js';
import { flipsForLess } from './less-aware.js';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round = (value: number) => Math.round(value * 100) / 100;

function current(evidence: readonly Evidence[], kind: string): Evidence | undefined {
  return evidence.filter((item) => item.kind === kind &&
    (kind.startsWith('risk:') || (item.sourceType !== 'AI_STRUCTURED' &&
      (item.sourceType !== 'PUBLIC' || item.sourceUrl !== null))))
    .sort((a, b) => Date.parse(b.retrievedAt) - Date.parse(a.retrievedAt) ||
      b.confidence - a.confidence)[0];
}

function statusFailure(definition: MarketDefinition, evidence: readonly Evidence[]): string | null {
  for (const kind of definition.hardCriticalKinds ?? definition.criticalKinds) {
    if (current(evidence, kind)?.numeric?.value !== 1) return kind;
  }
  return null;
}

function result(context: ModelContext, direction: Assessment['direction'],
  options: Partial<Assessment> & Pick<Assessment,'rationale'>): Assessment {
  return { phase: context.phase, direction, scoreComponents: [], dangerZone: false,
    ruleChecks: [], supportingFactors: [], opposingFactors: [], ...options };
}

const fantasyPlayerType: Readonly<Record<string, string>> = {
  player_fantasy_points: 'player', batter_fantasy_score: 'batter',
  pitcher_fantasy_score: 'pitcher',
};

const recommendedBySport: Readonly<Record<string, readonly string[]>> = {
  NFL: ['injury_status','offensive_line_injuries','weather','role_change'],
  NCAAFB: ['injury_status','rotation','game_script','weather'],
  MLB: ['starting_lineup','starting_pitcher','weather','park','role_change'],
  NBA: ['injury_report','starting_lineup','minutes_restriction','rotation_change'],
  WNBA: ['injury_report','starting_lineup','minutes_restriction','rotation_change'],
  TENNIS: ['ranking','surface','tournament_round','withdrawal','workload'],
  TABLE_TENNIS: ['ranking','recent_set_lengths','match_format'],
  BADMINTON: ['ranking','seeding','tournament_round','workload'],
  CS2: ['roster','substitutions','map_pool','series_format','player_role'],
  VALORANT: ['roster','substitutions','agent_role','map_pool'],
  LOL: ['roster','substitutions','champion_meta','series_format'],
  DOTA: ['roster','substitutions','hero_role','series_format'],
  APEX: ['roster','team','tournament_format','map_pool'],
  NHL: ['starting_goalie','line_assignment','injury_status','power_play_role'],
  HANDBALL: ['lineup','tournament_round','role_change'],
};

function projection(definition: MarketDefinition, line: PropLine, evidence: readonly Evidence[]) {
  if (line.market.includes('fantasy')) {
    const playerType = definition.sport === 'NFL' || definition.sport === 'NCAAFB' ? 'offense'
      : definition.sport === 'NHL' ? 'skater' : fantasyPlayerType[line.market];
    const rules = fantasyRules(definition.sport, playerType);
    const scenarios = current(evidence, 'fantasy_scenarios')?.scenarios;
    if (!rules || !scenarios) return null;
    return fantasyDistribution(rules, scenarios);
  }
  const numeric = current(evidence, 'projection:' + line.market)?.numeric;
  if (!numeric || numeric.baseline === undefined || numeric.baseline <= 0) return null;
  return { midpoint: numeric.value, standardDeviation: numeric.baseline };
}

function riskFindings(evidence: readonly Evidence[]) {
  const risks = ['injury','role_change','lineup','weather','blowout','sample_size',
    'threshold_inflation','correlation','map_uncertainty','set_uncertainty','conflicting_evidence'];
  return risks.flatMap((risk) => {
    const record = current(evidence, 'risk:' + risk);
    return record?.numeric && record.numeric.value > 0
      ? [{ risk, severity: clamp(record.numeric.value, 0, 1) }] : [];
  });
}

/** Explicit, data-dependent scoring.
 * A calibrated distribution and every critical status are hard gates. Market factors may
 * be partially available, but missing factors contribute zero and at least 60% of the
 * non-quality factor weight must be backed by attributed numeric evidence. */
export function createMarketModule(definition: MarketDefinition, approved = false): ModelModule {
  const factorEvidenceKinds = definition.factors.filter(([key]) => key !== 'evidence_quality')
    .map(([key]) => 'metric:' + key);
  const distributionKind = definition.market.includes('fantasy')
    ? 'fantasy_scenarios' : 'projection:' + definition.market;
  const requiredEvidenceKinds = [...factorEvidenceKinds, distributionKind, ...definition.criticalKinds];
  const hardRequiredEvidenceKinds = [distributionKind,
    ...(definition.hardCriticalKinds ?? definition.criticalKinds)];
  return { sport: definition.sport, market: definition.market, version: definition.version,
    requiredEvidenceKinds, hardRequiredEvidenceKinds,
    recommendedEvidenceKinds: [...new Set([
      ...factorEvidenceKinds, ...(recommendedBySport[definition.sport] ?? []),
    ])],
    calibrationApproved: approved, assess(context) {
      if (!approved) return result(context, 'PASS', {
        reasonCode: 'MODEL_CALIBRATION_UNAPPROVED',
        rationale: 'The owner has not approved this model version’s component calibration.' });
      const { line, evidence, phase } = context;
      const missing = statusFailure(definition, evidence);
      if (missing) return result(context, 'PASS', { reasonCode: 'CRITICAL_STATUS_UNCONFIRMED',
        rationale: `Critical status ${missing} was not confirmed.`, opposingFactors: [missing] });
      const distribution = projection(definition, line, evidence);
      if (!distribution || distribution.standardDeviation <= 0) {
        return result(context, 'PASS', { reasonCode: 'MISSING_DISTRIBUTION',
          rationale: 'An attributed distribution with positive spread is required.' });
      }

      const weightedFactors = definition.factors.filter(([key]) => key !== 'evidence_quality');
      const available = new Map(weightedFactors.map(([key, weight]) => [key, {
        weight, numeric: current(evidence, 'metric:' + key)?.numeric,
      }]));
      const totalFactorWeight = weightedFactors.reduce((sum, [, weight]) => sum + weight, 0);
      const attributedWeight = [...available.values()].reduce((sum, item) =>
        sum + (item.numeric?.baseline === undefined ? 0 : item.weight), 0);
      const inputCoverage = totalFactorWeight ? attributedWeight / totalFactorWeight : 1;
      const dataConfidence = round(inputCoverage * 100);
      const missingFactorKeys = [...available].filter(([, item]) => item.numeric?.baseline === undefined)
        .map(([key]) => key);
      if (inputCoverage < .6) return result(context, 'PASS', {
        reasonCode: 'INSUFFICIENT_MODEL_COVERAGE', dataConfidence,
        rationale: `Attributed numeric factors cover only ${dataConfidence}% of model weight; 60% is required.`,
        opposingFactors: missingFactorKeys.map((key) => 'Missing attributed factor ' + key),
      });

      // The side the projection points to. Market checks below can only turn a disagreement with
      // it into a PASS, so every scored line is scored from this side.
      const projectedSide: PlayableDirection = distribution.midpoint >= line.threshold ? 'MORE' : 'LESS';
      const flipped = (key: string) => !!definition.lessAware && projectedSide === 'LESS' && flipsForLess(key);
      const contextComponents = definition.factors.map(([key, maximum]) => {
        if (key === 'evidence_quality') {
          const quality = evidence.some((item) => item.quality === 'LOW' || item.confidence < .6) ? .3 :
            evidence.some((item) => item.quality === 'MEDIUM') ? .7 : 1;
          return { name: key, contribution: round(maximum * quality),
            explanation: 'Lowest quality among current attributed inputs.' };
        }
        const observation = current(evidence, 'metric:' + key)?.numeric;
        if (!observation || observation.baseline === undefined) {
          return { name: key, contribution: 0,
            explanation: `No current attributed metric supplied; weight ${maximum} contributes zero.` };
        }
        const delta = (observation.value - observation.baseline) /
          Math.max(Math.abs(observation.baseline), 1);
        if (flipped(key)) return { name: key, contribution: round(maximum * clamp(.5 - delta * 2, 0, 1)),
          explanation: `Observed ${observation.value} versus reference ${observation.baseline}; weight ${maximum}; below reference favors LESS.` };
        return { name: key, contribution: round(maximum * clamp(.5 + delta * 2, 0, 1)),
          explanation: `Observed ${observation.value} versus reference ${observation.baseline}; weight ${maximum}.` };
      });
      const rawContextScore = round(contextComponents.reduce((sum, item) => sum + item.contribution, 0));
      let contextScore = rawContextScore;
      if (definition.partialCoverageNormalization && inputCoverage < 1) {
        const normalizedObserved = round(rawContextScore / inputCoverage);
        const adjustment = round(normalizedObserved - rawContextScore);
        contextComponents.push({ name: 'partial_coverage_adjustment', contribution: adjustment,
          explanation: 'Normalize observed factor performance to the 100-point context scale; missing coverage is reported separately as data confidence.' });
        contextScore = round(clamp(rawContextScore + adjustment, 0, 100));
      }
      const difference = distribution.midpoint - line.threshold;
      let direction: PlayableDirection = difference >= 0 ? 'MORE' : 'LESS';
      const support: string[] = [];
      const oppose: string[] = missingFactorKeys.map((key) => 'Missing attributed factor ' + key);
      if (definition.sport === 'CS2' && line.market === 'headshots') {
        const kills = current(evidence, 'metric:expected_kills')?.numeric?.value;
        const historical = current(evidence, 'metric:historical_hs_pct')?.numeric?.value;
        if (!kills || historical === undefined || historical <= 0 || historical > 1) {
          return result(context, 'PASS', { reasonCode: 'MISSING_HEADSHOT_PROFILE',
            rationale: 'Expected kills and sustainable headshot rate are required.' });
        }
        if (line.threshold / kills > historical * 1.2) {
          direction = 'LESS';
          oppose.push('Required headshot rate exceeds 120% of historical rate.');
        }
      }
      if (definition.sport === 'MLB' && line.market === 'batter_walks' && line.threshold === .5) {
        const chance = current(evidence, 'metric:walk_probability')?.numeric?.value;
        if (chance === undefined || chance < 0 || chance > 1) {
          return result(context, 'PASS', { reasonCode: 'MISSING_WALK_PROBABILITY',
            rationale: 'A 0.5 walk line requires probability of at least one walk.' });
        }
        direction = chance > .5 ? 'MORE' : 'LESS';
      }
      if (!line.availableDirections.includes(direction)) return result(context, 'PASS', {
        reasonCode: 'DIRECTION_UNAVAILABLE', rationale: `The supported direction ${direction} is not offered.`,
        opposingFactors: [`${direction} unavailable`], contextScore, dataConfidence, contextComponents });

      const signed = direction === 'MORE' ? difference : -difference;
      if (signed <= 0) return result(context, 'PASS', { contextScore, dataConfidence, contextComponents,
        reasonCode: 'CONFLICTING_PROJECTION',
        rationale: 'Direction evidence conflicts with the supplied projection distribution.',
        opposingFactors: oppose });
      const cushion = signed / distribution.standardDeviation;
      const dangerWidth = definition.dangerUnits ?? (definition.sport === 'NFL' &&
        line.market === 'passing_yards' ? Math.abs(line.threshold) * .04 :
        distribution.standardDeviation * .5);
      const dangerZone = Math.abs(difference) <= dangerWidth;
      const cushionAdjustment = clamp(cushion * 5 - (dangerZone ? 6 : 0), -12, 12);
      const cv = distribution.standardDeviation / Math.max(Math.abs(distribution.midpoint), 1);
      const variance = clamp(cv < .1 ? 3 : cv > .35 ? -6 : cv > .2 ? -3 : 0,
        -6, 4);
      const quality = evidence.some((item) => item.quality === 'LOW' || item.confidence < .6) ? -3 :
        evidence.some((item) => item.quality === 'MEDIUM') ? 0 : 2;
      const demonTax = line.lineType === 'DEMON' ? -clamp(3 + Math.round(4 / (Math.abs(cushion) + .5)), 3, 10) : 0;
      const highVariance = definition.highVariance ? (line.market === 'batter_home_runs' ? -8 : -5) : 0;
      const risks = phase === 'INITIAL' ? [] : riskFindings(evidence);
      for (const risk of risks) oppose.push(`${risk.risk} severity ${risk.severity}.`);
      const blowout = risks.find((item) => item.risk === 'blowout')?.severity ?? 0;
      const leading = current(evidence, 'status:leading_script')?.numeric?.value === 1;
      const blowoutPenalty = !definition.blowoutMode ? 0 :
        definition.blowoutMode === 'RUSH_GAIN' && direction === 'MORE' && leading
          ? round(2 * blowout) :
          -round((definition.blowoutMode === 'ROTATION' ? 8 : 5) * blowout);
      const lineAdjustments = [
        ['threshold_cushion', cushionAdjustment, `Signed margin ${round(cushion)} standard deviations.`],
        ['variance', variance, `Distribution coefficient of variation ${round(cv)}.`],
        ['evidence', quality, 'Quality of the attributed, fresh evidence.'],
        ['demon_tax', demonTax, 'Added difficulty of this exact Demon outcome.'],
        ['high_variance_market', highVariance, 'Market-specific variance penalty.'],
        ['blowout', blowoutPenalty, 'Market-specific blowout impact.'],
        ['adversarial_risk', -Math.min(10, round(risks.reduce((sum, r) => sum + r.severity, 0) * 5)),
          'Opposing risk findings after adversarial review.'],
      ].map(([name, contribution, explanation]) => ({ name: String(name),
        contribution: round(Number(contribution)), explanation: String(explanation) }));
      const raw = round(contextScore + lineAdjustments.reduce((sum, item) => sum + item.contribution, 0));
      const lineScore = round(clamp(raw, 0, 100));
      if (raw !== lineScore) lineAdjustments.push({ name: 'score_clamp',
        contribution: round(lineScore - raw), explanation: 'Constrain line score to 0–100.' });
      const severe = risks.some((risk) => risk.severity >= .7 &&
        ['injury','role_change','lineup','weather','conflicting_evidence'].includes(risk.risk));
      const script = current(evidence, 'metric:game_script')?.numeric;
      const rushed = definition.sport === 'NFL' && line.market === 'player_rush_yds' &&
        direction === 'MORE' && script?.baseline !== undefined && script.value < script.baseline;
      if (dangerZone) oppose.push('Threshold sits inside the configured danger zone.');
      if (signed > dangerWidth) support.push('Exact threshold has a favorable distribution cushion.');
      if (severe || rushed || (phase !== 'INITIAL' &&
          (lineScore < 68 || (dangerZone && lineScore < 80)))) {
        return result(context, 'PASS', { contextScore, dataConfidence, contextComponents, lineScore,
          lineAdjustments, thresholdCushion: round(cushion), dangerZone,
          scoreComponents: [...contextComponents, ...lineAdjustments],
          reasonCode: severe ? 'CRITICAL_UNCERTAINTY' : rushed ? 'RUSH_SCRIPT_UNSUPPORTED' :
            dangerZone && lineScore < 80 ? 'DANGER_ZONE_NO_EDGE' : 'INSUFFICIENT_EDGE',
          rationale: 'Adversarial review did not establish a qualified exact-line edge.',
          supportingFactors: support, opposingFactors: oppose });
      }
      if (phase === 'FINAL' && context.previous?.direction === 'PASS') {
        return result(context, 'PASS', { contextScore, dataConfidence, contextComponents, lineScore,
          lineAdjustments, reasonCode: 'ADVERSARIAL_REJECTED',
          rationale: 'The adversarial PASS is retained in the final decision.',
          opposingFactors: context.previous.opposingFactors, dangerZone });
      }
      return result(context, direction, { contextScore, dataConfidence, contextComponents, lineScore,
        lineAdjustments, scoreComponents: [...contextComponents, ...lineAdjustments],
        thresholdCushion: round(cushion), dangerZone,
        rationale: `Deterministic ${definition.version} ${phase} ${direction}; context ${contextScore}, exact line ${lineScore}, attributed factor coverage ${round(inputCoverage * 100)}%.`,
        ruleChecks: [`MODEL_INPUT_COVERAGE_${dataConfidence}`,
          'DIRECTION_OFFERED','THRESHOLD_EVALUATED',
          ...(phase === 'INITIAL' ? [] : ['OPPOSING_RISKS_CHECKED'])],
        supportingFactors: support, opposingFactors: oppose });
    },
  };
}
