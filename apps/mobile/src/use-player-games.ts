import { playerGameLogSchema } from '@crowniq/contracts';
import type { PlayerGameLog } from '@crowniq/contracts';
import { useEffect, useState } from 'react';
import { useAuth } from './auth';

type Target = { sport: string; playerId: string; market: string };
const cache = new Map<string, PlayerGameLog | null>();
const keyOf = (target: Target) => [target.sport, target.playerId, target.market].join('|');

/** Recent games for one player and market. Null when the server has no history for it. */
export function usePlayerGames(target: Target | null | undefined): { log: PlayerGameLog | null; loading: boolean } {
  const { request } = useAuth();
  const key = target ? keyOf(target) : null;
  const [state, setState] = useState<{ key: string | null; log: PlayerGameLog | null }>(() =>
    ({ key, log: key ? cache.get(key) ?? null : null }));
  useEffect(() => {
    if (!target || !key || cache.has(key)) return;
    let active = true;
    const path = `/v1/players/${encodeURIComponent(target.sport)}/${encodeURIComponent(target.playerId)}/` +
      `${encodeURIComponent(target.market)}/games`;
    void (async () => {
      try {
        const response = await request(path);
        const log = response.ok ? playerGameLogSchema.parse(await response.json()) : null;
        cache.set(key, log);
        if (active) setState({ key, log });
      } catch { if (active) setState({ key, log: null }); }
    })();
    return () => { active = false; };
    // The key captures the target; the object identity may change every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, request]);
  const cached = key ? cache.get(key) : undefined;
  return { log: state.key === key ? state.log ?? cached ?? null : cached ?? null, loading: !!key && cached === undefined };
}
