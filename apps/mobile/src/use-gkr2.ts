import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAuth } from './auth';
import { useBoard } from './use-board';
import { loadPref, savePref } from './local-store';
import type { Gkr2Read, ModelChoice } from './gkr2';

// The member's model choice (GKR, GKR 2, both), shared by the Board and Top Picks and kept on this device.
let choice: ModelChoice = 'GKR';
const listeners = new Set<() => void>();
let loaded = false;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function setModelChoice(next: ModelChoice) {
  choice = next; listeners.forEach((listener) => listener()); void savePref('model', next);
}
export function useModelChoice(): [ModelChoice, (next: ModelChoice) => void] {
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    void loadPref('model').then((saved) => { if (saved === 'GKR2' || saved === 'BOTH') setModelChoice(saved); });
  }, []);
  return [useSyncExternalStore(subscribe, () => choice), setModelChoice];
}

/** GKR 2's reads on the PrizePicks board (fetched when the choice includes GKR 2), keyed by line id; null until loaded. */
export function useGkr2Reads(enabled: boolean): ReadonlyMap<string, Gkr2Read> | null {
  const { request, demo } = useAuth();
  const { data } = useBoard();
  const builtAt = data?.builtAt ?? null;
  const [state, setState] = useState<{ key: string; reads: ReadonlyMap<string, Gkr2Read> } | null>(null);
  const key = `${builtAt}`;
  useEffect(() => {
    if (!enabled || demo || !builtAt) return;
    let active = true;
    void request('/v1/gkr2/board').then(async (response) => {
      if (!active || !response.ok) return;
      const body = await response.json() as { reads: Record<string, Gkr2Read> };
      setState({ key, reads: new Map(Object.entries(body.reads)) });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [enabled, demo, builtAt, key, request]);
  return enabled ? state?.reads ?? null : null;
}
