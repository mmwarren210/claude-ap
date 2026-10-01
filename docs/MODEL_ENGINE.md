# CrownIQ deterministic model engine

The engine evaluates the **complete normalized PrizePicks board** before choosing one strongest threshold per player for automatic ranking. Its unit of evaluation is the offered direction on an exact line, not player reputation. The previous provider adapter and conservative `UNKNOWN_ALTERNATE` classification remain unchanged.

## Activation and evidence boundary

The Odds API board supplies numeric prop thresholds, IDs, sports, markets, and offered directions. It does **not** supply the role, matchup, calibrated distribution, independent stat feeds, team mapping, injury confirmation, or real payout needed to score those lines. The production API registers all definitions but defaults to PASS. An owner can list exact versions in server-only `GKR_APPROVED_MODEL_VERSIONS` **only after reviewing and calibrating the component mapping for those versions**. Without structured current evidence, approval alone still yields PASS. No AI-generated numeric or unattributed public evidence is accepted as a confirmed input.

The `Evidence` contract carries `kind`, `numeric.value`, optional `numeric.baseline`, retrieval/expiry time, confidence, quality, and source. `metric:<factor>` has an observed value and a same-unit reference baseline; `projection:<market>` stores a projected midpoint in `value` and **standard deviation** in `baseline`. `status:<kind>` is a confirmed 1 or otherwise not confirmed. `risk:<kind>` is adverse severity from 0 to 1. Fantasy markets require an attributed `fantasy_scenarios` record with **joint** stat outcomes whose probabilities total 1. Modules declare their required and recommended kinds; the protected owner status exposes those declarations and calibration state. Short-lived status records also have a maximum age even if the upstream expiry is longer. Newer role observations override older observations of the same kind.

Production market modules now distinguish **hard gates** from weighted factor coverage. The distribution (`projection:<market>` or fantasy scenarios) and every configured hard critical status remain requirements. A calibrated module may evaluate with some non-critical factor metrics missing only when attributed numeric observations cover at least 60% of the market's non-quality factor weight. Missing factors contribute **zero**, are listed as opposing factors, and are never filled with the PrizePicks threshold or an AI guess. For partial-coverage pilot models, missing optional factors no longer directly reduce the edge score; completeness is exposed separately as `dataConfidence` (0–100, equal to weighted attributed factor coverage). Model approval and critical-status PASS rules are unchanged.

The opt-in server adapter `GKR_STAT_EVIDENCE=true` builds rolling historical distributions and directly derivable factor observations from the licensed Stat API feed for supported NFL/NBA/MLB markets. It exact-matches player identity conservatively, uses only pre-event game rows, and never manufactures lineup, injury, weather, opponent, or role confirmations. Reanalysis can therefore improve numerical coverage without another Odds API pull, while unresolved critical status still PASSes.

The owner can set `GKR_MODEL_PRESET=stat_history_v1` to activate the 20 markets currently connected to that history pipeline: eight NFL markets (passing yards, pass attempts, pass completions, rushing yards, rush attempts, receiving yards, receptions, receiving targets), seven NBA markets (points, rebounds, assists, PRA, points+rebounds, points+assists, rebounds+assists), and five MLB markets (H+R+RBI, hits, walks, home runs, pitcher strikeouts). These definitions use the v1.2 partial-coverage rule so missing optional factors are represented by Data Confidence instead of an automatic score penalty once at least 60% of weighted factors are attributed. The preset does **not** remove hard current-status requirements such as confirmed QB/workload/target role, NBA minutes/lineup, or MLB lineup/starting-pitcher/pitch-limit checks.

CrownIQ now treats a supported initial PASS as eligible for **Second Look** unless the failure is structural (for example, the event already started, the model/alternate is unsupported, the requested direction is unavailable, or the model output is invalid). Second Look runs targeted historical research only for the affected player/event/market, merges any new attributed evidence, and then runs the deterministic GKR evaluation again from scratch. It never adds a score bonus. The final score can rise, fall, or remain PASS. Analyses that went through this stage carry a persisted `SECOND_LOOK` review flag plus the initial PASS reason, initial data-confidence value, time reviewed, and number of new evidence records. The mobile badge is a review cue for the user—not a guarantee or hit-probability signal.

## Auditable formula

For every weighted market factor with maximum `w`, source value `x` and documented source reference `b`:

`factor_points = round(w × clamp(0.5 + 2 × (x − b) / max(|b|, 1), 0, 1), 2)`

Context Score normally equals the sum of those factor points. For the NFL passing pilot v1.2 models only, sufficiently covered partial evidence is normalized across the observed factor weight with **no direct missing-coverage score penalty**. Missing factors remain zero in the audit trail; no value is imputed for them. Their absence is represented separately by `dataConfidence`, so a strong observed edge can score strongly while the UI still shows that only, for example, 60% of weighted model factors were backed by attributed numeric evidence. Where the global fallback layout includes Evidence Quality, its contribution is 100%, 70%, or 30% of its own weight for high, medium, or low confidence/quality inputs. These **0.5 midpoint and 2× slope constants are provisional modeling assumptions**, not learned calibration. The owner must approve each exact model version before it can score. Components cannot be supplied as pre-scored values by an AI service.

The selected direction follows the projected distribution's midpoint relative to the exact threshold, subject to market rules and the platform's offered direction. Let signed cushion be `(midpoint − threshold)/SD` for MORE and `(threshold − midpoint)/SD` for LESS. The threshold adjustment is `clamp(5 × signed_cushion − danger_zone_penalty, −12, 12)`, where danger zone costs 6. Passing yards use a 4% distance from the line as the NFL danger width; CS2 kills use 1.5 kills, tennis totals 1 game, and other modules default to 0.5 SD. Variance adjusts −6 to +4, evidence −3 to +2, and a Demon pays a deterministic −3 to −10 tax. Goblin receives **no label bonus**. Home runs and other configured high-variance markets get a separate auditable penalty. Blowout adjustments depend on the market and supported game script. The adversarial pass deducts documented risk severities or returns PASS for severe injury, role, lineup, weather, or conflicting evidence.

`Line Score = clamp(Context Score + named exact-line adjustments, 0, 100)`

Clamping appears in the score breakdown, so the breakdown sums to the reported score. Both scores are **rank indices**, not hit probabilities. Bands: 92+ Crown Elite, 86+ Crown Strong, 80+ Playable, 74+ Lean, 68+ Weak, below 68 PASS. A dangerous line below 80 also PASSes. Initial, adversarial, and final assessment outputs are retained for each serious candidate. If the supported direction is unavailable, the result is PASS.

The full ladder is evaluated, including alternatives after a Regular PASS. Board ranking uses final **Line Score**, then evidence quality, normalized cushion, opportunity/stability components, variance, matchup, and the lower MORE/higher LESS threshold within the same player/event/market. Only the best line per player enters automatic ranking; all evaluated lines stay in the board for manual inspection. A model version is attached to analysis and saved selection snapshots; no score is retroactively recalculated in a saved snapshot.

## Registered market definitions

These 69 definitions retain explicit market-specific weights. Most remain version `GKR-{SPORT}-{MARKET}-1.0`. The 20 NFL/NBA/MLB markets in the `stat_history_v1` cohort use version `1.2` or `1.3`. The `1.3` revisions replace several unavailable matchup/role placeholders with directly derivable rolling-history factors such as workload rate, offensive snap volume, target opportunity rate, receiving efficiency, minutes, shot volume, scoring/rebound/assist rates, plate appearances, contact rate, walk volume and power frequency. The 60% attributed-factor coverage gate is unchanged; no missing input is marked confirmed merely to make a line score. Registry presence means the engine knows which input fields and weights to use; it does **not** establish predictive validity or guarantee a data feed will return every field.

| Sport | Market keys |
| --- | --- |
| NFL | `passing_yards`, `player_pass_attempts`, `player_pass_completions`, `player_pass_tds`, `player_rush_yds`, `player_rush_attempts`, `player_reception_yds`, `player_receptions`, `player_receiving_targets`, `player_tackles_assists`, `player_sacks`, `player_kicking_points`, `player_punts`, `player_completion_percentage`, `player_fantasy_points` |
| MLB | `batter_hits_runs_rbis`, `batter_hits`, `batter_walks`, `batter_home_runs`, `pitcher_strikeouts`, `batter_fantasy_score`, `pitcher_fantasy_score` |
| NBA and WNBA, each | `player_points`, `player_rebounds`, `player_assists`, `player_points_rebounds_assists`, `player_points_rebounds`, `player_points_assists`, `player_rebounds_assists`, `player_fantasy_points` |
| Tennis | `match_winner`, `total_games`, `total_sets`, `player_aces`, `player_double_faults`, `player_break_points`, `first_set_total_games`, `player_fantasy_points` |
| Table tennis | `full_match_total_points`, `first_game_total_points` |
| Badminton | `match_context`, `game_point_totals` |
| CS2 | `maps_1_2_kills`, `headshots` |
| Valorant | `kills` |
| League of Legends | `kills`, `assists` |
| Dota | `kills`, `assists` |
| Apex | `kills` |
| NHL | `shots_on_goal`, `points`, `saves`, `player_fantasy_points` |
| NCAAFB | `passing_yards`, `player_rush_yds`, `qb_rushing_yards`, `player_reception_yds`, `player_fantasy_points` |
| Handball | `goals`, `assists` |

Specific guards include NFL QB/OL/weather confirmation, RB workload and rushing game script, NBA/WNBA minutes, MLB confirmed lineup/pitcher, MLB walks 0.5 requiring at-least-one probability, tournament round for badminton, CS2 round volume and headshot-rate comparison, roster confirmation for esports, NHL confirmed starting goalie, NCAAFB rotation, and separate sport-specific blowout effects. Missing critical inputs PASS. Some market names above have no corresponding odds-provider market in the saved snapshot; those modules cannot yet be exercised on a real board.

## Fantasy and Crowns

The version `prizepicks_fantasy_registry_v1` contains the user-specified scoring for NFL/NCAAFB offense and kicker, MLB/KBO/NPB batter and pitcher, NBA/WNBA/BIG3, tennis, MMA, soccer outfield and goalkeeper, NHL skater and goalie. The fantasy scorer totals **one joint stat scenario at a time** and derives a weighted expected value and standard deviation from complete scenarios. It never multiplies independent HR, run, RBI, reception, yard, and TD probabilities. These scoring tables follow the supplied specification; platform rules and effective dates should be checked before production use. Soccer, MMA, KBO, NPB, and BIG3 are in the fantasy registry but lack corresponding normalized live markets/sport mappings today.

Crown minima by requested size are 2:88, 3:86, 4:84, 5:82, 6:80. Auto selection examines the board's Top 10 in rank order, rejects duplicate players, unknown alternates, invalid/stale lines, under-minimum scores, unknown team identity, three or more teammates, and multiple Apex teammates. It requires an explicit correlation policy; because a validated policy and reliable team identities do not yet exist, the deployed app cannot generate an auto Crown. An incomplete request returns its qualified legs with `INSUFFICIENT_QUALIFIED_PICKS` and reserves instead of adding weak picks. Manual review preserves the submitted legs and shows strongest, weakest, and all audit issues. The three-teammate concentration threshold is a **conservative assumption for owner review**, not a claim about PrizePicks rules.

## Saved-board check and remaining validation

Offline evaluation of the saved September 24 board inspected **20,081 / 20,081 lines** with zero ranked picks and zero API credits: 8,009 required evidence, 9,568 lacked a mapped definition, and 2,504 unknown alternates sat in mapped markets. The report preserves their line IDs and reason codes. The pipeline cannot make credible live recommendations until owner-approved feature normalization, calibrated distributions, verified payout, player-team mapping, structured trusted data feeds, and correlation rules exist. Match winner without a numeric PrizePicks threshold also remains unavailable under the current provider contract. These gaps are deliberate PASS boundaries.

## Fresh pregame context

Second Look now combines history with a deterministic fresh-context adapter before the final GKR rerun. MLB current context comes from the MLB Stats API and only emits canonical facts when the event/player identity can be matched to a posted batting order or listed probable starter. NFL current availability comes from the structured Sleeper player-status feed and never invents workload or target share. NBA current availability reuses the existing server-only Stat API player-status feed and exact-name identity checks.

Factual gates and modeled context are deliberately separate. `status:player_available`, MLB posted batting order, MLB listed starter, and QB availability may hard-block a line. Expected minutes, expected workload, target role, game script, and pitch-limit/hook risk remain model context rather than fabricated binary facts. Missing modeled context lowers evidence coverage/Data Confidence or produces PASS through the normal model rules; it is not silently promoted to a confirmed status.

Fresh context uses short TTLs and never remains valid past event start. Generic AI/web findings remain review evidence and cannot satisfy these hard factual gates.

## History-backed factor coverage

The `stat_history_v1` cohort now has at least 60% of each model's non-quality factor weight mapped to values that can be computed directly from Stat API game rows and the CrownIQ internal-history store. Both paths use the same factor names and formulas, and regression tests fail if either path falls below that coverage floor. Examples include rush attempts per offensive snap for workload rate, targets per offensive snap for target opportunity, receiving yards per target for efficiency, points/rebounds/assists per minute role rates, and rolling MLB PA/contact/walk/power measures.

These are historical model factors, not current-game confirmations. Current opponent, lineup, weather, starter, injury and other event-specific context remains separate evidence and can still keep a line at PASS. The projection distribution is produced independently of the PrizePicks threshold, and the existing 60% coverage requirement, three-pass review, danger-zone handling and exact-line adjustments remain intact.
