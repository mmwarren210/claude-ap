export interface FantasyRuleSet {
  readonly platform: 'prizepicks';
  readonly sport: string;
  readonly playerType: string;
  readonly version: 'prizepicks_fantasy_registry_v1';
  readonly effectiveVersion: string;
  readonly points: Readonly<Record<string, number>>;
}

function rules(sport: string, playerType: string, points: Record<string, number>): FantasyRuleSet {
  return { platform: 'prizepicks', sport, playerType,
    version: 'prizepicks_fantasy_registry_v1',
    effectiveVersion: 'user-supplied-v1-pending-platform-verification', points };
}

export const prizepicksFantasyRegistryV1: readonly FantasyRuleSet[] = [
  ...['NFL','NCAAFB'].flatMap((sport) => [
    rules(sport,'offense', { passing_yards:.04, passing_td:4, interception:-1,
      rushing_yards:.1, rushing_td:6, receiving_yards:.1, receiving_td:6, reception:1,
      fumble_lost:-1, two_point_conversion:2, offensive_fumble_recovery_td:6,
      return_td:6 }),
    rules(sport,'kicker', { fg_0_39:3, fg_40_49:4, fg_50_plus:5, pat_made:1,
      missed_fg:-1, missed_pat:-1 }),
  ]),
  ...['MLB','KBO','NPB'].flatMap((sport) => [
    rules(sport,'batter', { single:3, double:5, triple:8, home_run:10, run:2,
      rbi:2, walk:2, hit_by_pitch:2, stolen_base:5 }),
    rules(sport,'pitcher', { win:6, quality_start:4, earned_run:-3, strikeout:3, out:1 }),
  ]),
  ...['NBA','WNBA','BIG3'].map((sport) => rules(sport,'player', {
    point:1, rebound:1.2, assist:1.5, block:3, steal:3, turnover:-1,
  })),
  rules('TENNIS','player', { match_played:10, game_won:1, game_lost:-1,
    set_won:3, set_lost:-3, ace:.5, double_fault:-.5 }),
  rules('MMA','fighter', { significant_strike:.5, submission_attempt:4, takedown:5,
    knockdown:10, round_1_win:50, round_2_win:40, round_3_win:30,
    round_4_win:20, round_5_win:20, decision_win:10, draw:0 }),
  rules('SOCCER','outfield', { goal:10, assist:5, shot:1, shot_on_target:1,
    pass_attempted:.05, shot_assisted:.5, clearance:1, tackle_attempted:1,
    attempted_dribble:1, cross:.5, yellow_card:-1, red_card:-2, foul:-.5 }),
  rules('SOCCER','goalkeeper', { starting_score:5, save:2, goal_conceded:-2,
    clean_sheet:5 }),
  rules('NHL','skater', { goal:6, assist:4, power_play_point:.5, shot_on_goal:1,
    hit:.5, blocked_shot:1 }),
  rules('NHL','goalie', { win:6, save:.6, goal_against:-3 }),
];

export function fantasyRules(sport: string, playerType: string): FantasyRuleSet | null {
  return prizepicksFantasyRegistryV1.find((item) =>
    item.sport === sport && item.playerType === playerType) ?? null;
}
