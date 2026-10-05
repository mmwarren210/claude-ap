import { useCallback, useSyncExternalStore } from 'react';

// Each provider's Crown legs outside PrizePicks (owner, 2026-10-05): the boards add picks here and the Crown tab builds,
// shows and saves them. PrizePicks keeps its own draft (use-draft). Kept for the session; reopening the app starts fresh.

export type CrownProvider = 'underdog' | 'pick6' | 'draftkings' | 'hardrock' | 'kalshi' | 'polymarket';
const legs = new Map<CrownProvider, readonly unknown[]>();
const listeners = new Set<() => void>();
const empty: readonly unknown[] = [];

export function crownLegs<T>(provider: CrownProvider): readonly T[] { return (legs.get(provider) ?? empty) as readonly T[]; }
export function setCrownLegs<T>(provider: CrownProvider, next: readonly T[]) {
  legs.set(provider, next);
  for (const listener of listeners) listener();
}
/** Adds a leg, or removes it when it's already there (same key); `max` caps the Crown. Returns what happened. */
export function toggleCrownLeg<T>(provider: CrownProvider, leg: T, key: (item: T) => string, max = 20): 'added' | 'removed' | 'full' {
  const current = crownLegs<T>(provider);
  if (current.some((item) => key(item) === key(leg))) {
    setCrownLegs(provider, current.filter((item) => key(item) !== key(leg))); return 'removed';
  }
  if (current.length >= max) return 'full';
  setCrownLegs(provider, [...current, leg]);
  return 'added';
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** A provider's Crown legs and a setter; components re-render when any Crown changes. */
export function useCrownLegs<T>(provider: CrownProvider): [readonly T[], (next: readonly T[]) => void] {
  const value = useSyncExternalStore(subscribe, () => crownLegs<T>(provider), () => crownLegs<T>(provider));
  const set = useCallback((next: readonly T[]) => setCrownLegs(provider, next), [provider]);
  return [value, set];
}

/** Which provider the Crown tab opens on (a board's "Open Crown" sets it). */
let opening: CrownProvider | 'prizepicks' = 'prizepicks';
export const crownOpening = () => opening;
export const openCrownOn = (provider: CrownProvider | 'prizepicks') => { opening = provider; };
