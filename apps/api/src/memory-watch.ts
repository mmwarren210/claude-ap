// Memory watch: the container is killed without a trace when memory passes its cap, so past 3 GB this logs the
// process's memory every few seconds with the requests in flight (host and path) to show which job is growing.
const inFlight = new Map<number, { what: string; since: number }>();
let nextId = 0;

/** Wraps the global fetch so the memory log can name the requests in flight. */
export function startMemoryWatch(thresholdMb = 3072, everyMs = 1000): NodeJS.Timeout {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const id = nextId++;
    let what = 'request';
    try { const url = new URL(input instanceof Request ? input.url : String(input)); what = url.host + url.pathname; } catch { /* keep the default */ }
    inFlight.set(id, { what, since: Date.now() });
    try { return await original(input, init); } finally { inFlight.delete(id); }
  }) as typeof fetch;
  let lastLog = 0;
  const timer = setInterval(() => {
    const memory = process.memoryUsage(), mb = (bytes: number) => Math.round(bytes / 1_048_576);
    if (mb(memory.rss) < thresholdMb || Date.now() - lastLog < 4000) return;
    lastLog = Date.now();
    const requests = [...inFlight.values()].map((item) => `${item.what} ${Math.round((Date.now() - item.since) / 1000)}s`).slice(0, 15);
    console.warn(`[memory] rss ${mb(memory.rss)} MB, heap ${mb(memory.heapUsed)} MB, external ${mb(memory.external)} MB, buffers ${mb(memory.arrayBuffers)} MB | in flight ${JSON.stringify(requests)}`);
  }, everyMs);
  timer.unref();
  return timer;
}
