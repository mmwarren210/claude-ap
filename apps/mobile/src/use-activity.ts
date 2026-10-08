import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useAuth } from './auth';

/** The tab or screen a path belongs to ("/edge/abc" → "edge", "/" → "board"). */
export function tabOf(path: string): string {
  const first = path.split('/').filter(Boolean)[0] ?? '';
  return first === '' || first === 'index' ? 'board' : first;
}

/**
 * Time on the app: while a signed-in member has it open and on screen, one beat a minute with the tab in view (the
 * server counts the minutes for the owner's Member activity). A hidden tab or a backgrounded app sends nothing.
 */
export function useActivityBeat(): void {
  const { request, profile, demo } = useAuth();
  const path = usePathname();
  const tab = useRef('board');
  useEffect(() => { tab.current = tabOf(path); }, [path]);
  const signedIn = !!profile && !demo;
  useEffect(() => {
    if (!signedIn) return;
    const visible = () => Platform.OS === 'web' ? typeof document === 'undefined' || document.visibilityState === 'visible'
      : AppState.currentState === 'active';
    const beat = () => { if (visible()) void request('/v1/activity', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tab: tab.current }) }).catch(() => undefined); };
    beat();
    const timer = setInterval(beat, 60_000);
    return () => clearInterval(timer);
  }, [signedIn, request]);
}
