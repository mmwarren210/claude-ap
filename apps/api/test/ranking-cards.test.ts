import assert from 'node:assert/strict';
import test from 'node:test';
import { boardResponseSchema } from '@crowniq/contracts';
import { fixtureAnalysis, fixtureLine, now } from '../../../packages/engine/test/fixtures.js';
import { rankingCards, secondLookWatchlist } from '../src/ranking-cards.js';

test('rankings expose complete card-ready selections in engine rank order', () => {
  const first = fixtureLine({ id:'first', playerId:'p1', playerName:'Alpha QB',
    eventName:'AAA @ BBB', team:'AAA', opponent:'BBB', threshold:245.5, lineType:'GOBLIN' });
  const second = fixtureLine({ id:'second', playerId:'p2', playerName:'Beta WR',
    market:'player_receptions', threshold:4.5, lineType:'REGULAR' });
  const firstAnalysis = { ...fixtureAnalysis(first, 'LESS', 91), scoreBand:'CROWN_STRONG' as const,
    dataConfidence:85, reviewStatus:'SECOND_LOOK' as const, secondLook:{
      initialReasonCode:'STALE_OR_MISSING_EVIDENCE', initialDataConfidence:60,
      evidenceAdded:2, performedAt:now.toISOString() } };
  const secondAnalysis = { ...fixtureAnalysis(second, 'MORE', 82), scoreBand:'PLAYABLE' as const,
    dataConfidence:80, reviewStatus:'STANDARD' as const };
  const snapshot = boardResponseSchema.parse({ board:{provider:'prizepicks',
    fetchedAt:now.toISOString(),lines:[first,second]}, analyses:[firstAnalysis,secondAnalysis],
    rankedLineIds:['first','second'], builtAt:now.toISOString() });
  const cards = rankingCards(snapshot);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((card)=>[card.rank,card.playerName,card.direction,card.score]),
    [[1,'Alpha QB','LESS',91],[2,'Beta WR','MORE',82]]);
  assert.deepEqual(cards[0], { ...cards[0], rank:1, lineId:'first', playerName:'Alpha QB',
    sport:'NFL', eventName:'AAA @ BBB', team:'AAA', opponent:'BBB', market:'passing_yards',
    threshold:245.5, direction:'LESS', lineType:'GOBLIN', score:91, scoreBand:'CROWN_STRONG',
    dataConfidence:85, reviewStatus:'SECOND_LOOK' });
  assert.equal(cards[0].secondLook?.evidenceAdded, 2);
});

test('card-ready primary rankings exclude sub-80 entries and keep visible rank numbers contiguous', () => {
  const low = fixtureLine({ id:'sub-80', playerId:'low' });
  const good = fixtureLine({ id:'good', playerId:'good' });
  const lowAnalysis = { ...fixtureAnalysis(low, 'MORE', 79), scoreBand:'PLAYABLE' as const,
    reviewStatus:'STANDARD' as const };
  const goodAnalysis = { ...fixtureAnalysis(good, 'MORE', 82), scoreBand:'PLAYABLE' as const,
    reviewStatus:'STANDARD' as const };
  const snapshot = boardResponseSchema.parse({ board:{provider:'prizepicks',
    fetchedAt:now.toISOString(),lines:[low,good]}, analyses:[lowAnalysis,goodAnalysis],
    rankedLineIds:['missing','sub-80','good'], builtAt:now.toISOString() });
  const cards=rankingCards(snapshot);
  assert.equal(cards.length,1);
  assert.equal(cards[0].lineId,'good');
  assert.equal(cards[0].rank,1);
});

test('Second Look watchlist cards remain distinct from primary rankings', () => {
  const line=fixtureLine({id:'watch',playerId:'watch-player',playerName:'Watch Player'});
  const audit={initialReasonCode:'STALE_OR_MISSING_EVIDENCE',initialDataConfidence:40,
    evidenceAdded:3,performedAt:now.toISOString()};
  const analysis={...fixtureAnalysis(line,'LESS',76),scoreBand:'LEAN' as const,
    reviewStatus:'SECOND_LOOK' as const,secondLook:audit,dataConfidence:75};
  const snapshot=boardResponseSchema.parse({board:{provider:'prizepicks',
    fetchedAt:now.toISOString(),lines:[line]},analyses:[analysis],rankedLineIds:[],
    builtAt:now.toISOString()});
  const watchlist=secondLookWatchlist(snapshot);
  assert.deepEqual(watchlist.lineIds,['watch']);
  assert.equal(watchlist.cards[0].rank,1);
  assert.equal(watchlist.cards[0].scoreBand,'LEAN');
  assert.equal(watchlist.cards[0].secondLook.evidenceAdded,3);
  assert.deepEqual(rankingCards(snapshot),[]);
});

test('card-ready rankings reject score-band drift instead of relabeling engine output', () => {
  const line = fixtureLine({ id:'bad-band' });
  const analysis = { ...fixtureAnalysis(line, 'MORE', 91), scoreBand:'PLAYABLE' as const,
    reviewStatus:'STANDARD' as const };
  const snapshot = boardResponseSchema.parse({ board:{provider:'prizepicks',
    fetchedAt:now.toISOString(),lines:[line]}, analyses:[analysis],
    rankedLineIds:['bad-band'], builtAt:now.toISOString() });
  assert.throws(()=>rankingCards(snapshot),/score band/i);
});
