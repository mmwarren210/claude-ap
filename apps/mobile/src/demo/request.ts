import { demoBoard, demoCrowns, demoGameLog, demoPicks, demoPublicCrowns, demoRankings, demoTopUsers } from './data';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });

/** Demo mode's stand-in for the API: sample reads only, every write asks the user to sign in. */
export async function demoRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return json(403, { code: 'DEMO_READ_ONLY',
    message: 'Demo mode is read-only. Sign in to save picks and Crowns.' });
  const url = new URL(path, 'https://demo.crowniq.invalid');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const route = '/' + parts.join('/');
  if (route === '/v1/board' || route === '/v1/board/lite') return json(200, demoBoard);
  if (route === '/v1/board/summary') return json(200, { researchStatus: 'DEMO', gradingStatus: 'DEMO' });
  if (route === '/v1/rankings') return json(200, demoRankings);
  if (route === '/v1/me/picks') return json(200, { total: demoPicks.length, picks: demoPicks });
  if (route === '/v1/me/crowns') return json(200, { crowns: demoCrowns });
  if (route === '/v1/social/top-users') return json(200, { minimumGraded: 20, users: demoTopUsers });
  if (route === '/v1/social/recent-crowns') return json(200, { crowns: demoPublicCrowns });
  if (route === '/v1/social/following-crowns') return json(200, { crowns: demoPublicCrowns.slice(0, 1) });
  if (parts[0] === 'v1' && parts[1] === 'players' && parts.length === 6 && parts[5] === 'games') {
    const log = demoGameLog(parts[2], parts[3], parts[4]);
    return log ? json(200, log) : json(404, { code: 'NO_HISTORY' });
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
