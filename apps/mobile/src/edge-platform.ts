import type { EdgePlatform } from '@crowniq/contracts';
import { useSyncExternalStore } from 'react';
import { edgeSlip } from './edge-slip';

// The platform the Edge tab shows (PrizePicks by default). A slip holds one platform's legs, so switching clears it.
let platform: EdgePlatform = 'prizepicks';
const listeners = new Set<() => void>();

export const EDGE_PLATFORMS: readonly { value: EdgePlatform; label: string; short: string }[] = [
  { value: 'prizepicks', label: 'PrizePicks', short: 'PP' }, { value: 'underdog', label: 'Underdog', short: 'UD' },
  { value: 'pick6', label: 'DK Pick’em', short: 'P6' }, { value: 'draftkings', label: 'DraftKings', short: 'DK' },
  { value: 'hardrock', label: 'Hard Rock', short: 'HR' }];
export const platformShort = (value: EdgePlatform) => EDGE_PLATFORMS.find((item) => item.value === value)?.short ?? 'PP';
export const platformLabel = (value: EdgePlatform) => EDGE_PLATFORMS.find((item) => item.value === value)?.label ?? 'PrizePicks';
export const isBook = (value: EdgePlatform) => value === 'draftkings' || value === 'hardrock';

export const edgePlatform = {
  set(next: EdgePlatform) { if (next === platform) return; platform = next; edgeSlip.clear(); for (const listener of listeners) listener(); },
  get: () => platform,
};

export function useEdgePlatform(): EdgePlatform {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => platform, () => platform);
}
