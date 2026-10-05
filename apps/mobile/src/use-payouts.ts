import { DEFAULT_PAYOUTS, mergePayouts } from '@crowniq/contracts';
import type { Payouts } from '@crowniq/contracts';
import { useEffect, useState } from 'react';
import { useAuth } from './auth';

// The server's payout tables (it can replace the defaults without a release); the defaults until they load.
let cache: Payouts | null = null;
let inflight: Promise<Payouts> | null = null;

function load(request: (path: string) => Promise<Response>): Promise<Payouts> {
  if (cache) return Promise.resolve(cache);
  inflight ??= request('/v1/payouts')
    .then(async (response) => response.ok ? (await response.json() as { payouts?: unknown }).payouts : undefined)
    .then((value) => (cache = mergePayouts(value)))
    .catch(() => DEFAULT_PAYOUTS)
    .finally(() => { inflight = null; });
  return inflight;
}

/** Each app's payout tables. */
export function usePayouts(): Payouts {
  const { request, demo, profile } = useAuth();
  const [value, setValue] = useState<Payouts>(cache ?? DEFAULT_PAYOUTS);
  useEffect(() => {
    if (demo || !profile) return;
    let active = true;
    void load(request).then((payouts) => { if (active) setValue(payouts); });
    return () => { active = false; };
  }, [request, demo, profile]);
  return value;
}
