import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';
import { useAuth } from '../../auth';
import { Notice, Screen } from '../../components/Screen';
import { marketLabel } from '../../insights';
import { openExternal } from '../../port';
import { colors } from '../../theme';

// Evidence page (owner, 2026-10-12): everything one GKR pick stood on — the model's read, each input with its source and
// link, and the player's games behind it so any box score can confirm them. Opened from a player page (a live line) or the
// spot-check list (a saved pick, as it was when saved).

type Row = { kind: string; finding: string; value: number | null; reference: number | null; unit: string | null; source: string;
  sourceUrl: string | null; retrievedAt: string; quality: string };
type Factor = { name: string; contribution: number; weight: number | null; observed: number | null; reference: number | null; measured: boolean | null };
type Gkr = { direction: string; score: number | null; scoreBand: string; modelVersion: string | null; reasonCode: string | null;
  thresholdCushion: number | null; factors: Factor[]; adjustments: { name: string; contribution: number; explanation: string }[] } | null;
type GameRow = { date: string; matchup: string | null; value: number | null };
type Evidence = {
  line?: { playerName: string; team: string | null; opponent: string | null; sport: string; market: string; threshold: number; lineType: string;
    eventName: string; eventStartTime: string };
  pick?: { playerName: string; team: string | null; opponent: string | null; sport: string; market: string; exactLine: number; direction: string;
    lineType: string; lineScore: number; modelVersion: string; eventStartTime: string; createdAt: string; grade: string; actualResult: number | null;
    resultSource: string | null; resultSourceUrl: string | null };
  gkr: Gkr; evidence: Row[]; games: GameRow[];
  edge?: { side: string; probability: number; breakEven: number; edge: number | null; projection: number; reasons: string[] } | null;
  mlb?: { game: { venue: string | null; temperatureF: number | null; homePitcher: string | null; awayPitcher: string | null } | null;
    h2h: { kind: string; against: string; games: number; average: number; overall: number; factor: number } | null } | null;
  profile?: { position: string | null; bats: string | null; throws: string | null; team: string | null } | null;
};

const words = (value: string) => value.replace(/^(metric|projection|status|risk):/, '').replace(/_/g, ' ');
const num = (value: number | null | undefined, digits = 2) => value === null || value === undefined ? '—' : String(Math.round(value * 10 ** digits) / 10 ** digits);

export default function EvidenceScreen() {
  const { line, pick } = useLocalSearchParams<{ line?: string; pick?: string }>();
  const { request } = useAuth();
  const [data, setData] = useState<{ key: string; value: Evidence | null; error: string | null } | null>(null);
  const key = line ? `line:${line}` : pick ? `pick:${pick}` : '';
  useEffect(() => {
    if (!key) return;
    let active = true;
    const path = line ? `/v1/owner/evidence/line/${encodeURIComponent(line)}` : `/v1/owner/evidence/pick/${encodeURIComponent(pick!)}`;
    void request(path).then(async (response) => {
      if (!active) return;
      setData(response.ok ? { key, value: await response.json() as Evidence, error: null }
        : { key, value: null, error: response.status === 404 ? 'Not found (or not the owner).' : `Couldn't load (${response.status}).` });
    }).catch(() => { if (active) setData({ key, value: null, error: 'Couldn\'t load.' }); });
    return () => { active = false; };
  }, [key, line, pick, request]);
  const current = data?.key === key ? data : null;
  const value = current?.value ?? null;
  const head = value?.pick ?? value?.line;
  return <Screen eyebrow="OWNER  /  EVIDENCE" title={head ? head.playerName : 'Evidence'}>
    <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>← Back</Text></Pressable>
    {!current ? <ActivityIndicator color={colors.mint} /> : current.error ? <Notice title={current.error} detail="" /> : value ? <>
      {value.pick ? <View style={styles.card}>
        <Text style={styles.title}>{marketLabel(value.pick.market)} · {value.pick.direction} {value.pick.exactLine} ({value.pick.lineType.toLowerCase()})</Text>
        <Text style={styles.muted}>{value.pick.sport} · {value.pick.team ?? '—'} vs {value.pick.opponent ?? '—'} · game {value.pick.eventStartTime.slice(0, 16).replace('T', ' ')} UTC</Text>
        <Text style={styles.muted}>Saved {value.pick.createdAt.slice(0, 16).replace('T', ' ')} UTC · GKR {num(value.pick.lineScore, 1)} · {value.pick.modelVersion}</Text>
        <Text style={styles.result}>Result: {value.pick.grade}{value.pick.actualResult !== null ? ` (actual ${value.pick.actualResult})` : ''}</Text>
        {value.pick.resultSourceUrl ? <Link url={value.pick.resultSourceUrl} label={value.pick.resultSource ?? 'Result source'} /> : null}
      </View> : value.line ? <View style={styles.card}>
        <Text style={styles.title}>{marketLabel(value.line.market)} · {value.line.threshold} ({value.line.lineType.toLowerCase()})</Text>
        <Text style={styles.muted}>{value.line.eventName} · {value.line.eventStartTime.slice(0, 16).replace('T', ' ')} UTC</Text>
        {value.profile ? <Text style={styles.muted}>{[value.profile.team, value.profile.position, value.profile.bats ? `bats ${value.profile.bats}` : null,
          value.profile.throws ? `throws ${value.profile.throws}` : null].filter(Boolean).join(' · ')}</Text> : null}
      </View> : null}

      <Text style={styles.section}>GKR’s read</Text>
      {value.gkr ? <View style={styles.card}>
        <Text style={styles.title}>{value.gkr.direction}{value.gkr.score !== null ? ` · ${num(value.gkr.score, 1)}` : ''}{value.gkr.reasonCode ? ` · ${words(value.gkr.reasonCode).toLowerCase()}` : ''}</Text>
        <Text style={styles.muted}>{value.gkr.modelVersion ?? 'no model'} · cushion {num(value.gkr.thresholdCushion)} spreads</Text>
        {value.gkr.factors.map((factor) => <Text key={factor.name} style={styles.row}>
          {words(factor.name)}: {factor.measured === false ? 'no data (counts zero)' : `${num(factor.observed)} vs ${num(factor.reference)}`} → {num(factor.contribution, 1)}{factor.weight !== null ? ` of ${factor.weight}` : ''}</Text>)}
        {value.gkr.adjustments.map((item) => <Text key={item.name} style={styles.row}>{words(item.name)} {item.contribution > 0 ? '+' : ''}{num(item.contribution, 1)} · {item.explanation}</Text>)}
      </View> : <Notice title="GKR didn't read this line." detail="" />}

      {value.edge ? <><Text style={styles.section}>Edge’s read</Text><View style={styles.card}>
        <Text style={styles.title}>{value.edge.side} · {Math.round(value.edge.probability * 1000) / 10}% vs {Math.round(value.edge.breakEven * 1000) / 10}% to break even · projection {num(value.edge.projection)}</Text>
        {value.edge.reasons.map((reason, index) => <Text key={index} style={styles.row}>• {reason}</Text>)}
      </View></> : null}

      {value.mlb?.game ? <><Text style={styles.section}>Game context (MLB)</Text><View style={styles.card}>
        <Text style={styles.row}>Starters: {value.mlb.game.awayPitcher ?? '—'} (away) · {value.mlb.game.homePitcher ?? '—'} (home)</Text>
        <Text style={styles.row}>{value.mlb.game.venue ?? 'Park unknown'}{value.mlb.game.temperatureF !== null ? ` · ${Math.round(value.mlb.game.temperatureF)}°F` : ''}</Text>
        {value.mlb.h2h ? <Text style={styles.row}>Head-to-head vs {value.mlb.h2h.against}{value.mlb.h2h.kind === 'starter' ? ' (starting)' : ''}: {num(value.mlb.h2h.average)} a game in {value.mlb.h2h.games} games (vs {num(value.mlb.h2h.overall)}) → ×{num(value.mlb.h2h.factor)}</Text> : null}
      </View></> : null}

      <Text style={styles.section}>Inputs ({value.evidence.length})</Text>
      {value.evidence.length ? value.evidence.map((row, index) => <View key={index} style={styles.card}>
        <Text style={styles.title}>{words(row.kind)}{row.value !== null ? `: ${num(row.value)}${row.reference !== null ? ` (vs ${num(row.reference)})` : ''}` : ''}</Text>
        <Text style={styles.row}>{row.finding}</Text>
        <Text style={styles.muted}>{row.source} · {row.quality.toLowerCase()} · {row.retrievedAt.slice(0, 16).replace('T', ' ')} UTC</Text>
        {row.sourceUrl ? <Link url={row.sourceUrl} label={row.sourceUrl} /> : <Text style={styles.muted}>No public link for this input.</Text>}
      </View>) : <Notice title="No inputs recorded." detail="" />}

      <Text style={styles.section}>Games behind it (newest first)</Text>
      <Text style={styles.muted}>Check any of these against a box score (ESPN, Baseball/Pro-Football-Reference).</Text>
      {value.games.length ? <View style={styles.card}>{value.games.map((game) => <Text key={game.date + (game.matchup ?? '')} style={styles.row}>
        {game.date} · {game.matchup ?? '—'} · {game.value ?? '—'}</Text>)}</View> : <Notice title="No saved games for this player." detail="" />}
    </> : null}
  </Screen>;
}

function Link({ url, label }: { url: string; label: string }) {
  return <Pressable accessibilityRole="link" onPress={() => openExternal(url)}><Text style={styles.link} numberOfLines={1}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  back: { color: colors.mint, fontWeight: '700', marginBottom: 6 },
  section: { color: colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 1, marginTop: 16, marginBottom: 6, textTransform: 'uppercase' },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginBottom: 8, padding: 12, gap: 4 },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  row: { color: colors.text, fontSize: 13, lineHeight: 18 },
  muted: { color: colors.textMuted, fontSize: 12 },
  result: { color: colors.gold, fontSize: 14, fontWeight: '700', marginTop: 4 },
  link: { color: colors.mint, fontSize: 12, textDecorationLine: 'underline' },
});
