import type { EdgePick } from '@crowniq/contracts';
import { useSyncExternalStore } from 'react';
import { toggleSlipLeg } from './edge-format';

// In-memory slip shared by the Edge tab and pick detail; nothing is persisted or submitted.
let legs: EdgePick[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export const edgeSlip = {
  toggle(pick: EdgePick) { legs = toggleSlipLeg(legs, pick); emit(); },
  clear() { legs = []; emit(); },
  /** Replace the slip with these legs (from a generated entry). */
  set(next: readonly EdgePick[]) { legs = next.slice(0, 6); emit(); },
  remove(lineId: string) { legs = legs.filter((leg) => leg.lineId !== lineId); emit(); },
};

export function useEdgeSlip(): readonly EdgePick[] {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => legs, () => legs);
}
