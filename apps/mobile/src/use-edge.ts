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
export function useEdge(view: EdgeView): EdgeState & { retry: () => void } {
  const { request } = useAuth();
  const platform = useEdgePlatform();
  const [attempt, setAttempt] = useState(0);
  const [focused, setFocused] = useState(false);
  const requestKey = JSON.stringify([platform, view, attempt]);
  const [state, setState] = useState<EdgeState & { requestKey: string; view?: string }>({ status: 'loading', data: null, message: '', requestKey: '' });
  useFocusEffect(useCallback(() => {
    setFocused(true); setAttempt((value) => value + 1);
    const timer = setInterval(() => setAttempt((value) => value + 1), 60_000);
    return () => { setFocused(false); clearInterval(timer); };
  }, []));
  useEffect(() => {
    if (!focused) return;
    let active = true; const controller = new AbortController();
    void (async () => {
      try {
        const response = await request(`/v1/edge?platform=${platform}&view=${view}&limit=300`, { signal: controller.signal });
        if (!active) return;
        if (!response.ok) {
          setState({ status: 'unavailable', data: null, requestKey,
            message: response.status === 503 ? 'Edge is waiting for a saved board.' : 'Could not load Edge picks.' });
          return;
        }
        const data = edgeBoardResponseSchema.parse(await response.json());
        if (active) setState({ status: 'available', data, message: '', requestKey, view: `${platform}|${view}` });
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        reportMobileFailure('edge', error);
        setState({ status: 'unavailable', data: null, requestKey,
          message: error instanceof Error ? error.message : 'Could not load Edge picks.' });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [request, requestKey, focused, view, platform]);
  // Keep showing the previous data while a background refresh is in flight.
  const visible = state.requestKey === requestKey || (state.data && state.view === `${platform}|${view}`) ? state : { status: 'loading' as const, data: null, message: '' };
  return { status: visible.status, data: visible.data, message: visible.message, retry: () => setAttempt((value) => value + 1) };
}
