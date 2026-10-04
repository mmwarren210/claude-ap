import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Analysis, PropLine } from '@crowniq/contracts';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { AppShadowScorer } from '../src/app-shadow.js';
import { BoxScoreResults } from '../src/box-score-results.js';
import { ScrapedLineStore } from '../src/scrapers/line-store.js';

test('shadow scoring runs the model on app numbers with PrizePicks research, records each play once and grades it',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-shadow-'));
  let clock=new Date('2030-09-24T12:00:00Z');
  try{
    const store=new ScrapedLineStore(join(folder,'lines.json'),()=>clock);
    const row=(app:'underdog'|'pick6',id:string,player:string,stat:string,line:number)=>({app,appLineId:id,league:'NFL',
      gameId:'g1',player,team:'CHI',teamName:'Chicago Bears',opponent:'GB',stat,line,tier:'REGULAR' as const,
      directions:['MORE','LESS'] as ('MORE'|'LESS')[],startTime:'2030-09-25T00:00:00.000Z',imageUrl:null,
      multipliers:{MORE:1.8,LESS:1.9}});
    await store.ingest('ud',[row('underdog','u1','Player A','Receiving Yards',58.5),row('underdog','u2','Nobody Else','Receptions',4.5)],
      {complete:true,apps:['underdog']});
    await store.ingest('p6',[row('pick6','p1','Player A','Receiving Yards',56.5)],{complete:true,apps:['pick6']});
    const playerId=`americanfootball_nfl:${createHash('sha256').update('player a').digest('hex').slice(0,24)}`;
    const prizePicks=fixtureLine({id:'pp:1',sourceLineId:'1',eventId:'pp-game:1',playerId,playerName:'Player A',
      market:'player_reception_yds',threshold:56.5,eventStartTime:'2030-09-25T00:00:00Z',sport:'NFL',league:'NFL',
      homeTeam:'Bears',awayTeam:'Packers',team:'Bears',opponent:'Packers',fetchedAt:'2030-09-24T11:00:00Z'});
    const scoredLines:PropLine[][]=[];
    const board={getBoard:()=>({board:{lines:[prizePicks]}}),
      scoreLines:(lines:readonly PropLine[])=>{scoredLines.push([...lines]);
        return lines.map((line)=>({lineId:line.id,direction:line.threshold>57?'LESS':'MORE',score:line.threshold>57?83:88,
          modelVersion:'GKR-NFL-REC-1'}) as unknown as Analysis);}};
    const espn:typeof fetch=async(input)=>{
      const url=String(input);
      if(url.includes('/scoreboard'))return new Response(JSON.stringify({events:[{id:'5',date:'2030-09-25T00:00Z',
        status:{type:{completed:true,state:'post'}},competitions:[{competitors:[{team:{displayName:'Chicago Bears'}},
          {team:{displayName:'Green Bay Packers'}}]}]}]}),{status:200});
      return new Response(JSON.stringify({boxscore:{players:[{team:{displayName:'Chicago Bears'},statistics:[
        {name:'receiving',keys:['receptions','receivingYards'],athletes:[{athlete:{displayName:'Player A'},stats:['5','57']}]}]}]}}),
      {status:200});
    };
    const shadow=new AppShadowScorer(store,board,join(folder,'shadow.json'),new BoxScoreResults(espn,()=>clock),
      async()=>({graded:10,wins:6}),()=>clock);
    assert.deepEqual(await shadow.score(),{scored:2,plays:2,added:2},'only lines PrizePicks also lists are scored');
    // The research key is the PrizePicks game, player and market; the number and sides are the app's.
    const scored=scoredLines[0][0];
    assert.deepEqual([scored.eventId,scored.playerId,scored.market,scored.threshold],['pp-game:1',playerId,'player_reception_yds',58.5]);
    assert.deepEqual(await shadow.score(),{scored:2,plays:2,added:0},'a play is recorded once');
    clock=new Date('2030-09-25T06:00:00Z');
    assert.equal(await shadow.grade(),2);
    const summary=await shadow.summary();
    // Underdog LESS 58.5 with 57 yards wins; Pick6 MORE 56.5 wins.
    assert.deepEqual([summary.apps.underdog.score80Plus.wins,summary.apps.pick6.score80Plus.wins],[1,1]);
    assert.equal(summary.apps.underdog.differentNumber.graded,1);
    assert.equal(summary.apps.pick6.sameNumber.graded,1);
    assert.equal(summary.apps.underdog.readyForGoLive,false,'150 graded plays are needed');
    assert.equal(summary.prizePicksGkr?.hitRate,0.6);
  }finally{await rm(folder,{recursive:true,force:true});}
});
