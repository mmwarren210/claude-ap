import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { formatLine, marketLabel } from '../insights';
import { appNames, copyAndOpen, sideWord, slipText } from '../port';
import type { PickApp } from '../port';
import type { CrownLeg } from '../state';
import { colors, radius } from '../theme';
import { Sheet } from './Sheet';
import { GhostButton, PrimaryButton } from './ui/Controls';

type Ported = { lineId: string; direction: 'MORE' | 'LESS'; sideOffered: boolean; comparison: 'SAME' | 'BETTER' | 'WORSE' | null;
  match: { id: string; stat: string; threshold: number } | null };

const comparisonText = { SAME: 'Same line', BETTER: 'Easier here', WORSE: 'Harder here' } as const;
const comparisonColor = { SAME: colors.textMuted, BETTER: colors.mint, WORSE: colors.gold } as const;

/**
 * "Play it on" for a Crown: PrizePicks gets the picks copied and the app opened; Underdog and Pick6 first find each
 * pick's line on that app, show whether its number is easier or harder for the side picked, and can save the result as
 * that app's slip (graded with Your Picks).
 */
export function PortSheet({ app, legs, onClose }: { app: PickApp | null; legs: readonly CrownLeg[]; onClose: () => void }) {
  const { request, demo } = useAuth();
  const [ported, setPorted] = useState<Ported[] | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!app || app === 'prizepicks') return;
    let active = true;
    if (demo) {
      void Promise.resolve().then(() => { if (active) setMessage(`Sign in to match these picks to ${appNames[app]} lines.`); });
      return () => { active = false; };
    }
    void (async () => {
      try {
        const response = await request(`/v1/apps/${app}/port`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ legs: legs.map((leg) => ({ lineId: leg.line.id, direction: leg.direction })) }) });
        if (!response.ok) throw new Error('unavailable');
        const body = await response.json() as { legs: Ported[] };
        if (active) setPorted(body.legs);
      } catch { if (active) setMessage(`Could not check ${appNames[app]} lines right now. Try again in a moment.`); }
    })();
    return () => { active = false; };
  }, [app, legs, request, demo]);
  if (!app) return null;

  const close = () => { setPorted(null); setMessage(''); onClose(); };
  const playable = (ported ?? []).filter((leg) => leg.match && leg.sideOffered);
  const picks = app === 'prizepicks'
    ? legs.map((leg) => ({ player: leg.line.playerName, stat: marketLabel(leg.line.market), line: leg.line.threshold, side: leg.direction }))
    : playable.map((leg) => ({ player: legs.find((item) => item.line.id === leg.lineId)!.line.playerName, stat: leg.match!.stat,
      line: leg.match!.threshold, side: leg.direction }));
  const open = async () => {
    try {
      const how = await copyAndOpen(app, slipText(app, picks));
      setMessage(how === 'copied' ? `Picks copied. Paste them anywhere, and find each player in ${appNames[app]}.`
        : `Tap Copy in the share sheet, then find each player in ${appNames[app]}.`);
    } catch { setMessage(`Could not open ${appNames[app]}.`); }
  };
  const saveSlip = async () => {
    try {
      const response = await request('/v1/me/crowns', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app, personal: true, lineIds: playable.map((leg) => leg.match!.id),
          directions: Object.fromEntries(playable.map((leg) => [leg.match!.id, leg.direction])) }) });
      setMessage(response.ok ? `Saved as a ${appNames[app]} slip in Your Picks. It’s graded once the games finish.`
        : 'Could not save this slip. A line may have moved or started.');
    } catch { setMessage('Could not reach CrownIQ. Try again.'); }
  };

  return <Sheet visible title={`Play it on ${appNames[app]}`} onClose={close}>
    {app === 'prizepicks' ? <Text style={styles.text}>These are PrizePicks lines already. CrownIQ copies your picks and
      opens PrizePicks; find each player there and pick the same side.</Text>
      : !ported && !message ? <Text style={styles.text}>Finding these players on {appNames[app]}…</Text>
        : ported && <View style={styles.list}>
          {ported.map((leg) => {
            const source = legs.find((item) => item.line.id === leg.lineId)!.line;
            return <View key={leg.lineId} style={styles.row}>
              <View style={styles.grow}><Text style={styles.name} numberOfLines={1}>{source.playerName}</Text>
                <Text style={styles.detail}>{leg.match ? `${leg.match.stat} ${formatLine(leg.match.threshold)} · ${sideWord(app, leg.direction)}`
                  : `${marketLabel(source.market)} not offered on ${appNames[app]}`}</Text></View>
              <Text style={[styles.tag, { color: !leg.match || !leg.sideOffered ? colors.red
                : comparisonColor[leg.comparison ?? 'SAME'] }]}>
                {!leg.match ? 'Not listed' : !leg.sideOffered ? `No ${sideWord(app, leg.direction)}`
                  : `${comparisonText[leg.comparison ?? 'SAME']}${leg.comparison === 'SAME' ? ''
                    : ` (PrizePicks ${formatLine(source.threshold)})`}`}</Text>
            </View>;
          })}
          <Text style={styles.text}>{playable.length} of {legs.length} picks can be played on {appNames[app]}. Lines and payouts
            there are {appNames[app]}’s own; GKR scores the PrizePicks lines.</Text>
        </View>}
    {!!message && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
    {(app === 'prizepicks' || playable.length > 0) && <PrimaryButton label={`Copy picks & open ${appNames[app]}`}
      icon="open-in-new" onPress={() => void open()} />}
    {app !== 'prizepicks' && playable.length >= 2 && <GhostButton label={`Save as ${appNames[app]} slip`} icon="content-save-outline"
      onPress={() => void saveSlip()} />}
  </Sheet>;
}

const styles = StyleSheet.create({
  text: { color: colors.textMuted, fontSize: 13.5, lineHeight: 19 },
  message: { color: colors.gold, fontSize: 13, fontWeight: '600' },
  list: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.border },
  grow: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 15, fontWeight: '800' },
  detail: { color: colors.textMuted, fontSize: 12.5 },
  tag: { fontSize: 12, fontWeight: '800', textAlign: 'right', maxWidth: 140 },
});
