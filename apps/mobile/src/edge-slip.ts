import type { EdgePick } from '@crowniq/contracts';
import { useSyncExternalStore } from 'react';
import { toggleSlipLeg } from './edge-format';

// In-memory slip shared by the Edge tab and pick detail; nothing is persisted or submitted.
let legs: EdgePick[] = [];
/** Most legs an entry takes on each platform (PrizePicks 6, Underdog and Pick6 8, DraftKings 8, Hard Rock 20). */
const maxLegs: Readonly<Record<string, number>> = { prizepicks: 6, underdog: 8, pick6: 8, dabble: 12, draftkings: 8, hardrock: 20 };
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export const edgeSlip = {
  toggle(pick: EdgePick) { legs = toggleSlipLeg(legs, pick, maxLegs[pick.platform] ?? 6); emit(); },
  clear() { legs = []; emit(); },
  /** Replace the slip with these legs (from a generated entry). */
  set(next: readonly EdgePick[]) { legs = next.slice(0, maxLegs[next[0]?.platform ?? 'prizepicks'] ?? 6); emit(); },
  remove(lineId: string) { legs = legs.filter((leg) => leg.lineId !== lineId); emit(); },
};

export function useEdgeSlip(): readonly EdgePick[] {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => legs, () => legs);
}
