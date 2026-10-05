import { useEffect, useState } from 'react';
import { useAuth } from './auth';

/** A free History Read: the player's recent results against the line (plus the books where priced). Never a GKR score. */
export type HistoryRead = { direction: 'MORE' | 'LESS' | 'PASS'; score: number | null; over: number; under: number;
  games: number; average: number; books: number | null; text: string; source: string;
  /** A weaker side (55-59%): shown as a lean. */
  lean?: boolean };

// One shared copy, refreshed at most every 10 minutes.
let cache: { at: number; value: Map<string, HistoryRead> } | null = null;
let inflight: Promise<Map<string, HistoryRead>> | null = null;

function load(request: (path: string) => Promise<Response>) {
  if (cache && Date.now() - cache.at < 10 * 60_000) return Promise.resolve(cache.value);
  inflight ??= request('/v1/history-reads')
    .then(async (response) => response.ok ? await response.json() as { reads?: Record<string, HistoryRead> } : {})
    .then((body) => { cache = { at: Date.now(), value: new Map(Object.entries(body.reads ?? {})) }; return cache.value; })
    .catch(() => cache?.value ?? new Map<string, HistoryRead>())
    .finally(() => { inflight = null; });
  return inflight;
}

/** History Reads by PrizePicks line id, or null until loaded (and in demo mode). */
export function useHistoryReads(): Map<string, HistoryRead> | null {
  const { request, demo, profile } = useAuth();
  const [value, setValue] = useState<Map<string, HistoryRead> | null>(cache?.value ?? null);
  useEffect(() => {
    if (demo || !profile) return;
    let active = true;
    void load(request).then((reads) => { if (active) setValue(reads); });
    return () => { active = false; };
  }, [request, demo, profile]);
  return demo ? null : value;
}

/** A History Read that picks a side. */
export const historyPlay = (read: HistoryRead | undefined | null) => !!read && read.direction !== 'PASS' && read.score !== null;
