/** This copy's build (set at deploy). */
export const appCommit = (process.env.EXPO_PUBLIC_COMMIT ?? '').slice(0, 7) || null;

/** True when the server runs a different build than this copy. */
export function isOutdated(app: string | null, server: string | null) {
  return !!app && !!server && app !== server;
}
