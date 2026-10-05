import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import { recordText } from './hit-rates';
import type { HitRates } from './hit-rates';

// CrownIQ's own track record by source, sport and stat (/v1/hit-rates). One shared copy, refreshed every 30 minutes.
let cache: { at: number; value: HitRates } | null = null;
let inflight: Promise<HitRates> | null = null;

function load(request: (path: string) => Promise<Response>) {
  if (cache && Date.now() - cache.at < 30 * 60_000) return Promise.resolve(cache.value);
  inflight ??= request('/v1/hit-rates')
    .then(async (response) => response.ok ? (await response.json() as { sources?: HitRates }).sources ?? {} : {})
    .then((value) => { cache = { at: Date.now(), value }; return value; })
    .catch(() => cache?.value ?? {})
    .finally(() => { inflight = null; });
  return inflight;
}

/** "History in NFL receptions: 58% of 24 graded", or null when there aren't enough graded picks yet. */
export function useRecordText(source: string | null, sport: string, market: string): string | null {
  const { request, demo, profile } = useAuth();
  const [rates, setRates] = useState<HitRates | null>(cache?.value ?? null);
  useEffect(() => {
    if (demo || !profile || !source) return;
    let active = true;
    void load(request).then((value) => { if (active) setRates(value); });
    return () => { active = false; };
  }, [request, demo, profile, source]);
  return rates && source ? recordText(rates, source, sport, market) : null;
}
