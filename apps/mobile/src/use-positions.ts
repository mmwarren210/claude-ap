import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import { positionKey } from './position-key';

// Player positions (owner, 2026-10-17: positions app wide), from the server's nightly ESPN rosters for MLB, NFL, NBA, WNBA
// and NHL. One shared copy for every card, refreshed at most hourly. Display only: no model reads it.
type Positions = Record<string, Record<string, string>>;
let cache: { at: number; value: Positions } | null = null;
let inflight: Promise<Positions> | null = null;

function load(request: (path: string) => Promise<Response>): Promise<Positions> {
  if (cache && Date.now() - cache.at < 3600_000) return Promise.resolve(cache.value);
  inflight ??= request('/v1/positions')
    .then(async (response) => response.ok ? (await response.json() as { positions?: Positions }).positions ?? {} : {})
    .then((value) => { cache = { at: Date.now(), value }; return value; })
    .catch(() => cache?.value ?? {})
    .finally(() => { inflight = null; });
  return inflight;
}

/** The player's position (QB, WR, SP, C…), or null when unknown or still loading. */
export function usePosition(sport: string | null | undefined, name: string): string | null {
  const { request, demo } = useAuth();
  const [positions, setPositions] = useState<Positions | null>(cache?.value ?? null);
  useEffect(() => {
    if (demo || positions) return;
    let active = true;
    void load(request).then((value) => { if (active) setPositions(value); });
    return () => { active = false; };
  }, [request, demo, positions]);
  if (!sport || !positions) return null;
  return positions[sport.toUpperCase()]?.[positionKey(name)] ?? null;
}
