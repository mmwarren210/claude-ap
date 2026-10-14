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

/**
 * GKR 2's reads on the PrizePicks board, keyed by line id, and Edge's side on each line GKR plays Less (the Board and Top Picks
 * hold a GKR Less back unless GKR 2 or Edge agrees). Null until loaded.
 */
export function useGkr2Board(): { reads: ReadonlyMap<string, Gkr2Read>; edgeSides: ReadonlyMap<string, 'MORE' | 'LESS'> } | null {
  const { request, demo } = useAuth();
  const { data } = useBoard();
  const builtAt = data?.builtAt ?? null;
  const [state, setState] = useState<{ reads: ReadonlyMap<string, Gkr2Read>; edgeSides: ReadonlyMap<string, 'MORE' | 'LESS'> } | null>(null);
  useEffect(() => {
    if (demo || !builtAt) return;
    let active = true;
    void request('/v1/gkr2/board').then(async (response) => {
      if (!active || !response.ok) return;
      const body = await response.json() as { reads: Record<string, Gkr2Read>; edgeSides?: Record<string, 'MORE' | 'LESS'> };
      setState({ reads: new Map(Object.entries(body.reads)), edgeSides: new Map(Object.entries(body.edgeSides ?? {})) });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [demo, builtAt, request]);
  return state;
}

/** GKR 2's reads alone (the Board's and Top Picks' model choice). */
export function useGkr2Reads(enabled: boolean): ReadonlyMap<string, Gkr2Read> | null {
  const board = useGkr2Board();
  return enabled ? board?.reads ?? null : null;
}

/** The side each PrizePicks line's game script favors (the "Game script agrees" badge), keyed by line id. */
export function useScriptLeans(): ReadonlyMap<string, 'MORE' | 'LESS'> | null {
  const { request, demo } = useAuth();
  const { data } = useBoard();
  const builtAt = data?.builtAt ?? null;
  const [leans, setLeans] = useState<ReadonlyMap<string, 'MORE' | 'LESS'> | null>(null);
  useEffect(() => {
    if (demo || !builtAt) return;
    let active = true;
    void request('/v1/script-leans').then(async (response) => {
      if (!active || !response.ok) return;
      setLeans(new Map(Object.entries((await response.json() as { leans: Record<string, 'MORE' | 'LESS'> }).leans)));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [demo, builtAt, request]);
  return leans;
}
