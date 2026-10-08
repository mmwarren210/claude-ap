import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAuth } from './auth';
import { useIsOwner } from './use-owner';

// GKR+ access: the owner, or an account unlocked with the Secrets password (More tab). An unlock bumps the version so the
// tab bar and the GKR+ screen ask again at once.
let version = 0;
const listeners = new Set<() => void>();
export const gkrPlusAccess = { changed() { version++; for (const listener of listeners) listener(); } };

export function useGkrPlusAccess(): boolean {
  const owner = useIsOwner();
  const { request, profile, demo } = useAuth();
  const current = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => version, () => version);
  const id = demo ? null : profile?.publicId ?? null;
  const [answer, setAnswer] = useState<{ key: string; open: boolean } | null>(null);
  const key = `${id}|${current}`;
  useEffect(() => {
    if (!id || owner) return;
    let active = true;
    void request('/v1/secrets').then(async (response) => response.ok ? (await response.json() as { gkrPlus?: boolean }).gkrPlus === true : false)
      .then((open) => { if (active) setAnswer({ key, open }); }).catch(() => undefined);
    return () => { active = false; };
  }, [id, owner, request, key]);
  return owner || (!!id && answer?.key === key && answer.open);
}
