import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { colors, radius } from '../theme';

// What to trust and what to skip on each tab and view (owner, 2026-10-14: "lil notes when they're clicked on so they know
// trust these and why, or don't play these and why"). One short box at the top of the view, never a wall of text.

export type TrustKey =
  | 'board' | 'board-gkr2' | 'board-both' | 'app-board'
  | 'top-all' | 'top-gkr' | 'top-gkr2' | 'top-app' | 'top-ev'
  | 'vetted' | 'crown' | 'results'
  | 'edge-top' | 'edge-alts' | 'edge-gen'
  | 'edge-board-rank' | 'edge-board-start' | 'edge-board-edge' | 'edge-board-probability' | 'edge-board-no-read'
  | 'streaks' | 'ladders';

export const TRUST: Readonly<Record<TrustKey, { trust: string; careful: string }>> = {
  board: { trust: 'GKR scores of 80+ (PLAY, STRONG, ELITE) with several edges lining up.',
    careful: 'Scores under 80, red risk notes (role change, injury), and lines near game time: confirm the number in the app first.' },
  'board-gkr2': { trust: 'GKR 2 plays that GKR also likes (switch to Both to see).',
    careful: 'GKR 2 is in Beta and still calibrating. Its picks alone are at your own risk.' },
  'board-both': { trust: 'Cards where GKR and GKR 2 agree: two models, same side.',
    careful: 'Cards where GKR 2 takes the other side or only GKR 2 plays (Beta). Read the why line before playing.' },
  'app-board': { trust: 'Lines with a GKR score at this app’s own number, and boosts on GKR’s side.',
    careful: 'Lines with no GKR score: that’s a price, not a pick.' },
  'top-all': { trust: 'The top of the list: the strongest picks from every app, ranked together.',
    careful: 'Picks lower down are weaker; each card says which model backs it.' },
  'top-gkr': { trust: 'GKR’s top picks (80+), the strongest PrizePicks plays.',
    careful: 'The 2nd Look list (68–79) needs a look at the evidence first.' },
  'top-gkr2': { trust: 'GKR 2 picks GKR also ranks.',
    careful: 'GKR 2 is in Beta and still calibrating: use its list at your own risk.' },
  'top-app': { trust: 'Picks backed by GKR or by sportsbook prices at this app’s number.',
    careful: 'History-only and Value picks: one source, so smaller plays.' },
  'top-ev': { trust: 'Lines several sportsbooks agree beat the break-even.',
    careful: 'A thin edge (a point or two) can vanish if the line moves; recheck before playing.' },
  vetted: { trust: 'Picks approved by two (“Confirmed by both”) or with Edge ✓.',
    careful: 'An outside tipster’s pick approved by one check only. Live picks have started; don’t chase them.' },
  crown: { trust: 'Legs from different games, each backed by a model.',
    careful: 'Several legs from one game rise and fall together, and bigger entries miss more often.' },
  results: { trust: 'Records with hundreds of graded picks.',
    careful: 'A hot or cold streak over a few dozen picks can be luck.' },
  'edge-top': { trust: 'ELITE and STRONG picks, best when “Sharp” or “Market” (sportsbooks price them) or a stats read over 15+ games.',
    careful: 'STATS MODEL reads over under 10 games, and 0.5 lines at very high chances: small samples look surer than they are.' },
  'edge-alts': { trust: 'Goblins with a high chance and a payout factor that clears the number shown.',
    careful: 'Demons: harder lines that miss most of the time. Only for a small slice of an entry.' },
  'edge-gen': { trust: 'Entries built from rated picks across different games.',
    careful: 'Big entries: each extra leg cuts the chance it cashes. Mix and match across the tickets.' },
  'edge-board-rank': { trust: 'The top cards: Edge’s own order (rating, price source and freshness).',
    careful: 'NO EDGE cards anywhere in the list: Edge is holding them back.' },
  'edge-board-start': { trust: 'Use it to find a game. The rating on each card still decides.',
    careful: 'This order mixes good and bad: NO EDGE cards and Demons (the 1–18% ones) aren’t plays.' },
  'edge-board-edge': { trust: 'Rated picks with the biggest gap over the break-even, held picks at the bottom.',
    careful: 'Even here, a stats read over a few games can be a small-sample mirage.' },
  'edge-board-probability': { trust: 'High chances with a rating (VALUE or better).',
    careful: 'A high chance alone isn’t a play: Goblins and NO EDGE picks can show 80–90% and still lose money.' },
  'edge-board-no-read': { trust: 'Nothing here is a pick: Edge has no data for these lines.',
    careful: 'Don’t play a No read line on CrownIQ’s say-so; there isn’t one.' },
  streaks: { trust: 'Picks with “All agree” on: every model on the same side.',
    careful: 'One miss ends a streak; take a pick only when the app pays at least the multiplier shown.' },
  ladders: { trust: 'More picks with “All agree” on, from different games.',
    careful: 'Ladder payouts aren’t in CrownIQ’s data: check them in the app.' },
};

export function TrustNote({ which }: { which: TrustKey }) {
  const note = TRUST[which];
  return <View style={styles.box} accessibilityLabel="What to trust here">
    <Text style={styles.line}><Text style={styles.trust}>✓ Trust: </Text>{note.trust}</Text>
    <Text style={styles.line}><Text style={styles.careful}>⚠ Careful: </Text>{note.careful}</Text>
  </View>;
}

const styles = StyleSheet.create({
  box: { gap: 4, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 9,
    backgroundColor: colors.surface },
  line: { color: colors.textMuted, fontSize: 12.5, lineHeight: 17 },
  trust: { color: colors.mint, fontWeight: '800' },
  careful: { color: colors.amber, fontWeight: '800' },
});
