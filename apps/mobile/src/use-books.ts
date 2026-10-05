import { useEffect, useState } from 'react';
import { useAuth } from './auth';

/** The sportsbooks' no-vig view of one standard line (from the server's DraftKings and Hard Rock prices). */
export type BookView = { fairMore: number; books: { book: string; fairMore: number }[] };
/** A Books pick: where GKR couldn't score, the side DraftKings and Hard Rock back at 56% or more. Never a GKR score. */
export type BooksPick = { side: 'MORE' | 'LESS'; fair: number; books: number };
type Books = { views: Map<string, BookView>; picks: Map<string, BooksPick> };

// One shared copy for every card, refreshed at most every 10 minutes. Display only; it never changes a GKR score.
let cache: { at: number; value: Books } | null = null;
let inflight: Promise<Books> | null = null;
const empty = (): Books => ({ views: new Map(), picks: new Map() });

function load(request: (path: string) => Promise<Response>): Promise<Books> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return Promise.resolve(cache.value);
  inflight ??= request('/v1/books')
    .then(async (response) => response.ok
      ? await response.json() as { lines?: Record<string, BookView>; picks?: Record<string, BooksPick> } : {})
    .then((body) => {
      cache = { at: Date.now(), value: { views: new Map(Object.entries(body.lines ?? {})),
        picks: new Map(Object.entries(body.picks ?? {})) } };
      return cache.value;
    })
    .catch(() => cache?.value ?? empty())
    .finally(() => { inflight = null; });
  return inflight;
}

function useBooksData(): Books | null {
  const { request, demo, profile } = useAuth();
  const [value, setValue] = useState<Books | null>(cache?.value ?? null);
  useEffect(() => {
    if (demo || !profile) return;
    let active = true;
    void load(request).then((books) => { if (active) setValue(books); });
    return () => { active = false; };
  }, [request, demo, profile]);
  return demo ? null : value;
}

/** Sportsbook views by line id, or null until loaded (and always null in demo mode). */
export function useBooks(): Map<string, BookView> | null {
  return useBooksData()?.views ?? null;
}

/** Books picks by line id, or null until loaded. */
export function useBooksPicks(): Map<string, BooksPick> | null {
  return useBooksData()?.picks ?? null;
}
