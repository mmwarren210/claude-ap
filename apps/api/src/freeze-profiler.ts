import { Session } from 'node:inspector/promises';

// Freeze finder (owner, 2026-10-17: the server kept freezing ~20s every couple of minutes with nothing logged before it).
// A CPU sampler runs in one-minute windows; when a window held a freeze of 10s or more, the top functions by time are logged
// as "[freeze-profile]", by the function itself and by the CrownIQ code that called it, so the job behind it shows by name.

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] };
type Profile = { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[] };

const WINDOW_MS = 60_000, INTERVAL_US = 5_000;
const short = (url: string) => url.replace(/^file:\/\//, '').replace(/^.*\/(apps|packages)\//, '$1/');
const isOurs = (url: string) => /\/(apps|packages)\//.test(url) && !url.includes('node_modules');

/** Sums sample time by function and by the nearest CrownIQ caller; the top entries, in ms. */
export function summarize(profile: Profile, top = 8) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node])), parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const self = new Map<string, number>(), ours = new Map<string, number>();
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  const label = (node: ProfileNode) => `${node.callFrame.functionName || '(anonymous)'} ${short(node.callFrame.url)}:${node.callFrame.lineNumber + 1}`;
  samples.forEach((id, index) => {
    const ms = (deltas[index + 1] ?? deltas[index] ?? INTERVAL_US) / 1000, node = byId.get(id);
    if (!node || node.callFrame.functionName === '(idle)' || node.callFrame.functionName === '(program)') return;
    self.set(label(node), (self.get(label(node)) ?? 0) + ms);
    let at: ProfileNode | undefined = node;
    while (at && !isOurs(at.callFrame.url)) at = byId.get(parent.get(at.id) ?? -1);
    if (at) ours.set(label(at), (ours.get(label(at)) ?? 0) + ms);
  });
  const best = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, ms]) => `${Math.round(ms)}ms ${name}`);
  return { self: best(self), ours: best(ours) };
}

/** Starts the rolling sampler; `freezeMs()` reports the longest freeze seen since the last call. */
export async function startFreezeProfiler(freezeMs: () => number): Promise<void> {
  if (process.env.CROWNIQ_FREEZE_PROFILER === 'off') return;
  const session = new Session(); session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: INTERVAL_US });
  await session.post('Profiler.start');
  const timer = setInterval(() => void (async () => {
    const { profile } = await session.post('Profiler.stop') as { profile: Profile };
    await session.post('Profiler.start');
    const longest = freezeMs();
    if (longest < 10_000) return;
    const { self, ours } = summarize(profile);
    console.warn(`[freeze-profile] longest freeze ${(longest / 1000).toFixed(1)}s | CrownIQ code ${JSON.stringify(ours)} | functions ${JSON.stringify(self)}`);
  })().catch((error: unknown) => console.warn(`[freeze-profile] ${error instanceof Error ? error.message : String(error)}`)), WINDOW_MS);
  timer.unref();
}
