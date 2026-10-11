import { useEffect, useState } from 'react';
import { useAuth } from './auth';

/** GKR's real hit rate by cushion (how many spreads the projection clears the line by), from graded picks. Display only. */
export type HitCurve = { graded: number; bands: { from: number; to: number | null; graded: number; hitRate: number }[] };

let cache: { at: number; value: HitCurve | null } | null = null;
let inflight: Promise<HitCurve | null> | null = null;

function load(request: (path: string) => Promise<Response>): Promise<HitCurve | null> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return Promise.resolve(cache.value);
  inflight ??= request('/v1/gkr/hit-curve')
    .then(async (response) => response.ok ? (await response.json() as { curve?: HitCurve | null }).curve ?? null : null)
    .then((value) => { cache = { at: Date.now(), value }; return value; })
    .catch(() => cache?.value ?? null)
    .finally(() => { inflight = null; });
  return inflight;
}

export function useHitCurve(): HitCurve | null {
  const { request, demo, profile } = useAuth();
  const [value, setValue] = useState<HitCurve | null>(cache?.value ?? null);
  useEffect(() => {
    if (demo || !profile) return;
    let active = true;
    void load(request).then((curve) => { if (active) setValue(curve); });
    return () => { active = false; };
  }, [request, demo, profile]);
  return demo ? null : value;
}

/** The graded band a pick's cushion falls in, or null without a curve or cushion. */
export function hitBand(curve: HitCurve | null, cushion: number | null | undefined) {
  if (!curve || cushion === null || cushion === undefined) return null;
  return curve.bands.find((band) => cushion >= band.from && (band.to === null || cushion < band.to)) ?? null;
}

/** GKR 2's read on one line and both models' graded records (owner-only while it's tested; null when hidden). */
export type Gkr2Read = {
  analysis: { direction: 'MORE' | 'LESS' | 'PASS'; score: number | null; scoreBand: string; reasonCode: string | null } | null;
  record: { gkr: Record_; gkr2: Record_ } | null;
};
type Record_ = { picks: number; graded: number; wins: number; hitRate: number | null };

export function useGkr2(lineId: string | null | undefined): Gkr2Read | null {
  const { request, demo, profile } = useAuth();
  const [value, setValue] = useState<{ lineId: string; read: Gkr2Read } | null>(null);
  useEffect(() => {
    if (demo || !profile || !lineId) return;
    let active = true;
    void request(`/v1/gkr2/${encodeURIComponent(lineId)}`)
      .then(async (response) => response.ok ? await response.json() as Gkr2Read : null)
      .then((read) => { if (active && read) setValue({ lineId, read }); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [request, demo, profile, lineId]);
  return value && value.lineId === lineId ? value.read : null;
}
