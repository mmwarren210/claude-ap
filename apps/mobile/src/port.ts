import { Linking, Platform, Share } from 'react-native';

// Carrying picks into the pick'em apps. None of them publishes a link that pre-fills an entry, so CrownIQ copies the
// picks and opens the app (its universal link opens the installed app on phones).

export type PickApp = 'prizepicks' | 'underdog' | 'pick6';
export const appNames: Readonly<Record<PickApp, string>> = { prizepicks: 'PrizePicks', underdog: 'Underdog',
  pick6: 'Pick6' };
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

/**
 * Opens an outside site or app. On the web it clicks a real link in the same tap: a home-screen web app on iPhone showed a
 * blank page for window.open(url, '_blank', 'noopener') (what Linking.openURL does), and for any open after an await.
 */
export function openExternal(url: string): void {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    document.body.appendChild(link); link.click(); link.remove();
    return;
  }
  void Linking.openURL(url);
}

/** The same for any app or site (the sportsbooks and prediction markets). */
export async function copyAndOpenUrl(url: string, text: string): Promise<'copied' | 'shared'> {
  const clipboard = Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard) {
    // Copy and open in the same tap: the copy starts first, the site opens before anything is awaited.
    const copied = clipboard.writeText(text);
    openExternal(url);
    await copied.catch(() => undefined);
    return 'copied';
  }
  await Share.share({ message: text });
  openExternal(url);
  return 'shared';
}
