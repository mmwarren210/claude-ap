import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgePick } from '@crowniq/contracts';
import { matchTip, modelRead } from '../src/tip-models.js';

const pick = (market: string, threshold: number, side: 'MORE' | 'LESS', probability: number, extra: Partial<EdgePick> = {}) =>
  ({ playerName: 'Jaylen Bonelli', market, threshold, side, probability, oppositeProbability: 1 - probability, breakEven: .542,
    lineType: 'REGULAR', ...extra }) as unknown as EdgePick;
const tip = (stat: string, line: number, side: 'OVER' | 'UNDER' | null = 'UNDER') =>
  ({ market: 'PLAYER_PROP' as const, selection: 'Jaylen Bonelli', line, stat, side });

test('a prop tip matches the same player, number and stat on the board', () => {
  const board = [pick('player_rush_rec_yds', 49.5, 'LESS', .6), pick('player_reception_yds', 49.5, 'LESS', .76),
    pick('player_receptions', 4.5, 'MORE', .55)];
  assert.equal(matchTip(tip('Receiving Yards', 49.5), board)?.market, 'player_reception_yds');
  assert.equal(matchTip(tip('Rush + Rec Yards', 49.5), board)?.market, 'player_rush_rec_yds');
  assert.equal(matchTip(tip('Receptions', 4.5), board)?.market, 'player_receptions');
  assert.equal(matchTip(tip('Receiving Yards', 52.5), board), null, 'a different number is a different line');
  assert.equal(matchTip({ ...tip('Receiving Yards', 49.5), selection: 'Somebody Else' }, board), null);
  assert.equal(matchTip({ ...tip('Receiving Yards', 49.5), market: 'MONEYLINE' as const }, board), null);
});

test('a model read holds its chance on the tipster’s side against the break-even', () => {
  const agree = modelRead({ side: 'UNDER' }, pick('player_reception_yds', 49.5, 'LESS', .76), 'prizepicks');
  assert.deepEqual([agree.verdict, agree.chance, agree.modelSide], ['PLAY', .76, 'LESS']);
  const against = modelRead({ side: 'OVER' }, pick('player_reception_yds', 49.5, 'LESS', .76), 'prizepicks');
  assert.deepEqual([against.verdict, against.chance], ['FADE', .24]);
  assert.equal(modelRead({ side: 'OVER' }, pick('player_receptions', 4.5, 'MORE', .55), 'prizepicks').verdict, 'LEAN');
});
