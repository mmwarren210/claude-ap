import diagnostics from 'node:diagnostics_channel';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { capped } from './context/sharp-props.js';
// Memory watch: the container is killed without a trace when memory passes its cap, so past 3 GB this logs the
// process's memory every few seconds with the requests in flight (host and path) to show which job is growing.
const BIG = 20 * 1_048_576, REFUSE = 200 * 1_048_576;
const fileOps = new Map<string, number>();
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
    try {
      // Every body is read under a 256 MB cap: a runaway response fails its request instead of killing the server.
      // Every request gets a time limit (90 s) unless it set its own: one that never answered (an OpenDota match after 55
      // minutes, 2026-10-08) held the grading run open, so no later run started and finished games went ungraded.
      const limited = init?.signal ? init : { ...init, signal: AbortSignal.timeout(90_000) };
      const response = await capped(await original(input, limited), new URL(input instanceof Request ? input.url : String(input)), 256 * 1_048_576);
      // Large bodies: logged with their address once read (fetch resolves at the headers, before the body arrives).
      for (const method of ['text', 'json', 'arrayBuffer'] as const) {
        const read = response[method].bind(response) as () => Promise<unknown>;
        (response as unknown as Record<string, unknown>)[method] = async () => {
          const length = Number(response.headers.get('content-length'));
          if (length > BIG) console.warn(`[memory] reading ${Math.round(length / 1_048_576)} MB from ${what}`);
          const value = await read();
          const size = typeof value === 'string' ? value.length : value instanceof ArrayBuffer ? value.byteLength : 0;
          if (size > BIG) console.warn(`[memory] read ${Math.round(size / 1_048_576)} MB from ${what}`);
          return value;
        };
      }
      return response;
    } finally { inFlight.delete(id); }
  }) as typeof fetch;
  watchFiles();
  // Requests coming into this server, with their declared body size, for the same log.
  const incoming = new Map<IncomingMessage, { what: string; since: number }>();
  diagnostics.subscribe('http.server.request.start', (message) => {
    const request = (message as { request: IncomingMessage }).request;
    incoming.set(request, { what: `${request.method} ${request.url?.split('?')[0]} ${request.headers['content-length'] ?? '-'}B`, since: Date.now() });
    request.once('close', () => incoming.delete(request));
  });
  let lastLog = 0;
  const timer = setInterval(() => {
    const memory = process.memoryUsage(), mb = (bytes: number) => Math.round(bytes / 1_048_576);
    if (mb(memory.rss) < thresholdMb || Date.now() - lastLog < 4000) return;
    lastLog = Date.now();
    const requests = [...inFlight.values()].map((item) => `${item.what} ${Math.round((Date.now() - item.since) / 1000)}s`).slice(0, 4);
    const served = [...incoming.values()].map((item) => `${item.what} ${Math.round((Date.now() - item.since) / 1000)}s`).slice(0, 10);
    const resources: Record<string, number> = {};
    for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1;
    console.warn(`[memory] rss ${mb(memory.rss)} MB, heap ${mb(memory.heapUsed)} MB, external ${mb(memory.external)} MB, buffers ${mb(memory.arrayBuffers)} MB | in flight ${JSON.stringify(requests)} | serving ${JSON.stringify(served)} | resources ${JSON.stringify(resources)} | file ops ${JSON.stringify([...fileOps].sort((a, b) => b[1] - a[1]).slice(0, 6))}`);
  }, everyMs);
  timer.unref();
  return timer;
}

/** Logs file reads and writes over 20 MB with their path (a store that grew past what it should be). */
function watchFiles() {
  const promises = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  // Every fs.promises call in flight, counted by function and path, for the memory log.
  for (const name of ['stat', 'open', 'access', 'readdir', 'appendFile', 'rename', 'rm', 'mkdir', 'readFile', 'writeFile']) {
    const inner = promises[name]!.bind(fs.promises);
    promises[name] = async (...args: unknown[]) => {
      const key = `${name} ${String(args[0]).replace(/[0-9a-f-]{36}/g, '*')}`;
      fileOps.set(key, (fileOps.get(key) ?? 0) + 1);
      try { return await inner(...args); } finally { fileOps.set(key, fileOps.get(key)! - 1); if (!fileOps.get(key)) fileOps.delete(key); }
    };
  }
  const readFile = promises.readFile!, writeFile = promises.writeFile!;
  promises.readFile = async (...args: unknown[]) => {
    // A file of hundreds of MB read whole (2026-10-07: a 2 GB read crashed the server every minute) is refused and named.
    if (typeof args[0] === 'string' || args[0] instanceof URL) {
      const size = await fs.promises.stat(args[0]).then((info) => info.size).catch(() => 0);
      if (size > REFUSE) {
        console.warn(`[memory] refused reading ${Math.round(size / 1_048_576)} MB ${String(args[0])} from ${new Error().stack?.split('\n').slice(2, 7).map((line) => line.trim()).join(' < ')}`);
        throw Object.assign(new Error(`FILE_TOO_LARGE ${String(args[0])}`), { code: 'EFBIG' });
      }
    }
    const value = await readFile(...args) as string | Buffer;
    if (value.length > BIG) console.warn(`[memory] file read ${Math.round(value.length / 1_048_576)} MB ${String(args[0])}`);
    return value;
  };
  promises.writeFile = async (...args: unknown[]) => {
    const data = args[1] as string | Buffer | undefined;
    if (data && typeof data.length === 'number' && data.length > BIG) console.warn(`[memory] file write ${Math.round(data.length / 1_048_576)} MB ${String(args[0])}`);
    return writeFile(...args);
  };
  // Modules that import readFile/writeFile by name see the wrapped versions too.
  syncBuiltinESMExports();
}
