import { rankingCardSchema, secondLookCardSchema } from '@crowniq/contracts';
import type { BoardResponse, RankingCard, SecondLookCard } from '@crowniq/contracts';
import { chooseSecondLookWatchlist } from '@crowniq/engine';

const primaryBands = new Set(['PLAYABLE', 'CROWN_STRONG', 'CROWN_ELITE']);

function commonCard(line: BoardResponse['board']['lines'][number],
  analysis: BoardResponse['analyses'][number], rank: number) {
  return {
    rank, lineId:line.id, playerId:line.playerId, playerName:line.playerName,
    sport:line.sport, league:line.league, eventId:line.eventId, eventName:line.eventName,
    eventStartTime:line.eventStartTime, team:line.team, opponent:line.opponent,
    market:line.market, threshold:line.threshold, direction:analysis.direction,
    lineType:line.lineType, payoutMultiplier:line.payoutMultiplier, score:analysis.score,
    scoreBand:analysis.scoreBand, contextScore:analysis.contextScore,
    dataConfidence:analysis.dataConfidence, modelVersion:analysis.modelVersion,
    evidenceQuality:analysis.evidenceQuality, dangerZone:analysis.dangerZone,
    thresholdCushion:analysis.thresholdCushion,
  };
}

export function rankingCards(snapshot: BoardResponse): RankingCard[] {
  const lines = new Map(snapshot.board.lines.map((line) => [line.id, line]));
  const analyses = new Map(snapshot.analyses.map((analysis) => [analysis.lineId, analysis]));
  const cards: RankingCard[] = [];
  for (const lineId of snapshot.rankedLineIds) {
    const line = lines.get(lineId), analysis = analyses.get(lineId);
    if (!line || !analysis || analysis.direction === 'PASS' || analysis.score === null ||
      analysis.score < 80 || !analysis.modelVersion || !analysis.scoreBand ||
      !primaryBands.has(analysis.scoreBand) || line.lineType === 'UNKNOWN_ALTERNATE' ||
      !line.availableDirections.includes(analysis.direction)) continue;
    cards.push(rankingCardSchema.parse({ ...commonCard(line,analysis,cards.length+1),
      reviewStatus:analysis.reviewStatus ?? (analysis.secondLook?'SECOND_LOOK':'STANDARD'),
      secondLook:analysis.secondLook ?? null }));
  }
  return cards;
}

export function secondLookWatchlist(snapshot: BoardResponse):
  { lineIds:string[]; cards:SecondLookCard[] } {
  const lines = new Map(snapshot.board.lines.map((line) => [line.id, line]));
  const analyses = new Map(snapshot.analyses.map((analysis) => [analysis.lineId, analysis]));
  const selected=chooseSecondLookWatchlist(snapshot.board.lines,snapshot.analyses);
  const cards:SecondLookCard[]=[];
  for(const lineId of selected){
    const line=lines.get(lineId),analysis=analyses.get(lineId);
    if(!line||!analysis||analysis.direction==='PASS'||analysis.score===null||
      !analysis.modelVersion||!analysis.secondLook||line.lineType==='UNKNOWN_ALTERNATE')continue;
    cards.push(secondLookCardSchema.parse({...commonCard(line,analysis,cards.length+1),
      reviewStatus:'SECOND_LOOK',secondLook:analysis.secondLook}));
  }
  return {lineIds:cards.map((card)=>card.lineId),cards};
}
