import { edgeBoardResponseSchema } from '@crowniq/contracts';
import type { EdgeBoardResponse } from '@crowniq/contracts';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth';
import { reportMobileFailure } from './diagnostics';
import { useEdgePlatform } from './edge-platform';

export type EdgeView = 'edges' | 'alternates';
type EdgeState = { status: 'loading' | 'available' | 'unavailable'; data: EdgeBoardResponse | null; message: string };

/** Reads the server's saved Edge pricing. Opening or refreshing never pulls odds. */
export function useEdge(view: EdgeView, source: 'edge' | 'gkr-plus' = 'edge', day: 'all' | 'today' = 'all', query = '', slipSport: string | null = null): EdgeState & { retry: () => void } {
  const q = query.trim().length >= 2 ? query.trim() : '';
  const { request } = useAuth();
  const platform = useEdgePlatform();
  const [attempt, setAttempt] = useState(0);
  const [focused, setFocused] = useState(false);
  const requestKey = JSON.stringify([platform, view, attempt, source, day, q, slipSport]);
  const [state, setState] = useState<EdgeState & { requestKey: string; view?: string }>({ status: 'loading', data: null, message: '', requestKey: '' });
  useFocusEffect(useCallback(() => {
    setFocused(true); setAttempt((value) => value + 1);
    const timer = setInterval(() => setAttempt((value) => value + 1), 60_000);
    return () => { setFocused(false); clearInterval(timer); };
  }, [setFocused, setAttempt]));
  useEffect(() => {
    if (!focused) return;
    let active = true; const controller = new AbortController();
    void (async () => {
      try {
        // GKR+ (owner only) answers in the same shape as Edge, from its own route.
        // The sport chips: best entries from that sport's picks only.
        const search = (q ? `&q=${encodeURIComponent(q)}` : '') + (slipSport ? `&slipSport=${encodeURIComponent(slipSport)}` : '');
        const path = source === 'gkr-plus' ? `/v1/owner/gkr-plus?platform=${platform}&limit=300&day=${day}${search}`
          : `/v1/edge?platform=${platform}&view=${view}&limit=300&day=${day}${search}`;
        const response = await request(path, { signal: controller.signal });
        if (!active) return;
        if (!response.ok) {
          setState({ status: 'unavailable', data: null, requestKey,
            message: response.status === 503 ? 'Edge is waiting for a saved board.' : 'Could not load Edge picks.' });
          return;
        }
        const data = edgeBoardResponseSchema.parse(await response.json());
        if (active) setState({ status: 'available', data, message: '', requestKey, view: `${platform}|${view}|${source}|${day}|${q}|${slipSport}` });
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        reportMobileFailure('edge', error);
        setState({ status: 'unavailable', data: null, requestKey,
          message: error instanceof Error ? error.message : 'Could not load Edge picks.' });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [request, requestKey, focused, view, platform, source, day, q, slipSport]);
  // Keep showing the previous data while a background refresh is in flight.
  // A new sport chip only changes the best entries, so the page stays up while they load.
  const base = `${platform}|${view}|${source}|${day}|${q}|`;
  const visible = state.requestKey === requestKey || (state.data && state.view?.startsWith(base)) ? state : { status: 'loading' as const, data: null, message: '' };
  return { status: visible.status, data: visible.data, message: visible.message, retry: () => setAttempt((value) => value + 1) };
}
