import { useSyncExternalStore } from 'react';

// The entry amount Edge prices slips at, in dollars (default $10), shared by Top Picks, Gen and the slip. Session only.
let stake = 10;
const listeners = new Set<() => void>();

export const STAKES: readonly number[] = [5, 10, 20, 50, 100];
export const edgeStake = {
  set(value: number) { if (Number.isFinite(value) && value > 0) { stake = Math.min(10_000, Math.round(value * 100) / 100); for (const listener of listeners) listener(); } },
  get: () => stake,
};

export function useEdgeStake(): number {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => stake, () => stake);
}
