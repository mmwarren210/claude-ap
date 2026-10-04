import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth';

/** An AI read (ChatGPT + Claude) on a line GKR can't score. Its own score, never a GKR score. */
export type AiRead = {
  pick: 'MORE' | 'LESS' | 'PASS'; score: number | null; agreement: 'BOTH' | 'ONE' | 'SPLIT' | 'SINGLE'; researchedAt: string;
  providers: { provider: 'chatgpt' | 'claude'; pick: string; confidence: number; summary: string;
    reasons: { text: string; url: string | null }[] }[];
};
/** An AI read that names a side, so the line is a play. */
export const aiPlay = (read: AiRead | undefined) => !!read && read.pick !== 'PASS' && read.score !== null && read.score >= 55;
export const providerName = (provider: string) => provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
export const agreementText = (read: AiRead) => read.agreement === 'BOTH' ? 'ChatGPT and Claude agree'
  : read.agreement === 'ONE' ? 'One model picked a side, the other passed' : read.agreement === 'SPLIT'
    ? 'ChatGPT and Claude disagree' : `${providerName(read.providers[0]?.provider ?? '')} only`;

// One shared copy for every screen, reread at most every 5 minutes.
let cache: { at: number; value: Map<string, AiRead> } | null = null;
let inflight: Promise<Map<string, AiRead>> | null = null;
const listeners = new Set<(value: Map<string, AiRead>) => void>();
const publish = (value: Map<string, AiRead>) => { cache = { at: Date.now(), value }; for (const listener of listeners) listener(value); };

function load(request: (path: string) => Promise<Response>, force = false): Promise<Map<string, AiRead>> {
  if (!force && cache && Date.now() - cache.at < 5 * 60_000) return Promise.resolve(cache.value);
  inflight ??= request('/v1/ai-picks')
    .then(async (response) => response.ok ? await response.json() as { reads?: Record<string, AiRead> } : { reads: {} })
    .then((body) => { const value = new Map(Object.entries(body.reads ?? {})); publish(value); return value; })
    .catch(() => cache?.value ?? new Map<string, AiRead>())
    .finally(() => { inflight = null; });
  return inflight;
}

/** AI reads by line id (null until loaded, and in demo mode), and Ask AI for one line. */
export function useAiPicks(): { reads: Map<string, AiRead> | null;
  ask: (lineId: string) => Promise<{ read?: AiRead; error?: string }> } {
  const { request, demo, profile } = useAuth();
  const [reads, setReads] = useState<Map<string, AiRead> | null>(cache?.value ?? null);
  useEffect(() => {
    if (demo || !profile) return;
    let active = true;
    const listener = (value: Map<string, AiRead>) => { if (active) setReads(value); };
    listeners.add(listener);
    void load(request).then(listener);
    return () => { active = false; listeners.delete(listener); };
  }, [request, demo, profile]);
  const ask = useCallback(async (lineId: string) => {
    try {
      const response = await request(`/v1/ai-picks/${encodeURIComponent(lineId)}`, { method: 'POST' });
      const body = await response.json().catch(() => ({})) as { read?: AiRead; code?: string };
      if (!response.ok || !body.read) return { error: body.code ?? 'AI_UNAVAILABLE' };
      publish(new Map([...(cache?.value ?? []), [lineId, body.read]]));
      return { read: body.read };
    } catch { return { error: 'OFFLINE' }; }
  }, [request]);
  return { reads: demo ? null : reads, ask };
}
