import { Linking, Platform, Share } from 'react-native';

// Carrying picks into the pick'em apps. None of them publishes a link that pre-fills an entry, so CrownIQ copies the
// picks and opens the app (its universal link opens the installed app on phones).

export type PickApp = 'prizepicks' | 'underdog' | 'pick6';
export const appNames: Readonly<Record<PickApp, string>> = { prizepicks: 'PrizePicks', underdog: 'Underdog',
  pick6: 'DK Pick’em' };
export const appUrls: Readonly<Record<PickApp, string>> = { prizepicks: 'https://app.prizepicks.com/',
  underdog: 'https://underdogfantasy.com/pick-em/higher-lower', pick6: 'https://pick6.draftkings.com/' };

export const sideWord = (app: PickApp, side: 'MORE' | 'LESS') => app === 'underdog' ? side === 'MORE' ? 'Higher' : 'Lower'
  : side === 'MORE' ? 'More' : 'Less';

/** One line per pick, the way the app shows it: "DJ Moore · Receiving Yards 58.5 · Higher". */
export function slipText(app: PickApp, picks: readonly { player: string; stat: string; line: number; side: 'MORE' | 'LESS' }[]) {
  return [`My ${appNames[app]} picks (from CrownIQ):`,
    ...picks.map((pick, index) => `${index + 1}. ${pick.player} · ${pick.stat} ${pick.line} · ${sideWord(app, pick.side)}`),
    'Check each line in the app before you play. Play responsibly.'].join('\n');
}

/**
 * Copies the picks (the clipboard on web, the share sheet on phones, where "Copy" is one tap) and opens the app.
 * Returns how the picks were handed over, for the message on screen.
 */
export async function copyAndOpen(app: PickApp, text: string): Promise<'copied' | 'shared'> {
  return copyAndOpenUrl(appUrls[app], text);
}

/** The same for any app or site (the sportsbooks and prediction markets). */
export async function copyAndOpenUrl(url: string, text: string): Promise<'copied' | 'shared'> {
  let how: 'copied' | 'shared' = 'shared';
  const clipboard = Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard) { await clipboard.writeText(text); how = 'copied'; }
  else await Share.share({ message: text });
  await Linking.openURL(url);
  return how;
}
