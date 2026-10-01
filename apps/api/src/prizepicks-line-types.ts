import type { PlayableDirection, PropLine, Sport } from '@crowniq/contracts';

interface RegularThresholds {
  all: Set<number>;
  MORE: Set<number>;
  LESS: Set<number>;
}
export interface PrizePicksLineTypeAudit {
  counts: { REGULAR:number; GOBLIN:number; DEMON:number; UNKNOWN_ALTERNATE:number };
  multiplierCoverage:{linesWithMultiplier:number;unknownWithMultiplier:number};
  unknownReasons: {
    NO_REGULAR_REFERENCE:number;
    AMBIGUOUS_REGULAR_REFERENCE:number;
    EQUAL_TO_REGULAR:number;
    UNSUPPORTED_SHAPE:number;
    CLASSIFIABLE:number;
  };
  unknownByMarket:{sport:string;market:string;count:number}[];
}

export function normalizePrizePicksMarketKey(sport:Sport,sourceMarketKey:string):string{
  const base=sourceMarketKey.replace(/_alternate$/,'');
  if(base==='player_pass_yds')return 'passing_yards';
  if(sport==='NHL'&&base==='player_points')return 'points';
  if(sport==='NHL'&&base==='player_shots_on_goal')return 'shots_on_goal';
  return base;
}

export function normalizeCachedPrizePicksLines(lines:readonly PropLine[]):PropLine[]{
  return lines.map((line)=>{
    if(!line.sourceMarketKey)return line;
    const market=normalizePrizePicksMarketKey(line.sport,line.sourceMarketKey);
    return market===line.market?line:{...line,market};
  });
}

function groupKey(line: PropLine): string {
  return JSON.stringify([line.provider, line.sourceSportKey ?? line.sport,
    line.eventId, line.playerId, line.market]);
}

function soleValue(values: Set<number>): number | undefined {
  return values.size === 1 ? values.values().next().value : undefined;
}

function regularThresholds(lines:readonly PropLine[]):Map<string,RegularThresholds>{
  const regular=new Map<string,RegularThresholds>();
  for(const line of lines){
    if(line.lineType!=='REGULAR')continue;
    const key=groupKey(line);
    let thresholds=regular.get(key);
    if(!thresholds){
      thresholds={all:new Set(),MORE:new Set(),LESS:new Set()};
      regular.set(key,thresholds);
    }
    thresholds.all.add(line.threshold);
    for(const direction of line.availableDirections)thresholds[direction].add(line.threshold);
  }
  return regular;
}

/** Apply CrownIQ's direction-aware Regular-versus-alternate threshold rule to the whole board. */
export function classifyPrizePicksLineTypes(lines: readonly PropLine[]): PropLine[] {
  const regular=regularThresholds(lines);
  return lines.map((line) => {
    // Provider adapters expose each Over/Under outcome as a separate line. A
    // combined two-direction alternate needs two separate tier classifications.
    if (line.lineType !== 'UNKNOWN_ALTERNATE' ||
      !line.sourceMarketKey?.endsWith('_alternate') || line.availableDirections.length !== 1) {
      return line;
    }
    const direction: PlayableDirection = line.availableDirections[0];
    const thresholds = regular.get(groupKey(line));
    if (!thresholds) return line;
    const relevant = thresholds[direction];
    // Different Regular thresholds for the same player/event/market are
    // ambiguous. Only use the opposite direction when none was offered.
    const reference = relevant.size ? soleValue(relevant) : soleValue(thresholds.all);
    if (reference === undefined || line.threshold === reference) return line;
    const harder = direction === 'MORE'
      ? line.threshold > reference : line.threshold < reference;
    return { ...line, lineType: harder ? 'DEMON' : 'GOBLIN' };
  });
}

/** Explain why any alternates remain unclassified without relaxing CrownIQ's fail-closed rule. */
export function auditPrizePicksLineTypes(lines:readonly PropLine[]):PrizePicksLineTypeAudit{
  const regular=regularThresholds(lines);
  const counts={REGULAR:0,GOBLIN:0,DEMON:0,UNKNOWN_ALTERNATE:0};
  const multiplierCoverage={linesWithMultiplier:0,unknownWithMultiplier:0};
  const unknownReasons={NO_REGULAR_REFERENCE:0,AMBIGUOUS_REGULAR_REFERENCE:0,
    EQUAL_TO_REGULAR:0,UNSUPPORTED_SHAPE:0,CLASSIFIABLE:0};
  const byMarket=new Map<string,{sport:string;market:string;count:number}>();
  for(const line of lines){
    counts[line.lineType]++;
    if(line.payoutMultiplier!==undefined)multiplierCoverage.linesWithMultiplier++;
    if(line.lineType!=='UNKNOWN_ALTERNATE')continue;
    if(line.payoutMultiplier!==undefined)multiplierCoverage.unknownWithMultiplier++;
    const marketKey=`${line.sport}|${line.market}`;
    const bucket=byMarket.get(marketKey)??{sport:line.sport,market:line.market,count:0};
    bucket.count++;byMarket.set(marketKey,bucket);
    if(!line.sourceMarketKey?.endsWith('_alternate')||line.availableDirections.length!==1){
      unknownReasons.UNSUPPORTED_SHAPE++;continue;
    }
    const thresholds=regular.get(groupKey(line));
    if(!thresholds){unknownReasons.NO_REGULAR_REFERENCE++;continue;}
    const direction:PlayableDirection=line.availableDirections[0];
    const relevant=thresholds[direction];
    const reference=relevant.size?soleValue(relevant):soleValue(thresholds.all);
    if(reference===undefined){unknownReasons.AMBIGUOUS_REGULAR_REFERENCE++;continue;}
    if(line.threshold===reference){unknownReasons.EQUAL_TO_REGULAR++;continue;}
    unknownReasons.CLASSIFIABLE++;
  }
  const unknownByMarket=[...byMarket.values()].sort((a,b)=>b.count-a.count||
    a.sport.localeCompare(b.sport)||a.market.localeCompare(b.market));
  return {counts,multiplierCoverage,unknownReasons,unknownByMarket};
}
