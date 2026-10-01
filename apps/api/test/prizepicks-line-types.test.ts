import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { auditPrizePicksLineTypes, classifyPrizePicksLineTypes } from '../src/prizepicks-line-types.js';

// Synthetic thresholds: no odds provider calls or claims about live payout.
const regular = fixtureLine({ id: 'regular', sourceMarketKey: 'player_pass_yds',
  threshold: 240.5, availableDirections: ['MORE', 'LESS'] });
const alt = (id: string, threshold: number, direction: 'MORE' | 'LESS') => fixtureLine({
  id, sourceMarketKey: 'player_pass_yds_alternate', lineType: 'UNKNOWN_ALTERNATE',
  threshold, availableDirections: [direction],
});

test('classifies both directions against the matching Regular line without inventing payout', () => {
  const lines = classifyPrizePicksLineTypes([
    regular, alt('lower-more', 220.5, 'MORE'), alt('higher-more', 260.5, 'MORE'),
    alt('lower-less', 220.5, 'LESS'), alt('higher-less', 260.5, 'LESS'),
  ]);
  assert.deepEqual(lines.map((line) => line.lineType),
    ['REGULAR', 'GOBLIN', 'DEMON', 'DEMON', 'GOBLIN']);
  assert.ok(lines.every((line) => line.payoutMultiplier === undefined));
});

test('keeps an alternate unknown without one clear Regular threshold for its player and event', () => {
  const conflicting = fixtureLine({ ...regular, id: 'other-regular', threshold: 260.5 });
  const lines = classifyPrizePicksLineTypes([
    regular, conflicting, alt('ambiguous', 210.5, 'MORE'),
    alt('equal', 240.5, 'LESS'),
    { ...alt('different-event', 220.5, 'MORE'), eventId: 'other-event' },
    { ...alt('different-player', 220.5, 'MORE'), playerId: 'other-player' },
    { ...alt('different-market', 220.5, 'MORE'), market: 'receiving_yards' },
    { ...alt('no-reference-even-with-payout', 220.5, 'MORE'),
      eventId: 'no-reference', payoutMultiplier: 2 },
  ]);
  assert.ok(lines.slice(2).every((line) => line.lineType === 'UNKNOWN_ALTERNATE'));
});

test('uses a unique same-direction Regular threshold when the opposite direction differs', () => {
  const more = fixtureLine({ ...regular, id: 'regular-more', availableDirections: ['MORE'] });
  const less = fixtureLine({ ...regular, id: 'regular-less', threshold: 250.5,
    availableDirections: ['LESS'] });
  const lines = classifyPrizePicksLineTypes([
    more, less, alt('directional-more', 245.5, 'MORE'), alt('directional-less', 255.5, 'LESS'),
  ]);
  assert.deepEqual(lines.map((line) => line.lineType),
    ['REGULAR', 'REGULAR', 'DEMON', 'GOBLIN']);
});

test('audits unknown alternates without guessing their tier', () => {
  const noReference={...alt('no-reference',220.5,'MORE'),eventId:'missing-regular'};
  const ambiguousRegular=fixtureLine({...regular,id:'regular-2',threshold:250.5});
  const equal=alt('equal-reference',240.5,'MORE');
  const unsupported={...alt('unsupported',220.5,'MORE'),sourceMarketKey:'player_pass_yds'};
  const classifiable=alt('classifiable',220.5,'MORE');
  const audit=auditPrizePicksLineTypes([
    regular,ambiguousRegular,noReference,equal,unsupported,classifiable,
  ]);
  assert.deepEqual(audit.counts,{REGULAR:2,GOBLIN:0,DEMON:0,UNKNOWN_ALTERNATE:4});
  assert.deepEqual(audit.multiplierCoverage,{linesWithMultiplier:0,unknownWithMultiplier:0});
  assert.deepEqual(audit.unknownReasons,{
    NO_REGULAR_REFERENCE:1,
    AMBIGUOUS_REGULAR_REFERENCE:2,
    EQUAL_TO_REGULAR:0,
    UNSUPPORTED_SHAPE:1,
    CLASSIFIABLE:0,
  });
  assert.deepEqual(audit.unknownByMarket,[{sport:'NFL',market:'passing_yards',count:4}]);
  const resolved=auditPrizePicksLineTypes(classifyPrizePicksLineTypes([regular,classifiable]));
  assert.equal(resolved.counts.GOBLIN,1);
  assert.equal(resolved.unknownReasons.CLASSIFIABLE,0);
});

test('audit reports multiplier coverage without using payout to guess line type',()=>{
  const unknown={...alt('priced-unknown',220.5,'MORE'),eventId:'missing-regular',
    payoutMultiplier:1.5};
  const pricedRegular={...regular,id:'priced-regular',payoutMultiplier:1};
  const audit=auditPrizePicksLineTypes([unknown,pricedRegular]);
  assert.deepEqual(audit.multiplierCoverage,{linesWithMultiplier:2,unknownWithMultiplier:1});
  assert.equal(audit.counts.UNKNOWN_ALTERNATE,1);
  assert.equal(audit.unknownReasons.NO_REGULAR_REFERENCE,1);
});
