// Synthetic test fixtures only. These are not live odds or production projections.
import type { Analysis, Assessment, PropLine } from '@crowniq/contracts';
import { propLineSchema } from '@crowniq/contracts';

export const now = new Date('2030-09-24T12:00:00.000Z');

export function fixtureLine(overrides: Partial<PropLine> = {}): PropLine {
  return propLineSchema.parse({
    id: 'test-line-1', provider: 'prizepicks', sourceLineId: 'fixture-1', sport: 'NFL', league: 'NFL',
    eventId: 'test-event', eventName: 'Test A vs Test B', eventStartTime: '2030-09-25T00:00:00.000Z',
    playerId: 'test-player-1', playerName: 'Test Player', team: 'TEST_A', opponent: 'TEST_B',
    market: 'passing_yards', threshold: 240.5, availableDirections: ['MORE', 'LESS'],
    lineType: 'REGULAR', fetchedAt: now.toISOString(), ...overrides,
  });
}

export function fixtureAssessment(phase: Assessment['phase'], direction: Assessment['direction'],
  contribution = 72): Assessment {
  return { phase, direction, scoreComponents: direction === 'PASS' ? [] : [
    { name: 'synthetic_fixture_component', contribution, explanation: 'Fixed value used only to test contracts.' },
  ], dangerZone: false, ruleChecks: ['fixture_rule'], supportingFactors: [], opposingFactors: [],
  rationale: 'Synthetic test assessment.',
  };
}

export function fixtureAnalysis(line: PropLine, direction: 'MORE' | 'LESS' = 'MORE', score = 90): Analysis {
  return { lineId: line.id, direction, score,
    scoreBreakdown: [{ name: 'synthetic_fixture_component', contribution: score, explanation: 'Test only.' }],
    assessments: [], evidenceIds: [], evidenceQuality: 'NONE', dangerZone: false,
    ruleChecks: [], supportingFactors: [], opposingFactors: [], rationale: 'Test only.',
    reasonCode: null, modelVersion: 'test-v1' };
}
