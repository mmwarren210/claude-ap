import { useEffect } from 'react';
import { Platform } from 'react-native';
import { apiBaseUrl } from './api-base';
import { appCommit, isOutdated } from './version';

// The web app updates itself (owner, 2026-10-05): a copy saved to the iPhone home screen has no pull-to-refresh, so it
// kept running an old build. Each time CrownIQ opens or comes back to the front, it asks the server which build is live
// and reloads once if this copy is older. Never in the middle of use, and at most once per build (no reload loop).

async function checkAndReload() {
  const base = apiBaseUrl();
  if (!base || !appCommit) return;
  try {
    const response = await fetch(`${base}/v1/version`, { cache: 'no-store' });
    if (!response.ok) return;
    const { commit } = await response.json() as { commit: string | null };
    if (!isOutdated(appCommit, commit)) return;
    const key = 'crowniq-reloaded-for';
    let tried: string | null = null;
    try { tried = window.sessionStorage.getItem(key); } catch { /* storage blocked */ }
    if (tried === commit) return;
    try { window.sessionStorage.setItem(key, commit ?? ''); } catch { /* storage blocked */ }
    window.location.reload();
  } catch { /* offline: try next time */ }
}

export function useAutoUpdate() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    void checkAndReload();
    const onVisible = () => { if (document.visibilityState === 'visible') void checkAndReload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
}
