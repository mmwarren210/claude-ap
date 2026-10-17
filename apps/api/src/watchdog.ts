import { Worker } from 'node:worker_threads';

// Lockup watchdog (owner, 2026-10-17: the server locked up for good four times overnight and stayed down for hours).
// A timer on the server thread can't notice that thread is stuck, so a worker thread watches a counter the server
// thread bumps every second. When the counter hasn't moved for `limitMs`, the worker logs the last memory reading and
// kills the whole process; Railway's restart-on-failure policy then starts a fresh one. CROWNIQ_WATCHDOG=off disables it.

// Runs inside the worker (its own thread and heap): it only reads shared numbers, so it never waits on the stuck thread.
const WORKER = `
const { workerData } = process.getBuiltinModule('node:worker_threads');
const { writeSync } = process.getBuiltinModule('node:fs');
const beats = new Int32Array(workerData.shared);
let seen = Atomics.load(beats, 0), movedAt = Date.now();
setInterval(() => {
  const now = Date.now(), count = Atomics.load(beats, 0);
  if (count !== seen) { seen = count; movedAt = now; return; }
  if (now - movedAt < workerData.limitMs) return;
  try {
    writeSync(2, '[watchdog] server thread stuck ' + Math.round((now - movedAt) / 1000) + 's (last reading: heap ' +
      Atomics.load(beats, 1) + ' MB, rss ' + Atomics.load(beats, 2) + ' MB); killing the process so it restarts\\n');
  } catch {}
  process.kill(process.pid, 'SIGKILL');
}, workerData.checkMs);
`;

export function startWatchdog(limitMs = 60_000, beatMs = 1000): () => Promise<void> {
  if (!(limitMs > beatMs && beatMs > 0)) throw new Error('WATCHDOG_LIMIT_TOO_SHORT');
  // Slot 0: the heartbeat count; 1 and 2: heap and rss in MB at the last beat, for the kill message.
  const beats = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  const beat = () => {
    const memory = process.memoryUsage();
    Atomics.store(beats, 1, Math.round(memory.heapUsed / 1_048_576));
    Atomics.store(beats, 2, Math.round(memory.rss / 1_048_576));
    Atomics.add(beats, 0, 1);
  };
  beat();
  // No environment variables are handed to the worker: it needs none, so keys never reach it.
  const worker = new Worker(WORKER, { eval: true, env: {}, workerData: { shared: beats.buffer, limitMs, checkMs: Math.min(1000, beatMs) },
    resourceLimits: { maxOldGenerationSizeMb: 16 } });
  let stopping = false;
  // A watchdog that died silently would leave the next lockup unnoticed: restart instead.
  const lost = (why?: unknown) => {
    if (stopping) return;
    console.error(`[watchdog] watcher thread ended (${why instanceof Error ? why.message : String(why)}); exiting so the server restarts`);
    process.exit(1);
  };
  worker.once('error', lost);
  worker.once('exit', lost);
  worker.unref();
  const timer = setInterval(beat, beatMs);
  timer.unref();
  console.warn(`[watchdog] on: the process restarts if the server thread is stuck for ${Math.round(limitMs / 1000)}s`);
  return async () => { stopping = true; clearInterval(timer); await worker.terminate(); };
}
