import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { autoResolveNflverseMapping, parseNflverseSchedule,
  parseNflverseStats } from '../src/nflverse-results.js';

const schedule=(scores=true)=>parseNflverseSchedule(
  'game_id,season,gameday,gametime,away_team,away_score,home_team,home_score\n'+
  `2026_04_PIT_CLE,2026,2026-10-01,20:15,PIT,${scores?'21':''},CLE,${scores?'17':''}\n`);

const stats=(duplicate=false)=>parseNflverseStats(
  'game_id,player_id,team,attempts,passing_yards,player_display_name,receptions,targets,receiving_yards\n'+
  '2026_04_PIT_CLE,00-TEST,PIT,0,0,Exact Player,6,9,83\n'+
  (duplicate?'2026_04_PIT_CLE,00-OTHER,PIT,0,0,Exact Player,1,2,8\n':''));

const line=fixtureLine({id:'auto-map-line',sourceLineId:'auto-map-source',
  eventId:'provider-event',eventName:'Pittsburgh Steelers @ Cleveland Browns',
  eventStartTime:'2026-10-02T00:15:00Z',playerId:'provider-player',
  playerName:'Exact Player',team:null,opponent:null,market:'player_receptions'});

test('auto nflverse mapping requires exact Eastern kickoff, final scores and one exact player row',()=>{
  const now=new Date('2026-10-02T06:30:00Z');
  const mapping=autoResolveNflverseMapping(line,schedule(),stats(),now);
  assert.ok(mapping);
  assert.deepEqual({
    eventId:mapping.eventId,playerId:mapping.playerId,nflverseGameId:mapping.nflverseGameId,
    nflversePlayerId:mapping.nflversePlayerId,team:mapping.team,season:mapping.season,
  },{
    eventId:'provider-event',playerId:'provider-player',nflverseGameId:'2026_04_PIT_CLE',
    nflversePlayerId:'00-TEST',team:'PIT',season:2026,
  });
  assert.equal(mapping.completedAt,now.toISOString());
});

test('auto nflverse mapping stays unresolved before the safety window or on ambiguous/incomplete evidence',()=>{
  assert.equal(autoResolveNflverseMapping(line,schedule(),stats(),
    new Date('2026-10-02T06:00:00Z')),null);
  assert.equal(autoResolveNflverseMapping(line,schedule(false),stats(),
    new Date('2026-10-02T06:30:00Z')),null);
  assert.equal(autoResolveNflverseMapping(line,schedule(),stats(true),
    new Date('2026-10-02T06:30:00Z')),null);
  assert.equal(autoResolveNflverseMapping({...line,eventName:'Unknown Team @ Cleveland Browns'},
    schedule(),stats(),new Date('2026-10-02T06:30:00Z')),null);
});
