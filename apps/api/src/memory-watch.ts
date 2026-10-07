import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
// Memory watch: the container is killed without a trace when memory passes its cap, so past 3 GB this logs the
// process's memory every few seconds with the requests in flight (host and path) to show which job is growing.
const BIG = 20 * 1_048_576;
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
      const response = await original(input, init);
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
  let lastLog = 0;
  const timer = setInterval(() => {
    const memory = process.memoryUsage(), mb = (bytes: number) => Math.round(bytes / 1_048_576);
    const early = process.uptime() < 120;
    if ((mb(memory.rss) < thresholdMb && !early) || Date.now() - lastLog < (early ? 2000 : 4000)) return;
    lastLog = Date.now();
    const requests = [...inFlight.values()].map((item) => `${item.what} ${Math.round((Date.now() - item.since) / 1000)}s`).slice(0, 15);
    console.warn(`[memory] rss ${mb(memory.rss)} MB, heap ${mb(memory.heapUsed)} MB, external ${mb(memory.external)} MB, buffers ${mb(memory.arrayBuffers)} MB | in flight ${JSON.stringify(requests)}`);
  }, everyMs);
  timer.unref();
  return timer;
}

/** Logs file reads and writes over 20 MB with their path (a store that grew past what it should be). */
function watchFiles() {
  const promises = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const readFile = promises.readFile!.bind(fs.promises), writeFile = promises.writeFile!.bind(fs.promises);
  promises.readFile = async (...args: unknown[]) => {
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
