import type { Href } from 'expo-router';
import { router } from 'expo-router';
import { useTrial } from '../auth';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';
import { Screen } from '../components/Screen';
import { Icon } from '../components/ui/Icon';
import type { IconName } from '../components/ui/Icon';
import { colors, radius } from '../theme';

type Topic = { key: string; icon: IconName; title: string; when: string; points: string[]; open?: Href; openLabel?: string };

// The member guide, in short taps. Keep it in step with the shared CrownIQ Tab Guide.
const topics: readonly Topic[] = [
  { key: 'start', icon: 'rocket-launch-outline', title: 'Start here', when: 'The 60-second way to a pick',
    points: ['Open Top Picks, tap Filter, pick your sport and game.', 'Play the side it shows (More or Less).',
      'Want the math? Open Edge. Want a player you have in mind? Open Board.', 'Build the entry in Crown, then copy it into your app.',
      'PASS is a real answer: when nothing clears the bar, CrownIQ says so.'] },
  { key: 'board', icon: 'view-grid-outline', title: 'Board', when: 'Look up a player or browse one app', open: '/(tabs)', openLabel: 'Open Board',
    points: ['Pick the app at the top: PrizePicks, Underdog, Pick6, Dabble, DraftKings, Hard Rock, Pinnacle, Kalshi or Line Shop.',
      'PrizePicks shows each player’s best play with its GKR score (0–100). Search any player or tap one for all their stats.',
      'Each player’s position (QB, WR, PG, SP and so on) shows next to their name on every card, when it’s known.',
      'Model: GKR, GKR 2 or Both. GKR 2 is in Beta (still calibrating), so use its picks at your own risk. Both shows GKR 2’s read under GKR’s and says why they differ.',
      'A player’s page shows how often picks like this one have hit, and the player’s season averages (home and away).',
      'Underdog, Pick6 and Dabble show every line at that app’s number. Tap More or Less to build a slip.',
      'Line Shop shows the same player and stat on every app, so you can take the best number.'] },
  { key: 'top', icon: 'star-outline', title: 'Top Picks', when: 'The strongest plays, fast', open: '/(tabs)/top-picks', openLabel: 'Open Top Picks',
    points: ['All: the best picks from every app, ranked together.', 'PrizePicks: GKR’s top picks (80+). The 2nd Look list scores 68–79: check before playing. The Model switch shows GKR 2’s (Beta) list or both.',
      'Each app has its own list, plus +EV: lines that beat the break-even at sportsbook prices.', 'Tap a pick to open the player, or Add to put it in your Crown.',
      'A line far from the player’s recent games (often a role change, like a new starter or a minutes cut) shows PASS, not a pick.'] },
  { key: 'vetted', icon: 'check-decagram-outline', title: 'Vetted', when: 'Outside tips CrownIQ approved', open: '/(tabs)/vetted', openLabel: 'Open Vetted',
    points: ['Tips from outside services, checked three ways: against the market (with an AI news search), by CrownIQ’s models and by Edge. GKR 2’s read (Beta) shows too, but it never decides.',
      'A pick is listed when any of them rates it PLAY and none calls it a FADE. “Approved by” shows which ones did.',
      'GKR and Edge check player props that are on a CrownIQ board, at the pick’s own price (✓ agrees, ✗ doesn’t).',
      'Each shows the pick, the game and start time, its chance to hit, the price and the EV.',
      'The live scoreboard on top shows every vetted play’s result: record, hit rate, units won or lost (one unit a play), streak and record by sport. It updates every minute; picks in progress show LIVE.',
      'Picks are graded from the box score after the game. A graded pick leaves the list and its result goes into the scoreboard.',
      'A pick whose game can’t be found within 3 days is voided and doesn’t count.',
      'Submit a pick: tap Upload screenshot. CrownIQ reads every pick and shows its verdict (PLAY, LEAN, PASS or FADE) under Your submissions within a minute.',
      'Your PLAYs join the Vetted list for everyone, marked “Submitted by” your username. 2 screenshots a day during the beta.',
      'The tipster or service a screenshot came from is never shown.'] },
  { key: 'crown', icon: 'crown-outline', title: 'Crown', when: 'Build and save your entry', open: '/(tabs)/crown', openLabel: 'Open Crown',
    points: ['Choose the app, then add picks or let the generator build one (size, line style, sports).',
      'You see the payout and the chance each pick needs to break even.', 'Tips warn you before weaker picks, like two players on one team. You can override them.',
      'Copy the picks and open your app to place it.'] },
  { key: 'edge', icon: 'diamond-outline', title: 'Edge', when: 'The numbers behind a pick', open: '/(tabs)/edge', openLabel: 'Open Edge',
    points: ['Edge sets its own number from the sportsbooks and stats, and picks the side that beats the payout.',
      'Top Picks: picks above break-even and the best full entries. Board: every line it read. Gen: builds entries. Record: its graded results.',
      'Tap a pick for its page. “This player’s lines” shows every number for that stat with its side, chance, EV, and PLAY or PASS.',
      'DraftKings, Hard Rock, Pinnacle and Kalshi bets show a suggested stake (a small share of your bankroll, max 2%).',
      'Kalshi picks already count Kalshi’s trading fee. Parlays: DraftKings up to 8 legs, Hard Rock and Pinnacle 21, Kalshi 50.',
      'A new app’s picks stay out of Top Picks and Gen for its first few updates while CrownIQ checks them.',
      'Underdog Streaks and Ladders: on Edge, pick Underdog and tap Streaks or Ladders for today’s surest picks (70%+ chance, backed by sportsbook prices or stats). Streaks show the smallest multiplier worth taking.',
      'Held: when most of an app’s +EV picks lean the same way, or its prices are new, CrownIQ keeps them out of Top Picks and Gen and lists them under Held, with the reason. Play them on your own judgment.'] },
  { key: 'results', icon: 'chart-bar', title: 'Results', when: 'See what is hitting', open: '/(tabs)/results', openLabel: 'Open Results',
    points: ['Switch between GKR Picks, Your Picks and Edge Picks.', 'Pick 7 days, 30 days or all time.', 'Your own calls are graded too, kept apart from GKR’s record.',
      'GKR’s record counts one pick per player, stat, game and side, so a line that moves doesn’t count twice.'] },
  { key: 'filter', icon: 'tune-variant', title: 'The filter', when: 'Narrow any list in a few taps',
    points: ['Tap the Filter bar at the top of a list.', '1. Sport  2. Games (teams and start time)  3. Stat. Pick as many as you like in each.',
      'Pick a game and the best pick for that game shows right under the filter.', 'Tap Clear to see everything again.'] },
  { key: 'words', icon: 'book-open-variant', title: 'Words you will see', when: 'GKR, Edge, +EV and more',
    points: ['GKR: CrownIQ’s score for a side, 0–100. 80+ makes Top Picks.', 'GKR 2 (Beta): a newer GKR built from box scores, the opponent and game script. Still calibrating; use at your own risk.', 'Edge: how far the chance to hit is above what the payout needs.',
      'Break-even: the chance each pick needs for the entry to pay back over time.', '+EV: expected to return more than it costs.',
      'Scout: an AI research read where GKR can’t score. History: how often the player cleared this number.',
      'Goblin / Demon: PrizePicks easier or harder lines that pay less or more. More only.', 'PASS: no side is worth playing.'] },
  { key: 'more', icon: 'menu', title: 'More and Social', when: 'Settings, language, payouts, feedback',
    points: ['Board view: Lite (top picks) or Full (every play).', 'Payout estimates: each app’s payout chart.', 'Updates and Beta feedback: what changed, and report a problem.',
      'Language · Idioma: English or Español.', 'Social: the Top 10 members and public Crowns.'] },
];

/** How to use CrownIQ, tab by tab: tap a topic to open it. */
export default function Guide() {
  const [open, setOpen] = useState<string | null>('start');
  const trial = useTrial();
  if (trial) return <Screen eyebrow="MORE  /  GUIDE" title="How to use CrownIQ">
    <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>← Back</Text></Pressable>
    <Text style={styles.intro}>The full guide comes with membership. During your trial, open any pick to see its score and result.</Text>
  </Screen>;
  return <Screen eyebrow="MORE  /  GUIDE" title="How to use CrownIQ">
    <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>← Back</Text></Pressable>
    <Text style={styles.intro}>CrownIQ tells you which way to go on a pick, and why. Tap a topic to see what it does.</Text>
    {topics.map((topic) => { const on = open === topic.key;
      return <View key={topic.key} style={[styles.card, on && styles.cardOn]}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: on }} onPress={() => setOpen(on ? null : topic.key)} style={styles.head}>
          <Icon name={topic.icon} size={22} color={on ? colors.mint : colors.textMuted} />
          <View style={styles.grow}><Text style={styles.title}>{topic.title}</Text><Text style={styles.when}>{topic.when}</Text></View>
          <Icon name={on ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textMuted} />
        </Pressable>
        {on && <View style={styles.body}>
          {topic.points.map((point) => <View key={point} style={styles.point}><Text style={styles.dot}>•</Text><Text style={styles.text}>{point}</Text></View>)}
          {topic.open && <Pressable accessibilityRole="button" onPress={() => router.push(topic.open!)} style={styles.go}>
            <Text style={styles.goText}>{topic.openLabel} →</Text></Pressable>}
        </View>}
      </View>; })}
    <Text style={styles.foot}>All numbers are estimates. Confirm the line in your app before you play. Need help? 1-800-MY-RESET.</Text>
  </Screen>;
}

const styles = StyleSheet.create({
  back: { color: colors.mint, fontSize: 13, fontWeight: '800' },
  intro: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg },
  cardOn: { borderColor: colors.mint },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, minHeight: 56 },
  grow: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 16, fontWeight: '800' },
  when: { color: colors.textMuted, fontSize: 12.5 },
  body: { paddingHorizontal: 14, paddingBottom: 14, gap: 8 },
  point: { flexDirection: 'row', gap: 8 },
  dot: { color: colors.mint, fontSize: 14, lineHeight: 20 },
  text: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 },
  go: { alignSelf: 'flex-start', marginTop: 4, borderWidth: 1, borderColor: colors.mint, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8 },
  goText: { color: colors.mint, fontSize: 13, fontWeight: '800' },
  foot: { color: colors.textFaint, fontSize: 12, lineHeight: 17, textAlign: 'center' },
});
