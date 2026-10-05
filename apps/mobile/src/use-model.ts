import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import type { BetaRead } from './beta';

// GKR Beta's reads for lifetime members (owner and family), shown beside GKR's score wherever the two differ.

let cache: { at: number; builtAt: string | null; value: Map<string, BetaRead> } | null = null;
let inflight: Promise<Map<string, BetaRead>> | null = null;

/** Beta's read per line for lifetime members (null for everyone else). Reloads with the board, or every 5 minutes. */
export function useBeta(builtAt?: string | null): { canSeeBeta: boolean; beta: Map<string, BetaRead> | null } {
  const { profile, request, demo } = useAuth();
  const canSeeBeta = !demo && profile?.plan === 'LIFETIME';
  const [beta, setBeta] = useState<Map<string, BetaRead> | null>(cache?.value ?? null);
  useEffect(() => {
    if (!canSeeBeta) return;
    let active = true;
    const fresh = cache && cache.builtAt === (builtAt ?? cache.builtAt) && Date.now() - cache.at < 5 * 60_000;
    const load = fresh ? Promise.resolve(cache!.value) : inflight ??= request('/v1/beta')
      .then(async (response) => response.ok ? await response.json() as { builtAt: string; lines: Record<string, BetaRead> } : null)
      .then((body) => {
        const value = new Map(Object.entries(body?.lines ?? {}));
        cache = { at: Date.now(), builtAt: body?.builtAt ?? null, value };
        return value;
      })
      .catch(() => cache?.value ?? new Map<string, BetaRead>())
      .finally(() => { inflight = null; });
    void load.then((value) => { if (active) setBeta(value); });
    return () => { active = false; };
  }, [canSeeBeta, builtAt, request]);
  return { canSeeBeta, beta: canSeeBeta ? beta : null };
}
