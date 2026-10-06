import { useSyncExternalStore } from 'react';

// The entry type (Power / Flex / Parlay) chosen in Gen or the slip, shared so both agree. Session only.
export type EdgeEntryType = 'POWER' | 'FLEX' | 'PARLAY';
let type: EdgeEntryType = 'POWER';
const listeners = new Set<() => void>();

export const edgeEntryType = {
  set(value: EdgeEntryType) { type = value; for (const listener of listeners) listener(); },
  get: () => type,
};

export function useEdgeEntryType(): EdgeEntryType {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => type, () => type);
}
