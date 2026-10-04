import { apiBaseUrl } from '../api-base';
import { demoBoard, demoCrowns, demoGameLog, demoPicks, demoPublicCrowns, demoRankings, demoTopUsers } from './data';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });

/**
 * The server's public demo feed (real lines for the next three days), or null when there is no server, no board or no
 * lines, so the demo falls back to its sample data.
 */
async function live(path: string, signal?: AbortSignal | null, base = apiBaseUrl()): Promise<Response | null> {
  if (!base) return null;
  try {
    const response = await fetch(`${base}/v1/demo${path}`, signal ? { signal } : {});
    if (!response.ok) return null;
    const body = await response.json() as { board?: { lines?: unknown[] }; rankings?: unknown[]; games?: unknown[] };
    if (body.board && !body.board.lines?.length) return null;
    return json(200, body);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** Demo mode's stand-in for the API: real lines when the server has them, sample data otherwise; writes ask to sign in. */
export async function demoRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return json(403, { code: 'DEMO_READ_ONLY',
    message: 'Demo mode is read-only. Sign in to save picks and Crowns.' });
  const url = new URL(path, 'https://demo.crowniq.invalid');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const route = '/' + parts.join('/');
  if (route === '/v1/board' || route === '/v1/board/lite') return await live('/board', init.signal) ?? json(200, demoBoard);
  if (route === '/v1/board/summary') return json(200, { researchStatus: 'DEMO', gradingStatus: 'DEMO' });
  if (route === '/v1/rankings') return await live('/rankings', init.signal) ?? json(200, demoRankings);
  if (route === '/v1/me/picks') return json(200, { total: demoPicks.length, picks: demoPicks });
  if (route === '/v1/me/crowns') return json(200, { crowns: demoCrowns });
  if (route === '/v1/social/top-users') return json(200, { minimumGraded: 20, users: demoTopUsers });
  if (route === '/v1/social/recent-crowns') return json(200, { crowns: demoPublicCrowns });
  if (route === '/v1/social/following-crowns') return json(200, { crowns: demoPublicCrowns.slice(0, 1) });
  if (parts[0] === 'v1' && parts[1] === 'players' && parts.length === 6 && parts[5] === 'games') {
    const log = demoGameLog(parts[2], parts[3], parts[4]);
    if (log) return json(200, log);
    return await live(url.pathname.slice('/v1'.length), init.signal) ?? json(404, { code: 'NO_HISTORY' });
  }
  if (parts[0] === 'v1' && parts[1] === 'history') return json(200, { recent: [], internalOutcomeDistribution: null });
  if (parts[0] === 'v1' && parts[1] === 'social' && parts[2] === 'user' && parts[3]) {
    const user = demoTopUsers.find((item) => item.publicId === parts[3]);
    if (!user) return json(404, { code: 'PROFILE_NOT_FOUND' });
    if (parts[4] === 'crowns') return json(200, { total: 1, crowns: demoPublicCrowns.filter((crown) =>
      crown.ownerPublicId === user.publicId) });
    return json(200, { ...user, avatarUrl: null, following: false });
  }
  if (parts[0] === 'v1' && parts[1] === 'social' && parts[2] === 'crowns' && parts[3]) {
    const crown = demoPublicCrowns.find((item) => item.publicCrownId === parts[3]);
    return crown ? json(200, crown) : json(404, { code: 'CROWN_NOT_FOUND' });
  }
  // Owner tools and anything else do not exist in demo mode.
  return json(404, { code: 'NOT_FOUND' });
}
