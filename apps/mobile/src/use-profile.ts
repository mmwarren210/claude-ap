import { useEffect, useState } from 'react';
import { useAuth } from './auth';

type Stat = { average: number; games: number };

/** A player's permanent profile (ESPN roster facts) and season summaries from his games. Display only. */
export type PlayerProfileRead = {
  profile: { team: string | null; position: string | null; bats: string | null; throws: string | null; status: string | null; jersey: string | null } | null;
  seasons: { season: string; games: number; stat: Stat | null; statHome: Stat | null; statAway: Stat | null }[];
};

export function usePlayerProfile(sport: string | undefined, name: string | undefined, eventId?: string, market?: string): PlayerProfileRead | null {
  const { request, demo, profile } = useAuth();
  const key = sport && name ? `${sport}|${name}|${eventId ?? ''}|${market ?? ''}` : '';
  const [value, setValue] = useState<{ key: string; read: PlayerProfileRead } | null>(null);
  useEffect(() => {
    if (demo || !profile || !key) return;
    let active = true;
    const query = new URLSearchParams({ sport: sport!, name: name!, ...(eventId ? { eventId } : {}), ...(market ? { market } : {}) });
    void request(`/v1/players/profile?${query.toString()}`)
      .then(async (response) => response.ok ? await response.json() as PlayerProfileRead : null)
      .then((read) => { if (active && read) setValue({ key, read }); }).catch(() => undefined);
    return () => { active = false; };
  }, [request, demo, profile, key, sport, name, eventId, market]);
  return value?.key === key ? value.read : null;
}
