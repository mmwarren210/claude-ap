import { useEffect, useState } from 'react';
import { useAuth } from './auth';

/** The sportsbooks' no-vig view of one standard line (from the server's DraftKings and Hard Rock prices). */
export type BookView = { fairMore: number; books: { book: string; fairMore: number }[] };

// One shared copy for every card, refreshed at most every 10 minutes. Display only; it never changes a GKR score.
let cache: { at: number; value: Map<string, BookView> } | null = null;
let inflight: Promise<Map<string, BookView>> | null = null;

function load(request: (path: string) => Promise<Response>): Promise<Map<string, BookView>> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return Promise.resolve(cache.value);
  inflight ??= request('/v1/books')
    .then(async (response) => response.ok ? await response.json() as { lines?: Record<string, BookView> } : { lines: {} })
    .then((body) => { cache = { at: Date.now(), value: new Map(Object.entries(body.lines ?? {})) }; return cache.value; })
    .catch(() => cache?.value ?? new Map<string, BookView>())
    .finally(() => { inflight = null; });
  return inflight;
}

/** Sportsbook views by line id, or null until loaded (and always null in demo mode). */
export function useBooks(): Map<string, BookView> | null {
  const { request, demo, profile } = useAuth();
  const [value, setValue] = useState<Map<string, BookView> | null>(cache?.value ?? null);
  useEffect(() => {
    if (demo || !profile) return;
    let active = true;
    void load(request).then((books) => { if (active) setValue(books); });
    return () => { active = false; };
  }, [request, demo, profile]);
  return demo ? null : value;
}
