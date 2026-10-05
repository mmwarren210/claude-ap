import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAuth } from './auth';
import type { BetaRead, Model } from './beta';

// Which model a lifetime member is using (GKR or GKR Beta), kept on this device, and the Beta reads from the server.

const KEY = 'crowniq-model';
let model: Model = (() => {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'BETA' ? 'BETA' : 'GKR'; } catch { return 'GKR'; }
})();
const listeners = new Set<() => void>();
export function setModel(next: Model) {
  model = next;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, next); } catch { /* this device only */ }
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

let cache: { at: number; builtAt: string | null; value: Map<string, BetaRead> } | null = null;
let inflight: Promise<Map<string, BetaRead>> | null = null;

/**
 * The model in use and the Beta reads. Only lifetime members can choose Beta; everyone else always gets GKR. Beta reads
 * reload when the board is rebuilt, and at most every 5 minutes otherwise.
 */
export function useModel(builtAt?: string | null): { model: Model; canUseBeta: boolean; beta: Map<string, BetaRead> | null;
  setModel: (next: Model) => void } {
  const { profile, request, demo } = useAuth();
  const chosen = useSyncExternalStore(subscribe, () => model, () => model);
  const canUseBeta = !demo && profile?.plan === 'LIFETIME';
  const [beta, setBeta] = useState<Map<string, BetaRead> | null>(cache?.value ?? null);
  useEffect(() => {
    if (!canUseBeta) return;
    let active = true;
    const fresh = cache && cache.builtAt === (builtAt ?? cache.builtAt) && Date.now() - cache.at < 5 * 60_000;
    const load = fresh ? Promise.resolve(cache!.value) : inflight ??= request('/v1/beta')
      .then(async (response) => response.ok ? await response.json() as { builtAt: string; lines: Record<string, BetaRead> } : null)
      .then((body) => {
        const value = new Map(Object.entries(body?.lines ?? {}));
        cache = { at: Date.now(), builtAt: body?.builtAt ?? null, value };
        return value;
      })
      .catch(() => cache?.value ?? new Map<string, BetaRead>())
      .finally(() => { inflight = null; });
    void load.then((value) => { if (active) setBeta(value); });
    return () => { active = false; };
  }, [canUseBeta, builtAt, request]);
  return { model: canUseBeta ? chosen : 'GKR', canUseBeta, beta: canUseBeta ? beta : null, setModel };
}
